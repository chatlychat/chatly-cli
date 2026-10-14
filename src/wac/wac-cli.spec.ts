/**
 * `chatly plan` and `chatly apply`, end to end, with only the socket faked.
 *
 * Same seam as `cli.spec.ts`: `run()` takes argv and a client factory, so
 * these drive the real argument parser, the real `ChatlyClient`, the real
 * transport, the real retry policy and the real error mapping. A test that
 * stubbed the SDK would prove the CLI calls a mock, which is not the thing
 * worth knowing.
 *
 * ═══ THE CLAIM THIS FILE EXISTS FOR ══════════════════════════════════════
 *
 * `plan` writes nothing. Not one POST, not one PATCH, not one DELETE. The
 * test below records every request the whole command path produced and
 * asserts that every one of them was a GET — AND asserts which GETs they
 * were, because a plan that silently stopped reading would satisfy "no
 * writes" perfectly. CLAUDE.md records what the missing half costs: every
 * one of four mobile SDKs shipped a broken handshake with a green suite,
 * because a fake transport that echoes whatever the SDK asked for agrees
 * with the bug. Assert on the request.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatlyClient } from '@chatlychat/sdk-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { run } from '../run.js';

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

type Handler = (method: string, path: string, body: unknown) => { status: number; body: unknown };

/** A client whose transport answers from `handler` and records everything. */
function factoryFor(handler: Handler, seen: Seen[]) {
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = new URL(String(url)).pathname;
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    seen.push({ method, path, body });
    const answer = handler(method, path, body);
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return (opts: { apiKey: string; apiUrl?: string }): ChatlyClient =>
    new ChatlyClient({ ...opts, fetchFn, sleepFn: async () => undefined, retry: { attempts: 1 } });
}

/** The live workspace these tests read: one brand, one bot, no routes. */
const LIVE: Record<string, unknown> = {
  '/v1/api-keys/whoami': { workspaceId: 'ws_real', scopes: ['*'] },
  '/v1/brands': [{ id: 'b1', slug: 'acme', name: 'Acme', usage: { channels: 1 } }],
  '/v1/bots': {
    items: [{ id: 'bot1', slug: 'support', name: 'Support', model: 'gpt-4o-mini' }],
    nextCursor: null,
  },
  '/v1/bot-routes': [],
  '/v1/customer-cards': [],
};

const reads: Handler = (method, path) => {
  if (method !== 'GET') {
    return { status: 500, body: { code: 'this_should_never_be_called', message: 'write in plan' } };
  }
  return { status: 200, body: LIVE[path] ?? [] };
};

describe('chatly plan / chatly apply', () => {
  let out: string[];
  let err: string[];
  let dir: string;

  beforeEach(() => {
    out = [];
    err = [];
    dir = mkdtempSync(join(tmpdir(), 'chatly-wac-'));
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

  /** Write a document and return its path. */
  function file(document: unknown, name = 'chatly.json'): string {
    const path = join(dir, name);
    writeFileSync(path, typeof document === 'string' ? document : JSON.stringify(document));
    return path;
  }

  const DOC = {
    version: 1,
    resources: {
      brands: [{ slug: 'acme', name: 'Acme' }],
      bots: [{ slug: 'support', name: 'Support', model: 'gpt-4o' }],
      customerCards: [
        { key: 'orders', title: 'Orders', url: 'https://cards.test/orders', ttlSeconds: 120 },
      ],
    },
  };

  /* ══ The claim ══════════════════════════════════════════════════════════ */

  it('plan issues reads and ONLY reads', async () => {
    const seen: Seen[] = [];
    const code = await run(['plan', '--file', file(DOC), '--key', 'ck_t'], factoryFor(reads, seen));

    expect(code).toBe(0);
    /*
     * The claim, stated as the test that would fail if it broke.
     */
    expect(
      seen.filter((s) => s.method !== 'GET'),
      'plan must not write; these requests were not GETs',
    ).toEqual([]);
    /*
     * And the anti-vacuity half. A `plan` that read nothing at all would pass
     * the assertion above unanimously, so the GETs it DID make are pinned:
     * one list per resource type the document mentions, in dependency order.
     */
    expect(seen.map((s) => s.path)).toEqual(['/v1/brands', '/v1/bots', '/v1/customer-cards']);
    expect(out.join('')).toContain('Nothing was written');
  });

  it('plan prints a create, a change and an orphan, each addressed by its key', async () => {
    const seen: Seen[] = [];
    await run(['plan', '--file', file(DOC), '--key', 'ck_t'], factoryFor(reads, seen));
    const text = out.join('');
    expect(text).toContain('+ customerCards/orders   create');
    expect(text).toContain('~ bots/support   change');
    expect(text).toContain('model: "gpt-4o-mini" -> "gpt-4o"');
    expect(text).toContain('= brands/acme   unchanged');
  });

  it('plan --exit-code answers 2 for drift and 0 for none, and still writes nothing', async () => {
    const drift: Seen[] = [];
    expect(
      await run(
        ['plan', '--file', file(DOC), '--key', 'ck_t', '--exit-code'],
        factoryFor(reads, drift),
      ),
    ).toBe(2);
    expect(drift.every((s) => s.method === 'GET')).toBe(true);

    const clean = {
      version: 1,
      resources: { brands: [{ slug: 'acme', name: 'Acme' }] },
    };
    expect(
      await run(
        ['plan', '--file', file(clean, 'clean.json'), '--key', 'ck_t', '--exit-code'],
        factoryFor(reads, []),
      ),
    ).toBe(0);
  });

  /* ══ apply ══════════════════════════════════════════════════════════════ */

  it('apply writes the changes, and the request bodies are what the diff said', async () => {
    const seen: Seen[] = [];
    const handler: Handler = (method, path, body) => {
      if (method === 'GET') {
        return { status: 200, body: LIVE[path] ?? [] };
      }
      if (path === '/v1/customer-cards') {
        // The create answers `{ card, secret }` — the secret BESIDE the card.
        return { status: 201, body: { card: { id: 'c9', key: 'orders' }, secret: 'cc_once' } };
      }
      return { status: 200, body: { id: 'bot1', ...(body as Record<string, unknown>) } };
    };
    const code = await run(
      ['apply', '--file', file(DOC), '--key', 'ck_t'],
      factoryFor(handler, seen),
    );

    expect(code).toBe(0);
    const writes = seen.filter((s) => s.method !== 'GET');
    expect(writes).toEqual([
      { method: 'PATCH', path: '/v1/bots/bot1', body: { model: 'gpt-4o' } },
      {
        method: 'POST',
        path: '/v1/customer-cards',
        body: { key: 'orders', title: 'Orders', url: 'https://cards.test/orders', ttlSeconds: 120 },
      },
    ]);
    const text = out.join('');
    expect(text).toContain('✓ bots/support   changed');
    expect(text).toContain('✓ customerCards/orders   created');
  });

  it('every write carries an Idempotency-Key, because the SDK puts one there', async () => {
    /*
     * Not this CLI's own behaviour — `CONTRACT.md` §4 makes it the SDK's, and
     * the only reason it is asserted here is that `apply` is the one command
     * that issues a dozen writes in a row. A retried `apply` that created a
     * duplicate on every attempt would be the worst possible failure for
     * this feature, so the property is pinned where it is relied on.
     */
    const headers: Array<string | null> = [];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method !== 'GET') {
        headers.push(new Headers(init?.headers).get('idempotency-key'));
      }
      const path = new URL(String(url)).pathname;
      return new Response(JSON.stringify(method === 'GET' ? (LIVE[path] ?? []) : { id: 'x' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    await run(
      ['apply', '--file', file(DOC), '--key', 'ck_t'],
      (opts) =>
        new ChatlyClient({
          ...opts,
          fetchFn,
          sleepFn: async () => undefined,
          retry: { attempts: 1 },
        }),
    );
    expect(headers.length).toBeGreaterThan(0);
    for (const key of headers) {
      expect(key, 'a write went out with no Idempotency-Key').toBeTruthy();
    }
  });

  it('prints a once-only secret and writes it nowhere', async () => {
    const path = file(DOC);
    const before = readFileSync(path, 'utf8');
    const handler: Handler = (method, p) => {
      if (method === 'GET') {
        return { status: 200, body: LIVE[p] ?? [] };
      }
      if (p === '/v1/customer-cards') {
        return {
          status: 201,
          body: { card: { id: 'c9', key: 'orders' }, secret: 'cc_shown_once' },
        };
      }
      return { status: 200, body: { id: 'bot1' } };
    };
    await run(['apply', '--file', path, '--key', 'ck_t'], factoryFor(handler, []));

    const text = out.join('');
    expect(text).toContain('SHOWN ONCE');
    expect(text).toContain('customerCards/orders  secret = cc_shown_once');
    expect(text).toContain('not written to');
    // The document is the one file we know is in git. It must be untouched.
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('continues past a failure, skips what depended on it, and exits 1', async () => {
    const document = {
      version: 1,
      resources: {
        brands: [{ slug: 'acme', name: 'Acme' }],
        bots: [{ slug: 'newbot', name: 'New', systemPrompt: 'x'.repeat(30) }],
        botRoutes: [{ name: 'checkout', bot: 'newbot', priority: 10 }],
        customerCards: [
          { key: 'orders', title: 'Orders', url: 'https://cards.test/orders', ttlSeconds: 120 },
        ],
      },
    };
    const seen: Seen[] = [];
    const handler: Handler = (method, p) => {
      if (method === 'GET') {
        return { status: 200, body: LIVE[p] ?? [] };
      }
      if (p === '/v1/bots') {
        return {
          status: 400,
          body: { code: 'validation_failed', message: 'systemPrompt must be at least 20 chars' },
        };
      }
      if (p === '/v1/customer-cards') {
        return { status: 201, body: { card: { id: 'c9' }, secret: 'cc_x' } };
      }
      return { status: 200, body: { id: 'r1' } };
    };
    const code = await run(
      ['apply', '--file', file(document), '--key', 'ck_t'],
      factoryFor(handler, seen),
    );

    expect(code).toBe(1);
    const text = out.join('');
    // Three buckets, each named, so "which resources changed" is never inferred.
    expect(text).toContain('Failed (1)');
    expect(text).toContain('✗ bots/newbot');
    expect(text).toContain('Skipped (1)');
    expect(text).toContain('· botRoutes/checkout');
    expect(text).toContain('bots/newbot failed above');
    expect(text).toContain('✓ customerCards/orders   created');
    /*
     * And the cascade that must NOT happen: the routing rule was never
     * attempted, so there is no second confusing error about a null botId.
     */
    expect(seen.filter((s) => s.path === '/v1/bot-routes' && s.method === 'POST')).toEqual([]);
  });

  it('resolves a reference to a resource it created in the same run', async () => {
    const document = {
      version: 1,
      resources: {
        bots: [{ slug: 'newbot', name: 'New', systemPrompt: 'x'.repeat(30) }],
        botRoutes: [{ name: 'checkout', bot: 'newbot' }],
      },
    };
    const seen: Seen[] = [];
    const handler: Handler = (method, p) => {
      if (method === 'GET') {
        return { status: 200, body: p === '/v1/bots' ? { items: [], nextCursor: null } : [] };
      }
      if (p === '/v1/bots') {
        return { status: 201, body: { id: 'bot-minted', slug: 'newbot' } };
      }
      return { status: 201, body: { id: 'route-1' } };
    };
    expect(
      await run(['apply', '--file', file(document), '--key', 'ck_t'], factoryFor(handler, seen)),
    ).toBe(0);
    const routeWrite = seen.find((s) => s.path === '/v1/bot-routes' && s.method === 'POST');
    expect(routeWrite?.body).toEqual({ name: 'checkout', botId: 'bot-minted' });
  });

  /* ══ Refusals ═══════════════════════════════════════════════════════════ */

  it('never deletes without --prune, and names the flag that would', async () => {
    const document = { version: 1, resources: { brands: [] } };
    const seen: Seen[] = [];
    await run(['apply', '--file', file(document), '--key', 'ck_t'], factoryFor(reads, seen));
    expect(seen.filter((s) => s.method === 'DELETE')).toEqual([]);
    expect(out.join('')).toContain('`--prune` would delete it');
  });

  it('deletes only what --prune names, and only when it is passed', async () => {
    const document = { version: 1, resources: { brands: [] } };
    const seen: Seen[] = [];
    const handler: Handler = (method, p) =>
      method === 'GET' ? { status: 200, body: LIVE[p] ?? [] } : { status: 200, body: { id: 'b1' } };
    await run(
      ['apply', '--file', file(document), '--key', 'ck_t', '--prune'],
      factoryFor(handler, seen),
    );
    expect(seen.filter((s) => s.method === 'DELETE').map((s) => s.path)).toEqual(['/v1/brands/b1']);
  });

  it('refuses a YAML document with the conversion, rather than half-parsing it', async () => {
    const yaml = 'version: 1\nresources:\n  brands:\n    - slug: acme\n';
    const seen: Seen[] = [];
    await expect(
      run(['plan', '--file', file(yaml, 'chatly.yaml'), '--key', 'ck_t'], factoryFor(reads, seen)),
    ).rejects.toThrow(/looks like YAML/);
    expect(seen, 'nothing should have been read either').toEqual([]);
  });

  it('spots YAML behind a .json name, where JSON.parse would misdirect the reader', async () => {
    const yaml = 'version: 1\nresources: {}\n';
    await expect(
      run(['plan', '--file', file(yaml, 'chatly.json'), '--key', 'ck_t'], factoryFor(reads, [])),
    ).rejects.toThrow(/looks like YAML/);
  });

  it('refuses the whole document before issuing a single request', async () => {
    const seen: Seen[] = [];
    await expect(
      run(
        ['plan', '--file', file({ version: 1, resources: { bot: [] } }), '--key', 'ck_t'],
        factoryFor(reads, seen),
      ),
    ).rejects.toThrow(/unknown resource type "bot"/);
    expect(seen).toEqual([]);
  });

  it('refuses a workspace guard mismatch before reading or writing anything', async () => {
    const document = { ...DOC, workspace: 'ws_staging' };
    const seen: Seen[] = [];
    const code = await run(
      ['apply', '--file', file(document), '--key', 'ck_t'],
      factoryFor(reads, seen),
    );
    expect(code).toBe(1);
    expect(err.join('')).toContain('belongs to ws_real');
    // Only `whoami`. No list, and certainly no write.
    expect(seen.map((s) => s.path)).toEqual(['/v1/api-keys/whoami']);
  });

  it('says where to look when there is no document at all', async () => {
    await expect(
      run(['plan', '--file', join(dir, 'nope.json'), '--key', 'ck_t'], factoryFor(reads, [])),
    ).rejects.toThrow(/Cannot read/);
  });

  it('--json gives a machine the plan', async () => {
    await run(['plan', '--file', file(DOC), '--key', 'ck_t', '--json'], factoryFor(reads, []));
    const parsed = JSON.parse(out.join('')) as { plan: Array<{ action: string }> };
    expect(parsed.plan.map((p) => p.action).sort()).toEqual(['create', 'noop', 'update']);
  });

  it('--json does not print the value of an ${env:…} reference', async () => {
    /*
     * `chatly plan --json | tee plan.json` is a thing somebody does on the
     * first day, and a plan item carried `row.body` — which holds the
     * RESOLVED value of every env reference, including a docs source's
     * provider token. It would have written a live credential into a file
     * that then gets committed.
     */
    process.env['WAC_SPEC_TOKEN'] = 'gb_live_do_not_print';
    try {
      const document = {
        version: 1,
        resources: {
          docsSources: [
            {
              label: 'Docs',
              provider: 'gitbook',
              organizationId: 'o',
              spaceId: 's',
              token: '${env:WAC_SPEC_TOKEN}',
              baseUrl: '${env:WAC_SPEC_TOKEN}',
            },
          ],
        },
      };
      await run(
        ['plan', '--file', file(document, 'env.json'), '--key', 'ck_t', '--json'],
        factoryFor(reads, []),
      );
      expect(out.join('')).not.toContain('gb_live_do_not_print');
      expect(out.join('')).toContain('(from the environment)');
    } finally {
      delete process.env['WAC_SPEC_TOKEN'];
    }
  });

  it('does not print an ${env:…} value in the human diff either', async () => {
    process.env['WAC_SPEC_TOKEN'] = 'gb_live_do_not_print';
    try {
      const document = {
        version: 1,
        resources: {
          docsSources: [
            {
              label: 'Docs',
              provider: 'gitbook',
              organizationId: 'o',
              spaceId: 's',
              token: '${env:WAC_SPEC_TOKEN}',
              baseUrl: '${env:WAC_SPEC_TOKEN}',
            },
          ],
        },
      };
      await run(
        ['plan', '--file', file(document, 'env2.json'), '--key', 'ck_t'],
        factoryFor(reads, []),
      );
      expect(out.join('')).not.toContain('gb_live_do_not_print');
      expect(out.join('')).toContain('(from the environment)');
    } finally {
      delete process.env['WAC_SPEC_TOKEN'];
    }
  });
});
