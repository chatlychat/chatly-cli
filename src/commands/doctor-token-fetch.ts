/**
 * `chatly doctor --token-url <url> [--cookie <file>]` — mint a token the way
 * the integrator's own page does, then run the identity checks on it.
 *
 * ── Why (CHT-L11.2) ──────────────────────────────────────────────────────
 *
 * `--token <jwt>` checks a token somebody pasted. That proves the token is
 * right; it does not prove the ROUTE that produces it is. A server-minted
 * setup — `visitor={{ tokenUrl }}` on the widget, or Forumulate's
 * `identityEndpoint` — has one more thing that can be wrong than a pasted
 * token has: the route itself, its cookie handling, its response shape. Those
 * are the failures an integrator hits in production and cannot reproduce from
 * a copied JWT.
 *
 * So this fetches through the real path and hands the result to the same
 * checks. One token source more; no new check logic.
 *
 * ── The response contract is the ONE in the widget ───────────────────────
 *
 * `{ "token": "<jwt>" }`, with `{ "token": null }` or a 401 meaning
 * "nobody is signed in". That is exactly what `identity-route.ts` reads, and
 * stating it twice is how two names for one idea appear — which is the
 * complaint this item sits inside.
 *
 * ── Why https is enforced, and it is the point of the whole file ─────────
 *
 * This reads a SESSION COOKIE off disk and puts it in a request. A plaintext
 * URL would hand it to anyone on the path, and a typo'd host would hand it to
 * a stranger. So: https, or a loopback host for local development, and
 * nothing else. Checked on the PARSED hostname rather than the string,
 * because `https://localhost.attacker.com` is not loopback and a
 * `startsWith` test gets that backwards.
 */
import { readFileSync } from 'node:fs';

/** The outcome, deliberately not a thrown error: every arm is a doctor row. */
export type TokenFetchResult =
  | { readonly kind: 'token'; readonly token: string }
  /** The route answered "nobody is signed in", which is a valid answer. */
  | { readonly kind: 'anonymous'; readonly detail: string }
  | { readonly kind: 'error'; readonly detail: string };

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/**
 * Refuse a URL this must not send a cookie to.
 *
 * Returns the reason, or null when it is safe.
 */
export function tokenUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `\`${raw}\` is not an absolute URL. Pass the full URL of your token route, including the host.`;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol === 'https:') {
    return null;
  }
  if (url.protocol === 'http:' && LOOPBACK.has(host)) {
    return null;
  }
  return (
    `\`${raw}\` is not https. This request carries your session cookie, so it is sent over ` +
    'https only — or plain http to a loopback host for local development. ' +
    `\`${host}\` is neither.`
  );
}

/**
 * The `Cookie` header value from a file.
 *
 * Accepts BOTH shapes people actually have, because insisting on one is how a
 * flag gets used wrongly and reports "not signed in":
 *
 *  - a Netscape cookie jar, which is what a browser extension exports and
 *    what `curl --cookie-jar` writes: seven tab-separated fields per line,
 *    `#` comments, and a `#HttpOnly_` prefix on some hosts;
 *  - anything else, treated as a literal `Cookie:` header value, which is
 *    what somebody pastes out of devtools.
 */
export function cookieHeaderFrom(contents: string): string {
  const lines = contents.split('\n');
  const pairs: string[] = [];
  for (const line of lines) {
    const row = line.startsWith('#HttpOnly_') ? line.slice('#HttpOnly_'.length) : line;
    if (row.startsWith('#') || row.trim().length === 0) {
      continue;
    }
    const fields = row.split('\t');
    if (fields.length < 7) {
      continue;
    }
    const name = fields[5]?.trim();
    const value = fields[6]?.trim();
    if (name !== undefined && name.length > 0 && value !== undefined) {
      pairs.push(`${name}=${value}`);
    }
  }
  if (pairs.length > 0) {
    return pairs.join('; ');
  }
  /*
   * Nothing parsed. Fall back to "the file is a literal header value" ONLY if
   * it does not LOOK like a jar — otherwise a jar whose lines we could not
   * read (a comments-only export, a truncated file) comes back as its own
   * text, and `# Netscape HTTP Cookie File` goes out as a Cookie header.
   * Found by the test for a comments-only file.
   */
  const looksLikeJar = contents
    .split('\n')
    .some((l) => l.startsWith('#') || l.split('\t').length >= 7);
  return looksLikeJar ? '' : contents.trim().replace(/^cookie:\s*/i, '');
}

export async function fetchVisitorToken(
  url: string,
  cookieFile: string | undefined,
  deps: { readonly fetch: typeof fetch; readonly readFile?: (p: string) => string } = {
    fetch,
  },
): Promise<TokenFetchResult> {
  const problem = tokenUrlProblem(url);
  if (problem !== null) {
    return { kind: 'error', detail: problem };
  }
  let cookie = '';
  if (cookieFile !== undefined) {
    try {
      cookie = cookieHeaderFrom((deps.readFile ?? ((p) => readFileSync(p, 'utf8')))(cookieFile));
    } catch {
      return { kind: 'error', detail: `Could not read the cookie file \`${cookieFile}\`.` };
    }
    if (cookie.length === 0) {
      return {
        kind: 'error',
        detail:
          `\`${cookieFile}\` yielded no cookies. A Netscape cookie jar needs seven ` +
          'tab-separated fields per line; anything else is read as a literal Cookie header.',
      };
    }
  }
  let response: Response;
  try {
    response = await deps.fetch(url, {
      headers: {
        accept: 'application/json',
        ...(cookie.length === 0 ? {} : { cookie }),
      },
      // `manual`, so a redirect to a sign-in page is reported as what it is
      // rather than followed into an HTML login form that parses as "no token".
      redirect: 'manual',
    });
  } catch (err) {
    return {
      kind: 'error',
      detail: `${url} could not be reached: ${err instanceof Error ? err.message : 'unknown'}.`,
    };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      kind: 'anonymous',
      detail:
        `${url} answered ${String(response.status)}, which your route uses for "nobody is ` +
        'signed in". The widget starts the visitor anonymous and clears any stored identity. ' +
        (cookieFile === undefined
          ? 'Pass --cookie <file> with a signed-in session to check the identified path.'
          : 'If you expected a signed-in session, the cookie may have expired.'),
    };
  }
  if (response.status >= 300 && response.status < 400) {
    return {
      kind: 'error',
      detail:
        `${url} answered ${String(response.status)} and redirected to ` +
        `\`${response.headers.get('location') ?? 'somewhere'}\`. The widget does not follow ` +
        'redirects on this route: answer 401 for a signed-out visitor instead of redirecting ' +
        'to a sign-in page.',
    };
  }
  if (!response.ok) {
    return { kind: 'error', detail: `${url} answered ${String(response.status)}.` };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      kind: 'error',
      detail: `${url} did not answer JSON. The contract is {"token": "<jwt>"} or {"token": null}.`,
    };
  }
  if (body === null || typeof body !== 'object') {
    return { kind: 'error', detail: `${url} answered JSON that is not an object.` };
  }
  const token = (body as Record<string, unknown>)['token'];
  if (token === null) {
    return {
      kind: 'anonymous',
      detail: `${url} answered {"token": null}, which means nobody is signed in.`,
    };
  }
  if (typeof token !== 'string' || token.length === 0) {
    const keys = Object.keys(body as Record<string, unknown>);
    return {
      kind: 'error',
      detail:
        `${url} answered an object with no usable \`token\` (keys: ${keys.join(', ') || 'none'}). ` +
        'The contract is {"token": "<jwt>"} — the same shape the widget reads for ' +
        '`visitor.tokenUrl` and Forumulate reads for `identityEndpoint`.',
    };
  }
  return { kind: 'token', token };
}
