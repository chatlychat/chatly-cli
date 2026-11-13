/**
 * The three FormFlow items that are a COMMAND rather than a plan rule:
 * `plan`'s exit code over a dead knowledge source (CH-05), `whoami --for`
 * (CH-17) and `chatly csp` (CH-13).
 *
 * Driven through `run()` with only the socket faked, so the real argument
 * parser, the real `ChatlyClient`, the real transport and the real error
 * mapping all run. Every assertion is on what the command SENT or what it
 * PRINTED and EXITED — never on the canned reply, which agrees with whatever
 * the client asked for.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatlyClient } from '@chatlychat/sdk-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { run } from '../run.js';

interface Seen {
  readonly method: string;
  readonly path: string;
}

function factoryFor(table: Record<string, unknown>, seen: Seen[]) {
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    seen.push({ method: init?.method ?? 'GET', path });
    const body = table[path];
    return new Response(JSON.stringify(body ?? []), {
      status: body === undefined ? 404 : 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return (opts: { apiKey: string; apiUrl?: string }): ChatlyClient =>
    new ChatlyClient({ ...opts, fetchFn, sleepFn: async () => undefined, retry: { attempts: 1 } });
}

/** A web channel row as `GET /v1/channels` answers one. */
const CHANNEL = {
  id: 'ch_1',
  key: 'web',
  publicId: 'web_live_1',
  type: 'web',
  enabled: true,
  config: { allowedOrigins: ['https://formize.net'] },
  embed: {
    snippet: '<script>…</script>',
    scriptOrigin: 'https://widget.chatlychat.com',
    contentSecurityPolicy: {
      scriptSrc: ["'self'", 'https://widget.chatlychat.com', "'sha256-AAA='", "'sha256-BBB='"],
      connectSrc: ['https://api.chatlychat.com', 'wss://rt.chatlychat.com'],
      imgSrc: ['https://files.chatlychat.com', 'data:'],
      mediaSrc: ['https://files.chatlychat.com'],
    },
    storage: [],
  },
};

describe('the FormFlow CLI items, end to end', () => {
  let out: string[];
  let err: string[];
  let dir: string;

  beforeEach(() => {
    out = [];
    err = [];
    dir = mkdtempSync(join(tmpdir(), 'chatly-ff-'));
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const file = (document: unknown): string => {
    const path = join(dir, 'chatly.json');
    writeFileSync(path, JSON.stringify(document));
    return path;
  };

  const DOC = {
    version: 1,
    resources: { docsSources: [{ label: 'handbook', status: 'active' }] },
  };

  /* ── CH-05: plan exits 3 over a dead source ───────────────────────────── */

  it('plan exits 3 when a source in the document has failed its last sync', async () => {
    const seen: Seen[] = [];
    const code = await run(
      ['plan', '--file', file(DOC), '--key', 'ck_t'],
      factoryFor(
        {
          '/v1/api-keys/whoami': { workspaceId: 'ws_1', scopes: ['*'] },
          '/v1/docs-sources': [
            {
              id: 'ds_1',
              label: 'handbook',
              status: 'active',
              syncStatus: 'failed',
              lastError: 'HTTP 401',
            },
          ],
        },
        seen,
      ),
    );
    expect(code).toBe(3);
    // Without --exit-code: a broken knowledge base must stop a deploy gate
    // that nobody remembered to opt in.
    expect(out.join('')).toContain('syncStatus is `failed`');
    // Still reads only.
    expect(seen.every((s) => s.method === 'GET')).toBe(true);
  });

  it('plan exits 0 on the same document when the source is healthy', async () => {
    const code = await run(
      ['plan', '--file', file(DOC), '--key', 'ck_t'],
      factoryFor(
        {
          '/v1/api-keys/whoami': { workspaceId: 'ws_1', scopes: ['*'] },
          '/v1/docs-sources': [
            { id: 'ds_1', label: 'handbook', status: 'active', syncStatus: 'ok', lastError: null },
          ],
        },
        [],
      ),
    );
    expect(code).toBe(0);
  });

  /*
   * CH-05's other half: the read-back compares the file against the live row,
   * they agree, every write succeeded — and "everything matches the document"
   * then reads as an all-clear over a source that has not synced in a week.
   */
  it('apply does not print "everything matches" over a failing source', async () => {
    const code = await run(
      ['apply', '--file', file(DOC), '--key', 'ck_t'],
      factoryFor(
        {
          '/v1/api-keys/whoami': { workspaceId: 'ws_1', scopes: ['*'] },
          '/v1/docs-sources': [
            {
              id: 'ds_1',
              label: 'handbook',
              status: 'active',
              syncStatus: 'failed',
              lastError: 'HTTP 401',
            },
          ],
        },
        [],
      ),
    );
    const text = out.join('');
    expect(text).not.toContain('everything matches the document');
    expect(text).toContain('FAILING on the server');
    expect(text).toContain('docsSources/handbook');
    // `apply` still exits 0: it wrote everything the document asked for.
    // `plan` is the command that answers 3 for this.
    expect(code).toBe(0);
  });

  /* ── CH-17: whoami --for ──────────────────────────────────────────────── */

  const whoami = (scopes: string[], extra: Record<string, unknown> = {}): Record<string, unknown> =>
    Object.fromEntries([['/v1/api-keys/whoami', { workspaceId: 'ws_1', scopes, ...extra }]]);

  it('names the EXACT missing scope for apply and exits 1', async () => {
    const seen: Seen[] = [];
    const code = await run(
      ['whoami', '--for', 'apply', '--file', file(DOC), '--key', 'ck_t'],
      factoryFor(whoami(['kb:read', 'workspace:read']), seen),
    );
    expect(code).toBe(1);
    expect(out.join('')).toContain('apply      MISSING kb:write:sources');
    // One read, and it is the credential's own. It must not probe a write.
    expect(seen).toEqual([{ method: 'GET', path: '/v1/api-keys/whoami' }]);
  });

  it('says ok for plan on the same key, because plan only reads', async () => {
    const code = await run(
      ['whoami', '--for', 'plan', '--file', file(DOC), '--key', 'ck_t'],
      factoryFor(whoami(['kb:read', 'workspace:read']), []),
    );
    expect(code).toBe(0);
    expect(out.join('')).toContain('plan       ok');
  });

  /*
   * `kb:write:sources` is IMPLIED BY `kb:write` in
   * `@livechat/shared/permissions`. Reporting it missing for a key holding
   * the parent is a false alarm on a readiness check.
   */
  it('accepts a scope the key holds by implication', async () => {
    const code = await run(
      ['whoami', '--for', 'apply', '--file', file(DOC), '--key', 'ck_t'],
      factoryFor(whoami(['kb:read', 'kb:write', 'workspace:read']), []),
    );
    expect(code).toBe(0);
  });

  it('answers for doctor from the calls doctor makes, not from the document', async () => {
    const code = await run(
      ['whoami', '--for', 'doctor', '--file', file(DOC), '--key', 'ck_t'],
      factoryFor(whoami(['workspace:read', 'channels:read']), []),
    );
    expect(code).toBe(1);
    // Without it the CORS preflight — the check doctor exists for — SKIPs.
    expect(out.join('')).toContain('doctor     MISSING uploads:create');
  });

  it('warns at 60 days, which the server’s own key_expiry check does not', async () => {
    // 45 days and a half: `Math.floor` on an exact 45 lands on 44 the moment
    // a millisecond elapses between building this and reading the clock.
    const soon = new Date(Date.now() + 45.5 * 86_400_000).toISOString();
    await run(
      ['whoami', '--for', 'plan', '--file', file(DOC), '--key', 'ck_t'],
      factoryFor(whoami(['*'], { expiresAt: soon }), []),
    );
    expect(out.join('')).toContain('expires in 45 day(s)');
    expect(out.join('')).toContain('api_keys:write');
  });

  it('does not warn about an expiry further out than 60 days', async () => {
    const later = new Date(Date.now() + 200 * 86_400_000).toISOString();
    await run(
      ['whoami', '--for', 'plan', '--file', file(DOC), '--key', 'ck_t'],
      factoryFor(whoami(['*'], { expiresAt: later }), []),
    );
    expect(out.join('')).not.toContain('expires in');
  });

  it('refuses a --for nobody answers for, rather than guessing', async () => {
    expect(
      await run(['whoami', '--for', 'deploy', '--key', 'ck_t'], factoryFor(whoami(['*']), [])),
    ).toBe(2);
    expect(err.join('')).toContain('--for takes one of');
  });

  /* ── CH-13: chatly csp ────────────────────────────────────────────────── */

  const channels = { '/v1/channels': [CHANNEL] };

  it('emits the snippet hashes by default, because dropping one blocks the snippet', async () => {
    const code = await run(['csp', '--format', 'json', '--key', 'ck_t'], factoryFor(channels, []));
    expect(code).toBe(0);
    expect(JSON.parse(out.join('')) as Record<string, string[]>).toEqual({
      'script-src': ["'self'", 'https://widget.chatlychat.com', "'sha256-AAA='", "'sha256-BBB='"],
      'connect-src': ['https://api.chatlychat.com', 'wss://rt.chatlychat.com'],
      'img-src': ['https://files.chatlychat.com', 'data:'],
      'media-src': ['https://files.chatlychat.com'],
    });
  });

  /*
   * The defect itself: a widget-react install runs no inline script, so those
   * hashes match nothing, and an integrator seeing them reaches for
   * 'unsafe-inline'.
   */
  it('--install react drops the sha256 hashes and keeps every host', async () => {
    await run(
      ['csp', '--format', 'json', '--install', 'react', '--key', 'ck_t'],
      factoryFor(channels, []),
    );
    const got = JSON.parse(out.join('')) as Record<string, string[]>;
    expect(got['script-src']).toEqual(["'self'", 'https://widget.chatlychat.com']);
    expect(got['connect-src']).toEqual(['https://api.chatlychat.com', 'wss://rt.chatlychat.com']);
    // `data:` is not a hash and must survive.
    expect(got['img-src']).toContain('data:');
  });

  it('--format header emits directives to merge, never a whole header', async () => {
    await run(['csp', '--format', 'header', '--key', 'ck_t'], factoryFor(channels, []));
    const line = out.join('').trim();
    expect(line.startsWith('script-src ')).toBe(true);
    expect(line).toContain('; connect-src https://api.chatlychat.com');
    // Two Content-Security-Policy headers INTERSECT; emitting one would be a
    // suggestion to send a second.
    expect(line).not.toContain('Content-Security-Policy');
  });

  it('--format next emits an importable module a build step can write', async () => {
    const code = await run(['csp', '--key', 'ck_t'], factoryFor(channels, []));
    expect(code).toBe(0);
    const text = out.join('');
    expect(text).toContain('export const chatlyCsp');
    expect(text).toContain('export function withChatly');
    expect(text).toContain("'script-src': [\"'self'\"");
    /*
     * FormFlow's 2026-11-13 recheck: "`chatly init next` writes
     * `chatly.csp.mjs` once, with no refresh command". The file itself said
     * "Re-run `chatly init`", and init never overwrites what it wrote — so
     * the generated comment pointed at the dead end the report describes.
     */
    expect(text).toContain('chatly csp --format next > chatly.csp.mjs');
    expect(text).not.toContain('Re-run `chatly init`');
  });

  it('tells a react install it needs no nonce, rather than telling it to find one', async () => {
    await run(['csp', '--install', 'react', '--key', 'ck_t'], factoryFor(channels, []));
    expect(out.join('')).toContain("you do not need\n * 'unsafe-inline'");
  });

  it('refuses an unknown --format instead of silently defaulting', async () => {
    expect(await run(['csp', '--format', 'yaml', '--key', 'ck_t'], factoryFor(channels, []))).toBe(
      2,
    );
    expect(err.join('')).toContain('Unknown --format');
  });
});
