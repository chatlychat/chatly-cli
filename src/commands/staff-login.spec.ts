import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseArgs } from '../args.js';
import { readConfig } from '../config.js';
import { normaliseIssuer, resolveStaffToken, staffLogin, staffLogout } from './staff-login.js';

/**
 * A real HTTP issuer on loopback speaking RFC 8628: the real `fetch`, real form
 * encoding, real status codes. Only the clock and the sleep are injected.
 */
interface Issuer {
  readonly url: string;
  readonly requests: Array<{ path: string; form: URLSearchParams }>;
  readonly close: () => Promise<void>;
}

function jwtWith(claims: Record<string, unknown>): string {
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64(claims)}.sig`;
}

async function startIssuer(
  tokenAnswers: Array<{ status: number; body: unknown }>,
): Promise<Issuer> {
  const requests: Issuer['requests'] = [];
  let polled = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      requests.push({ path: req.url ?? '', form });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/oauth2/device_authorization') {
        res.end(
          JSON.stringify({
            device_code: 'dev-123',
            user_code: 'WDJB-MJHT',
            verification_uri: 'https://staff.example/device',
            verification_uri_complete: 'https://staff.example/device?user_code=WDJB-MJHT',
            expires_in: 600,
            interval: 5,
          }),
        );
        return;
      }
      const answer = tokenAnswers[Math.min(polled, tokenAnswers.length - 1)];
      polled += 1;
      res.statusCode = answer?.status ?? 500;
      res.end(JSON.stringify(answer?.body ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

let dir: string;
let configPath: string;
let issuer: Issuer | null = null;
const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chatly-staff-'));
  configPath = join(dir, 'config.json');
  out.mockClear();
  err.mockClear();
});
afterEach(async () => {
  await issuer?.close();
  issuer = null;
  rmSync(dir, { recursive: true, force: true });
});

const sleeps: number[] = [];
const deps = (i: Issuer, clock = { t: 1_000_000 }) => ({
  configPath,
  env: {},
  sleep: (ms: number) => {
    sleeps.push(ms);
    clock.t += ms;
    return Promise.resolve();
  },
  now: () => clock.t,
  ...(i ? {} : {}),
});
const argsFor = (i: Issuer, extra: string[] = []) =>
  parseArgs(['login', '--staff', '--issuer', i.url, '--client-id', 'chatly-cli', ...extra]);

describe('chatly login --staff (RFC 8628)', () => {
  it('starts a device authorization, polls, and stores the token 0600', async () => {
    const exp = Math.floor(Date.now() / 1000) + 900;
    issuer = await startIssuer([
      { status: 400, body: { error: 'authorization_pending' } },
      {
        status: 200,
        body: { access_token: jwtWith({ exp, auth_time: exp - 10 }), token_type: 'Bearer' },
      },
    ]);
    sleeps.length = 0;
    await expect(
      staffLogin(argsFor(issuer, ['--audience', 'chatly-staff']), deps(issuer)),
    ).resolves.toBe(0);

    const [start, first, second] = issuer.requests;
    expect(start?.path).toBe('/oauth2/device_authorization');
    expect(start?.form.get('client_id')).toBe('chatly-cli');
    expect(start?.form.get('audience')).toBe('chatly-staff');
    expect(start?.form.get('max_age')).toBe('0');
    for (const poll of [first, second]) {
      expect(poll?.path).toBe('/oauth2/token');
      expect(poll?.form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
      expect(poll?.form.get('device_code')).toBe('dev-123');
    }
    expect(sleeps).toEqual([5000, 5000]);
    expect(out.mock.calls.flat().join('')).toContain('WDJB-MJHT');

    const saved = readConfig(configPath).staff;
    expect(saved?.issuer).toBe(issuer.url);
    expect(saved?.expiresAt).toBe(exp * 1000);
    // Windows does not carry POSIX modes, so the chmod is a no-op there and
    // this is the only line of the test that is platform-dependent — guarded
    // rather than skipping the whole case. `cli.spec.ts:83` is the same call,
    // in the same words: "that is the platform, not the code."
    if (process.platform !== 'win32') {
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
    }
  });

  it('slow_down adds five seconds to every later poll', async () => {
    const exp = Math.floor(Date.now() / 1000) + 900;
    issuer = await startIssuer([
      { status: 400, body: { error: 'slow_down' } },
      { status: 200, body: { access_token: jwtWith({ exp }) } },
    ]);
    sleeps.length = 0;
    await staffLogin(argsFor(issuer), deps(issuer));
    expect(sleeps).toEqual([5000, 10_000]);
  });

  it('stores nothing when the person denies the request (control: approval stores it)', async () => {
    issuer = await startIssuer([{ status: 400, body: { error: 'access_denied' } }]);
    await expect(staffLogin(argsFor(issuer), deps(issuer))).resolves.toBe(1);
    expect(readConfig(configPath).staff).toBeUndefined();
  });

  it('gives up when the device code expires', async () => {
    issuer = await startIssuer([{ status: 400, body: { error: 'expired_token' } }]);
    await expect(staffLogin(argsFor(issuer), deps(issuer))).resolves.toBe(1);
    expect(readConfig(configPath).staff).toBeUndefined();
  });

  it('gives up when the local deadline passes with the server still pending', async () => {
    issuer = await startIssuer([{ status: 400, body: { error: 'authorization_pending' } }]);
    const clock = { t: 0 };
    await expect(staffLogin(argsFor(issuer), deps(issuer, clock))).resolves.toBe(1);
    // expires_in is 600 s and each poll advances 5 s: bounded, not infinite.
    expect(issuer.requests.length).toBeLessThanOrEqual(122);
  });

  it('asks for the issuer and client id rather than guessing a Chatly host', async () => {
    await expect(
      staffLogin(parseArgs(['login', '--staff']), { configPath, env: {} }),
    ).resolves.toBe(2);
    expect(err.mock.calls.flat().join('')).toContain('CHATLY_STAFF_ISSUER');
  });

  it('reads issuer and client id from the environment', async () => {
    const exp = Math.floor(Date.now() / 1000) + 900;
    issuer = await startIssuer([{ status: 200, body: { access_token: jwtWith({ exp }) } }]);
    const d = deps(issuer);
    await expect(
      staffLogin(parseArgs(['login', '--staff']), {
        ...d,
        env: { CHATLY_STAFF_ISSUER: issuer.url, CHATLY_STAFF_CLIENT_ID: 'from-env' },
      }),
    ).resolves.toBe(0);
    expect(issuer.requests[0]?.form.get('client_id')).toBe('from-env');
  });
});

describe('normaliseIssuer', () => {
  it('requires https except on loopback', () => {
    expect(normaliseIssuer('https://staff.example/')).toBe('https://staff.example');
    expect(normaliseIssuer('http://127.0.0.1:9000')).toBe('http://127.0.0.1:9000');
    expect(() => normaliseIssuer('http://staff.example')).toThrow(/https/);
    expect(() => normaliseIssuer('not a url')).toThrow(/not a URL/);
  });
});

describe('the stored staff sign-in', () => {
  it('is returned while valid, refused when absent or expired, and removed by logout', async () => {
    issuer = await startIssuer([
      {
        status: 200,
        body: { access_token: jwtWith({ exp: Math.floor(Date.now() / 1000) + 900 }) },
      },
    ]);
    expect(() => resolveStaffToken(configPath)).toThrow(/Not signed in/);
    await staffLogin(argsFor(issuer), deps(issuer));
    expect(resolveStaffToken(configPath)).toContain('.');
    expect(() => resolveStaffToken(configPath, () => Date.now() + 3_600_000)).toThrow(/expired/);
    expect(staffLogout(configPath)).toBe(0);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).staff).toBeUndefined();
    expect(() => resolveStaffToken(configPath)).toThrow(/Not signed in/);
  });

  it('does not disturb a stored API key', async () => {
    issuer = await startIssuer([
      {
        status: 200,
        body: { access_token: jwtWith({ exp: Math.floor(Date.now() / 1000) + 900 }) },
      },
    ]);
    const { writeConfig } = await import('../config.js');
    writeConfig({ apiKey: 'ck_live_keepme' }, configPath);
    await staffLogin(argsFor(issuer), deps(issuer));
    expect(readConfig(configPath).apiKey).toBe('ck_live_keepme');
    staffLogout(configPath);
    expect(readConfig(configPath).apiKey).toBe('ck_live_keepme');
  });
});
