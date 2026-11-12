/**
 * What `plan` ANSWERS to a pipeline: the exit code and the `--json` lists.
 *
 * Split out of `wac-cli.spec.ts` when two tests from ForgeDeck's ninth report
 * pushed that file to 675 lines, over the 650 ceiling. The seam is real rather
 * than convenient: everything here is the machine-readable contract a CI step
 * gates on, and every defect in it has been reported by somebody whose
 * pipeline stopped on a good file or sailed past a bad one.
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

describe('what a pipeline reads from plan', () => {
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

  /*
   * ForgeDeck's ninth report, 2026-11-06 item 4. A row printed `CANNOT APPLY`
   * with a good reason and `plan --exit-code` answered 2 — the code a GOOD
   * change exits — so a pipeline gating on 3 passed an unapplyable file and
   * failed at `apply` instead. `--help` says `3 = will not apply` and the
   * code's own comment says 3 is "this file will not apply at all".
   *
   * This is the fifth report's item 3 surviving in the one case it missed:
   * that round fixed refusals, which are a prediction about the SERVER, and a
   * blocked row is one this CLI will not send at all.
   */
  it('plan --exit-code answers 3 for a row that cannot be applied', async () => {
    const unresolvable = {
      version: 1,
      resources: { botRoutes: [{ name: 'fd-r', bot: 'no-such-bot' }] },
    };
    expect(
      await run(
        ['plan', '--file', file(unresolvable, 'blocked.json'), '--key', 'ck_t', '--exit-code'],
        factoryFor(reads, []),
      ),
    ).toBe(3);
  });

  /*
   * The keys go in their OWN list, not into `refused`. Two count sites add or
   * subtract the two on the premise that a row is never in both, so merging
   * them — which is what the report asked for — would have mis-stated every
   * total. The exit code is what a pipeline actually gates on, and it answers
   * 3 for either.
   */
  it('plan --json lists a blocked row separately from a refused one', async () => {
    const unresolvable = {
      version: 1,
      resources: { botRoutes: [{ name: 'fd-r', bot: 'no-such-bot' }] },
    };
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    try {
      await run(
        ['plan', '--file', file(unresolvable, 'blocked2.json'), '--key', 'ck_t', '--json'],
        factoryFor(reads, []),
      );
    } finally {
      spy.mockRestore();
    }
    const json = JSON.parse(out.join('')) as { refused: string[]; blocked: string[] };
    expect(json.blocked).toEqual(['fd-r']);
    expect(json.refused).toEqual([]);
  });
});
