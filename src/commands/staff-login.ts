import { bool, str, type ParsedArgs } from '../args.js';
import { CONFIG_PATH, readConfig, writeConfig } from '../config.js';

/**
 * `chatly login --staff` -- sign in as a member of Chatly's own staff with the
 * OAuth 2.0 Device Authorization Grant (RFC 8628), against an Atlas STAFF
 * instance. ADR 0082 / CHT-SI08.
 *
 * The flow is the point of using a device grant at all: the terminal never sees
 * a password or a second factor. It shows a short code, the person approves it
 * in a browser where Atlas runs its own sign-in (MFA included), and the CLI
 * ends up with a short-lived access token it can present to the Operator API.
 *
 *   1. POST {issuer}/oauth2/device_authorization   -> device_code, user_code, ...
 *   2. person approves user_code at verification_uri
 *   3. POST {issuer}/oauth2/token (device_code grant), polled at `interval`
 *        authorization_pending -> keep waiting
 *        slow_down             -> interval += 5 s (RFC 8628 section 3.5)
 *        access_denied / expired_token -> stop
 *
 * Nothing about WHICH issuer is baked in: this CLI is published, and the staff
 * instance is not a public thing. The issuer and client id come from
 * `--issuer` / `--client-id` or `CHATLY_STAFF_ISSUER` / `CHATLY_STAFF_CLIENT_ID`.
 *
 * The token is stored 0600 in the same config file as the API key, under
 * `staff`, and is only ever sent when a command is run with `--staff`. A
 * `--staff` command with an expired token refuses locally and says to sign in
 * again, rather than sending a token the server will 401.
 */

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
/** RFC 8628 section 3.2: the default polling interval when the server names none. */
const DEFAULT_INTERVAL_SECONDS = 5;
const SLOW_DOWN_STEP_SECONDS = 5;

export interface StaffLoginDeps {
  readonly fetchImpl?: typeof fetch;
  /** Injected so the polling loop can be tested without waiting. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The issuer must be https, except a loopback host (a local test issuer). */
export function normaliseIssuer(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`"${raw}" is not a URL. Pass the staff instance's issuer, e.g. https://....`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('The staff issuer must be https:// (http:// is accepted for localhost only).');
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}

interface DeviceAuthorization {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete?: string;
  readonly expires_in: number;
  readonly interval?: number;
}

async function postForm(
  fetchImpl: typeof fetch,
  url: string,
  form: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  });
  const parsed: unknown = await res.json().catch(() => ({}));
  return {
    status: res.status,
    body: typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {},
  };
}

function readDeviceAuthorization(body: Record<string, unknown>): DeviceAuthorization {
  const { device_code, user_code, verification_uri, expires_in } = body;
  if (
    typeof device_code !== 'string' ||
    typeof user_code !== 'string' ||
    typeof verification_uri !== 'string' ||
    typeof expires_in !== 'number'
  ) {
    throw new Error('The staff instance answered the device request with an unexpected body.');
  }
  return {
    device_code,
    user_code,
    verification_uri,
    expires_in,
    ...(typeof body['verification_uri_complete'] === 'string'
      ? { verification_uri_complete: body['verification_uri_complete'] }
      : {}),
    ...(typeof body['interval'] === 'number' ? { interval: body['interval'] } : {}),
  };
}

/** `auth_time` / `exp` from an access token's payload, unverified: display only. */
function peekClaims(jwt: string): { authTime: number | null; exp: number | null } {
  try {
    const part = jwt.split('.')[1] ?? '';
    const c = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    return {
      authTime: typeof c['auth_time'] === 'number' ? c['auth_time'] : null,
      exp: typeof c['exp'] === 'number' ? c['exp'] : null,
    };
  } catch {
    return { authTime: null, exp: null };
  }
}

export async function staffLogin(args: ParsedArgs, deps: StaffLoginDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;
  const configPath = deps.configPath ?? CONFIG_PATH;

  const issuerRaw = str(args.flags, 'issuer') ?? env['CHATLY_STAFF_ISSUER'];
  const clientId = str(args.flags, 'client-id') ?? env['CHATLY_STAFF_CLIENT_ID'];
  if (issuerRaw === undefined || clientId === undefined) {
    process.stderr.write(
      'Staff sign-in needs the staff instance: pass --issuer and --client-id, or set\n' +
        'CHATLY_STAFF_ISSUER and CHATLY_STAFF_CLIENT_ID.\n',
    );
    return 2;
  }
  const issuer = normaliseIssuer(issuerRaw);
  const audience = str(args.flags, 'audience') ?? env['CHATLY_STAFF_AUDIENCE'];

  const started = await postForm(fetchImpl, `${issuer}/oauth2/device_authorization`, {
    client_id: clientId,
    scope: str(args.flags, 'scope') ?? 'openid profile email',
    // Ask the staff instance to authenticate the person afresh: the token's
    // `auth_time` is what a destructive route measures its 5-minute step-up
    // against, so a cached session would defeat the point.
    max_age: '0',
    ...(audience === undefined ? {} : { audience }),
  });
  if (started.status !== 200) {
    const why = typeof started.body['error'] === 'string' ? started.body['error'] : 'rejected';
    process.stderr.write(`The staff instance refused the sign-in request (${why}).\n`);
    return 1;
  }
  const device = readDeviceAuthorization(started.body);

  process.stdout.write(
    `Open ${device.verification_uri} and enter the code ${device.user_code}\n` +
      (device.verification_uri_complete === undefined
        ? ''
        : `or go straight to ${device.verification_uri_complete}\n`) +
      'Waiting for approval...\n',
  );

  let intervalSeconds = device.interval ?? DEFAULT_INTERVAL_SECONDS;
  const deadline = now() + device.expires_in * 1000;
  while (now() < deadline) {
    await sleep(intervalSeconds * 1000);
    const polled = await postForm(fetchImpl, `${issuer}/oauth2/token`, {
      grant_type: DEVICE_GRANT,
      device_code: device.device_code,
      client_id: clientId,
    });
    const error = polled.body['error'];
    if (polled.status === 200 && typeof polled.body['access_token'] === 'string') {
      const accessToken = polled.body['access_token'];
      const claims = peekClaims(accessToken);
      const expiresIn =
        typeof polled.body['expires_in'] === 'number' ? polled.body['expires_in'] : null;
      const expiresAt =
        claims.exp !== null
          ? claims.exp * 1000
          : expiresIn !== null
            ? now() + expiresIn * 1000
            : now() + 15 * 60_000;
      writeConfig(
        { ...readConfig(configPath), staff: { issuer, accessToken, expiresAt } },
        configPath,
      );
      process.stdout.write(
        `Signed in. Saved to ${configPath} (0600). Use --staff on a command, e.g.\n` +
          '  chatly api GET /v1/admin/platform-apps --staff\n' +
          (claims.authTime === null
            ? 'This token carries no auth_time, so destructive actions will ask you to sign in again.\n'
            : 'Destructive actions need a sign-in from the last 5 minutes; run this again if one asks.\n'),
      );
      return 0;
    }
    if (error === 'authorization_pending') {
      continue;
    }
    if (error === 'slow_down') {
      intervalSeconds += SLOW_DOWN_STEP_SECONDS;
      continue;
    }
    if (error === 'access_denied') {
      process.stderr.write('Sign-in was denied.\n');
      return 1;
    }
    if (error === 'expired_token') {
      break;
    }
    process.stderr.write(
      `Sign-in failed (${typeof error === 'string' ? error : `HTTP ${String(polled.status)}`}).\n`,
    );
    return 1;
  }
  process.stderr.write(
    'The code expired before it was approved. Run `chatly login --staff` again.\n',
  );
  return 1;
}

/** The stored, unexpired staff token, or a sentence saying why there is none. */
export function resolveStaffToken(
  path: string = CONFIG_PATH,
  now: () => number = Date.now,
): string {
  const staff = readConfig(path).staff;
  if (staff === undefined) {
    throw new Error('Not signed in as staff. Run `chatly login --staff`.');
  }
  if (staff.expiresAt <= now()) {
    throw new Error('Your staff sign-in has expired. Run `chatly login --staff` again.');
  }
  return staff.accessToken;
}

export function staffLogout(path: string = CONFIG_PATH): number {
  const existing = readConfig(path);
  delete existing.staff;
  writeConfig(existing, path);
  process.stdout.write(`Removed the stored staff sign-in from ${path}.\n`);
  return 0;
}

export const isStaff = (args: ParsedArgs): boolean => bool(args.flags, 'staff');
