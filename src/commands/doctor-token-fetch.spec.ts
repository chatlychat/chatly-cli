/**
 * CHT-L11.2: `chatly doctor --token-url … --cookie …`.
 *
 * This file reads a SESSION COOKIE off disk and puts it in a request, so the
 * https guard is the part that matters most and is tested first.
 */
import { describe, expect, it } from 'vitest';

import { cookieHeaderFrom, fetchVisitorToken, tokenUrlProblem } from './doctor-token-fetch.js';

const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJjaGF0bHkifQ.sig';

const answering = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): typeof fetch =>
  (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    })) as unknown as typeof fetch;

describe('tokenUrlProblem', () => {
  it('allows https anywhere', () => {
    expect(tokenUrlProblem('https://app.example.com/api/token')).toBeNull();
  });

  it('allows plain http to loopback only', () => {
    expect(tokenUrlProblem('http://localhost:3000/api/token')).toBeNull();
    expect(tokenUrlProblem('http://127.0.0.1:3000/t')).toBeNull();
    expect(tokenUrlProblem('http://app.example.com/t')).toContain('not https');
  });

  it('is not fooled by a loopback-looking host', () => {
    // `https://localhost.attacker.com` is NOT loopback, and a startsWith
    // test gets this backwards. (https here, so it is allowed — the point is
    // the http form is refused.)
    expect(tokenUrlProblem('http://localhost.attacker.com/t')).toContain('not https');
  });

  it('refuses a relative path, naming what to pass', () => {
    expect(tokenUrlProblem('/api/token')).toContain('absolute URL');
  });
});

describe('cookieHeaderFrom', () => {
  it('reads a Netscape cookie jar', () => {
    const jar = [
      '# Netscape HTTP Cookie File',
      'app.example.com\tFALSE\t/\tTRUE\t0\t__session\tabc123',
      '#HttpOnly_app.example.com\tFALSE\t/\tTRUE\t0\tcsrf\txyz',
      '',
    ].join('\n');
    expect(cookieHeaderFrom(jar)).toBe('__session=abc123; csrf=xyz');
  });

  it('falls back to a literal Cookie header, with or without the prefix', () => {
    // What somebody pastes out of devtools. Insisting on a jar is how a flag
    // gets used wrongly and reports "not signed in".
    expect(cookieHeaderFrom('__session=abc123; csrf=xyz\n')).toBe('__session=abc123; csrf=xyz');
    expect(cookieHeaderFrom('Cookie: __session=abc')).toBe('__session=abc');
  });

  it('ignores comments and short lines', () => {
    expect(cookieHeaderFrom('# just a comment\n')).toBe('');
  });
});

describe('fetchVisitorToken', () => {
  const url = 'https://app.example.com/api/chatly/token';

  it('returns the token', async () => {
    const out = await fetchVisitorToken(url, undefined, {
      fetch: answering(200, { token: JWT }),
    });
    expect(out).toEqual({ kind: 'token', token: JWT });
  });

  it('refuses before fetching when the URL is not https', async () => {
    let called = false;
    const out = await fetchVisitorToken('http://app.example.com/t', undefined, {
      fetch: (async () => {
        called = true;
        return new Response('{}');
      }) as unknown as typeof fetch,
    });
    expect(out.kind).toBe('error');
    // The cookie must not leave the machine on the way to finding out.
    expect(called).toBe(false);
  });

  it('sends the cookie when one is given, and nothing when not', async () => {
    const seen: (string | null)[] = [];
    const spy = (async (_u: string, init: RequestInit) => {
      seen.push(new Headers(init.headers).get('cookie'));
      return new Response(JSON.stringify({ token: JWT }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    await fetchVisitorToken(url, '/jar', { fetch: spy, readFile: () => '__session=abc' });
    await fetchVisitorToken(url, undefined, { fetch: spy });
    expect(seen).toEqual(['__session=abc', null]);
  });

  it('calls 401 ANONYMOUS, not an error', async () => {
    // A signed-out visitor is a valid answer and a useful row.
    const out = await fetchVisitorToken(url, undefined, { fetch: answering(401, {}) });
    expect(out.kind).toBe('anonymous');
    expect(out.kind === 'anonymous' && out.detail).toContain('--cookie');
  });

  it('calls {"token": null} anonymous too', async () => {
    const out = await fetchVisitorToken(url, undefined, {
      fetch: answering(200, { token: null }),
    });
    expect(out.kind).toBe('anonymous');
  });

  it('reports a redirect as a redirect rather than following it', async () => {
    // Following it lands in an HTML sign-in form, which parses as "no token"
    // and reads as the route being broken.
    const out = await fetchVisitorToken(url, undefined, {
      fetch: answering(302, '', { location: '/sign-in' }),
    });
    expect(out.kind).toBe('error');
    expect(out.kind === 'error' && out.detail).toContain('/sign-in');
    expect(out.kind === 'error' && out.detail).toContain('answer 401');
  });

  it('names the keys it DID get when `token` is missing', async () => {
    const out = await fetchVisitorToken(url, undefined, {
      fetch: answering(200, { jwt: JWT, userId: 'u1' }),
    });
    expect(out.kind).toBe('error');
    expect(out.kind === 'error' && out.detail).toContain('jwt, userId');
  });

  it('reports non-JSON and an unreadable cookie file', async () => {
    const notJson = await fetchVisitorToken(url, undefined, {
      fetch: (async () =>
        new Response('<html>', { headers: { 'content-type': 'text/html' } })) as never,
    });
    expect(notJson.kind).toBe('error');
    const noFile = await fetchVisitorToken(url, '/nope', {
      fetch: answering(200, { token: JWT }),
      readFile: () => {
        throw new Error('ENOENT');
      },
    });
    expect(noFile.kind === 'error' && noFile.detail).toContain('cookie file');
  });

  it('reports a cookie file that parsed to nothing instead of sending none', async () => {
    const out = await fetchVisitorToken(url, '/jar', {
      fetch: answering(200, { token: JWT }),
      readFile: () => '# only a comment\n',
    });
    expect(out.kind).toBe('error');
    expect(out.kind === 'error' && out.detail).toContain('no cookies');
  });

  it('reports an unreachable host', async () => {
    const out = await fetchVisitorToken(url, undefined, {
      fetch: (async () => {
        throw new Error('ECONNREFUSED');
      }) as never,
    });
    expect(out.kind === 'error' && out.detail).toContain('ECONNREFUSED');
  });
});
