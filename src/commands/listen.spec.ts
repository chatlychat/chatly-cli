/**
 * `chatly listen`, driven through the real SDK with only the socket faked.
 *
 * ═══ WHAT THESE TESTS ASSERT ON ═══════════════════════════════════════════
 *
 * **The requests this command SENDS**, not a canned response it was handed.
 * A fake transport that answers every path with whatever shape the caller
 * hoped for agrees with the bug — that is how four mobile SDKs shipped a
 * realtime client that could not connect, with green suites. So the
 * assertions here are: which paths were polled, in which order, with which
 * query; what went to `--forward-to`; which headers it carried; and what the
 * signature over that body verifies as.
 *
 * `tail()` takes `maxPolls`, which is the only test-only knob: a loop with no
 * bound has no end for a test to assert.
 */
import { createHmac } from 'node:crypto';

import { ChatlyClient, verifyChatlySignature } from '@chatlychat/sdk-node';
import { describe, expect, it } from 'vitest';

import { parseArgs } from '../args.js';
import { parseListenOptions, tail, type ListenDeps, type ListenOptions } from './listen.js';

const SECRET = 'whsec_local_dev';
const FORWARD = 'http://localhost:4010/hook';

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
}

/**
 * A scripted API, keyed by path.
 *
 * Returns a client over a fetch that answers `/v1/webhooks`,
 * `/v1/webhooks/deliveries` and the per-delivery read, plus the list of calls
 * it received so a test can assert on the query it was sent.
 */
function apiFor(opts: {
  endpoints?: unknown;
  pages?: ReadonlyArray<unknown>;
  details?: Record<string, unknown>;
}): { chatly: ChatlyClient; calls: Call[] } {
  const calls: Call[] = [];
  let pageIndex = 0;
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    calls.push({
      url: href,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : null,
    });
    const path = new URL(href).pathname;
    const json = (value: unknown): Response =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    if (path === '/v1/webhooks') {
      return json(opts.endpoints ?? [{ id: 'ep_1', url: 'https://x.test/h', eventTypes: ['a'] }]);
    }
    if (path === '/v1/webhooks/deliveries') {
      const pages = opts.pages ?? [{ items: [], nextCursor: null }];
      const page = pages[Math.min(pageIndex, pages.length - 1)];
      pageIndex += 1;
      return json(page);
    }
    const id = path.replace('/v1/webhooks/deliveries/', '');
    return json(opts.details?.[id] ?? { payload: {} });
  }) as unknown as typeof fetch;

  return {
    chatly: new ChatlyClient({
      apiKey: 'ck_test',
      apiUrl: 'https://api.test',
      fetchFn,
      sleepFn: async () => undefined,
      retry: { attempts: 1 },
    }),
    calls,
  };
}

interface Harness {
  readonly deps: ListenDeps;
  readonly out: string[];
  readonly err: string[];
  readonly forwards: Call[];
}

const NOW_MS = 1_760_000_000_000;

function harness(
  opts: { maxPolls?: number; forwardStatus?: number; throwOnForward?: boolean } = {},
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const forwards: Call[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    forwards.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : null,
    });
    if (opts.throwOnForward === true) {
      throw new Error('connect ECONNREFUSED 127.0.0.1:4010');
    }
    return new Response('ok', { status: opts.forwardStatus ?? 200 });
  }) as unknown as typeof fetch;

  return {
    out,
    err,
    forwards,
    deps: {
      fetchFn,
      now: () => NOW_MS,
      sleep: async () => undefined,
      signal: new AbortController().signal,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      maxPolls: opts.maxPolls ?? 1,
    },
  };
}

function options(over: Partial<ListenOptions> = {}): ListenOptions {
  return {
    forwardTo: null,
    botId: null,
    endpointId: null,
    events: null,
    status: null,
    secret: null,
    intervalMs: 2000,
    replay: 0,
    pageLimit: 50,
    json: false,
    ...over,
  };
}

function delivery(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'del_1',
    endpointId: 'ep_1',
    eventType: 'conversation.created',
    attempt: 0,
    status: 'delivered',
    httpStatus: 200,
    durationMs: 12,
    error: null,
    nextRetryAt: null,
    deliveredAt: '2026-10-14T00:00:00.000Z',
    createdAt: '2026-10-14T00:00:00.000Z',
    ...over,
  };
}

describe('parseListenOptions', () => {
  const parse = (argv: string[]): ListenOptions => parseListenOptions(parseArgs(argv));

  it('defaults to print-only with a two-second interval', () => {
    const o = parse(['listen']);
    expect(o.forwardTo).toBeNull();
    expect(o.intervalMs).toBe(2000);
    expect(o.replay).toBe(0);
  });

  it('refuses a scheme-less --forward-to with a message about the scheme', () => {
    /*
     * `localhost:3000` is the mistake everyone makes, and `new URL()`
     * SUCCEEDS on it — the WHATWG parser reads `localhost:` as a scheme. So
     * the only useful refusal is one that names the scheme it found and shows
     * the right spelling. Before this test, the message said the scheme
     * `"localhost:"` was unsupported, which is true and useless.
     */
    expect(() => parse(['listen', '--forward-to', 'localhost:3000'])).toThrow(
      /is not an http\(s\) URL/,
    );
    expect(() => parse(['listen', '--forward-to', 'localhost:3000'])).toThrow(
      /--forward-to http:\/\/localhost:3000/,
    );
  });

  it('refuses a non-HTTP scheme', () => {
    expect(() => parse(['listen', '--forward-to', 'ws://localhost:3000'])).toThrow(
      /is not an http\(s\) URL/,
    );
  });

  it('refuses something no parser can read at all', () => {
    expect(() => parse(['listen', '--forward-to', '://'])).toThrow(/is not an http\(s\) URL/);
  });

  it('refuses a secret that is not a whsec_, and says which route hands one out', () => {
    expect(() => parse(['listen', '--secret', 'ck_nope'])).toThrow(/whsec_/);
    expect(() => parse(['listen', '--secret', 'ck_nope'])).toThrow(/chatly webhooks create/);
  });

  it('refuses a sub-second poll interval and says why it buys nothing', () => {
    expect(() => parse(['listen', '--interval', '0.2'])).toThrow(/floor/);
  });

  it('refuses --replay larger than the page it reads', () => {
    expect(() => parse(['listen', '--replay', '80', '--limit', '10'])).toThrow(/Raise --limit/);
  });

  it('splits a repeated or comma-joined --event into a filter set', () => {
    const o = parse(['listen', '--event', 'a.b,c.d', '--event', 'e.f']);
    expect([...(o.events ?? [])].sort()).toEqual(['a.b', 'c.d', 'e.f']);
  });
});

describe('tail — what it polls', () => {
  it('reads the endpoint list, then the delivery log with the limit', async () => {
    const { chatly, calls } = apiFor({ pages: [{ items: [], nextCursor: null }] });
    const h = harness();
    await tail(chatly, options({ pageLimit: 25 }), h.deps);

    const paths = calls.map((c) => new URL(c.url).pathname);
    expect(paths[0]).toBe('/v1/webhooks');
    expect(paths).toContain('/v1/webhooks/deliveries');
    const log = calls.find((c) => new URL(c.url).pathname === '/v1/webhooks/deliveries');
    expect(new URL(log?.url ?? '').searchParams.get('limit')).toBe('25');
  });

  it('passes --endpoint and --status to the server rather than filtering locally', async () => {
    const { chatly, calls } = apiFor({
      endpoints: [{ id: 'ep_9', url: 'https://x.test/h', eventTypes: ['a'] }],
      pages: [{ items: [], nextCursor: null }],
    });
    await tail(chatly, options({ endpointId: 'ep_9', status: 'failed' }), harness().deps);
    const log = calls.find((c) => new URL(c.url).pathname === '/v1/webhooks/deliveries');
    const q = new URL(log?.url ?? '').searchParams;
    expect(q.get('endpointId')).toBe('ep_9');
    expect(q.get('status')).toBe('failed');
  });

  it('refuses when the workspace has no subscriptions, naming the command that fixes it', async () => {
    const { chatly } = apiFor({ endpoints: [] });
    await expect(tail(chatly, options(), harness().deps)).rejects.toThrow(/chatly webhooks create/);
  });

  it('refuses an --endpoint that does not exist, and lists the ones that do', async () => {
    const { chatly } = apiFor({
      endpoints: [{ id: 'ep_1', url: 'https://a.test/h', eventTypes: [] }],
    });
    await expect(
      tail(chatly, options({ endpointId: 'ep_missing' }), harness().deps),
    ).rejects.toThrow(/ep_1/);
  });

  it('says in its banner that it registered nothing', async () => {
    const { chatly } = apiFor({ pages: [{ items: [], nextCursor: null }] });
    const h = harness();
    await tail(chatly, options(), h.deps);
    expect(h.out.join('\n')).toContain('Registers nothing on the server');
  });
});

describe('tail — the baseline, so a first poll is not a flood', () => {
  it('treats everything already in the log as seen', async () => {
    const { chatly, calls } = apiFor({
      pages: [{ items: [delivery(), delivery({ id: 'del_2' })], nextCursor: null }],
      details: { del_1: { payload: { a: 1 } } },
    });
    const h = harness();
    const summary = await tail(chatly, options({ forwardTo: FORWARD, secret: SECRET }), h.deps);
    expect(summary.seen).toBe(0);
    expect(h.forwards).toHaveLength(0);
    // And it never fetched a detail, because it never had a new row.
    expect(calls.some((c) => new URL(c.url).pathname.startsWith('/v1/webhooks/deliveries/'))).toBe(
      false,
    );
  });

  it('forwards only what arrived after the baseline', async () => {
    const { chatly } = apiFor({
      pages: [
        { items: [delivery({ id: 'old' })], nextCursor: null },
        { items: [delivery({ id: 'new' }), delivery({ id: 'old' })], nextCursor: null },
      ],
      details: { new: { payload: { hello: 'world' } } },
    });
    const h = harness({ maxPolls: 2 });
    const summary = await tail(chatly, options({ forwardTo: FORWARD, secret: SECRET }), h.deps);
    expect(summary.seen).toBe(1);
    expect(h.forwards).toHaveLength(1);
    expect(JSON.parse(h.forwards[0]?.body ?? 'null')).toEqual({
      id: 'new',
      type: 'conversation.created',
      payload: { hello: 'world' },
    });
  });

  it('--replay N leaves the newest N unseen so they are forwarded', async () => {
    const { chatly } = apiFor({
      pages: [
        {
          items: [delivery({ id: 'd3' }), delivery({ id: 'd2' }), delivery({ id: 'd1' })],
          nextCursor: null,
        },
      ],
      details: {
        d3: { payload: { n: 3 } },
        d2: { payload: { n: 2 } },
      },
    });
    const h = harness();
    await tail(chatly, options({ forwardTo: FORWARD, secret: SECRET, replay: 2 }), h.deps);
    // Oldest-first within the replay: the log is newest-first off the wire and
    // a handler replaying events out of order is a handler that sees a
    // conversation closed before it was created.
    expect(
      h.forwards.map((f) => JSON.parse(f.body ?? 'null') as { id: string }).map((e) => e.id),
    ).toEqual(['d2', 'd3']);
  });

  it('filters by --event client-side, and says the filter is client-side', async () => {
    const { chatly } = apiFor({
      pages: [
        { items: [], nextCursor: null },
        {
          items: [delivery({ id: 'a', eventType: 'message.created' }), delivery({ id: 'b' })],
          nextCursor: null,
        },
      ],
      details: { a: { payload: {} }, b: { payload: {} } },
    });
    const h = harness({ maxPolls: 2 });
    const summary = await tail(
      chatly,
      options({ forwardTo: FORWARD, secret: SECRET, events: new Set(['message.created']) }),
      h.deps,
    );
    expect(summary.seen).toBe(1);
    expect(h.out.join('\n')).toContain('client-side');
  });

  it('warns when a full page was entirely new, because events may have been missed', async () => {
    const page = {
      items: [delivery({ id: 'x1' }), delivery({ id: 'x2' })],
      nextCursor: null,
    };
    const { chatly } = apiFor({
      pages: [{ items: [], nextCursor: null }, page],
      details: { x1: { payload: {} }, x2: { payload: {} } },
    });
    const h = harness({ maxPolls: 2 });
    await tail(chatly, options({ pageLimit: 2 }), h.deps);
    expect(h.err.join('')).toContain('may have');
  });
});

describe('tail — the forwarded request', () => {
  const oneNew = (): ReturnType<typeof apiFor> =>
    apiFor({
      pages: [
        { items: [], nextCursor: null },
        { items: [delivery({ id: 'del_fwd' })], nextCursor: null },
      ],
      details: { del_fwd: { payload: { conversationId: 'c_1' } } },
    });

  it('POSTs the {id,type,payload} envelope the platform signs', async () => {
    const { chatly } = oneNew();
    const h = harness({ maxPolls: 2 });
    await tail(chatly, options({ forwardTo: FORWARD, secret: SECRET }), h.deps);
    const sent = h.forwards[0];
    expect(sent?.method).toBe('POST');
    expect(sent?.url).toBe(FORWARD);
    expect(JSON.parse(sent?.body ?? 'null')).toEqual({
      id: 'del_fwd',
      type: 'conversation.created',
      payload: { conversationId: 'c_1' },
    });
  });

  it('carries the delivery headers a real webhook carries, plus a forwarded marker', async () => {
    const { chatly } = oneNew();
    const h = harness({ maxPolls: 2 });
    await tail(chatly, options({ forwardTo: FORWARD, secret: SECRET }), h.deps);
    const headers = h.forwards[0]?.headers ?? {};
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-livechat-event']).toBe('conversation.created');
    expect(headers['x-livechat-delivery']).toBe('del_fwd');
    // Not a header Chatly sends. A handler must be able to tell a local
    // forward from a real delivery.
    expect(headers['x-chatly-cli-forwarded']).toBe('1');
  });

  it('signs the forwarded body so the handler under development can verify it', async () => {
    const { chatly } = oneNew();
    const h = harness({ maxPolls: 2 });
    await tail(chatly, options({ forwardTo: FORWARD, secret: SECRET }), h.deps);
    const sent = h.forwards[0];
    const result = verifyChatlySignature({
      surface: 'event_webhook',
      body: sent?.body ?? '',
      headers: { 'x-livechat-signature': sent?.headers['x-livechat-signature'] ?? '' },
      secret: SECRET,
      nowMs: NOW_MS,
    });
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
  });

  it('signs over `<t>.<body>` and not the body alone', async () => {
    /*
     * The construction, asserted independently of the verifier. An earlier
     * Node implementation of this scheme HMAC'd the body alone and rejected
     * 100% of genuine deliveries; the mirror-image mistake here would hand a
     * developer a signature their correct handler refuses.
     */
    const { chatly } = oneNew();
    const h = harness({ maxPolls: 2 });
    await tail(chatly, options({ forwardTo: FORWARD, secret: SECRET }), h.deps);
    const sent = h.forwards[0];
    const header = sent?.headers['x-livechat-signature'] ?? '';
    const t = /t=(\d+)/.exec(header)?.[1] ?? '';
    const v1 = /v1=([0-9a-f]+)/.exec(header)?.[1] ?? '';
    expect(v1).toBe(
      createHmac('sha256', SECRET)
        .update(`${t}.${sent?.body ?? ''}`)
        .digest('hex'),
    );
    expect(v1).not.toBe(
      createHmac('sha256', SECRET)
        .update(sent?.body ?? '')
        .digest('hex'),
    );
    // The separate timestamp header mirrors the real deliverer and must agree
    // with the one inside the signature.
    expect(sent?.headers['x-livechat-timestamp']).toBe(t);
  });

  it('also mints the unified x-chatly-signature-v2, over t.METHOD.path.body', async () => {
    /*
     * C-02. The platform sends `x-chatly-signature-v2` on workflow actions
     * only; minting it here lets a developer write the verifier they will
     * need on this surface before the sender moves. `path` is the LOCAL
     * target's path, because that is the request line the receiver verifies.
     */
    const { chatly } = oneNew();
    const h = harness({ maxPolls: 2 });
    await tail(chatly, options({ forwardTo: FORWARD, secret: SECRET }), h.deps);
    const sent = h.forwards[0];
    const header = sent?.headers['x-chatly-signature-v2'] ?? '';
    /*
     * The `b=t` base marker, which says WHICH string was signed.
     *
     * Without it a receiver reading `b=` is told the unified base is the
     * body base — because an absent marker means `<t>.<rawBody>`, the
     * construction every signature minted before the marker existed used.
     * This command hand-rolled the value until 2026-10-14 and emitted no
     * marker, so the one tool whose job is to rehearse production taught
     * the wrong shape.
     */
    expect(header.endsWith(',b=t')).toBe(true);
    const path = new URL(FORWARD).pathname;

    const result = verifyChatlySignature({
      surface: 'unified_v2',
      body: sent?.body ?? '',
      headers: { 'x-chatly-signature-v2': header },
      secret: SECRET,
      method: 'POST',
      path,
      nowMs: NOW_MS,
    });
    expect(result.ok, result.ok ? '' : result.message).toBe(true);

    const t = /t=(\d+)/.exec(header)?.[1] ?? '';
    expect(/v1=([0-9a-f]+)/.exec(header)?.[1]).toBe(
      createHmac('sha256', SECRET)
        .update(`${t}.POST.${path}.${sent?.body ?? ''}`)
        .digest('hex'),
    );
    // Different base, so it must be a different digest from the legacy one.
    expect(header).not.toBe(sent?.headers['x-livechat-signature']);
  });

  it('does NOT sign when no --secret is given, and warns that verification will fail', async () => {
    const { chatly } = oneNew();
    const h = harness({ maxPolls: 2 });
    await tail(chatly, options({ forwardTo: FORWARD }), h.deps);
    expect(h.forwards[0]?.headers['x-livechat-signature']).toBeUndefined();
    expect(h.forwards[0]?.headers['x-chatly-signature-v2']).toBeUndefined();
    expect(h.out.join('\n')).toContain('UNSIGNED');
  });

  it('is honest in the banner that the signature is minted locally', async () => {
    const { chatly } = oneNew();
    const h = harness({ maxPolls: 2 });
    await tail(chatly, options({ forwardTo: FORWARD, secret: SECRET }), h.deps);
    expect(h.out.join('\n')).toContain('NOT the signature Chatly sent');
  });

  it('counts a non-2xx from the local handler as not forwarded, and hints at the secret on a 401', async () => {
    const { chatly } = oneNew();
    const h = harness({ maxPolls: 2, forwardStatus: 401 });
    const summary = await tail(chatly, options({ forwardTo: FORWARD, secret: SECRET }), h.deps);
    expect(summary.forwarded).toBe(0);
    expect(summary.refused).toBe(1);
    expect(h.err.join('')).toContain('--secret');
  });

  it('names the port when the local server is not running', async () => {
    const { chatly } = oneNew();
    const h = harness({ maxPolls: 2, throwOnForward: true });
    const summary = await tail(chatly, options({ forwardTo: FORWARD, secret: SECRET }), h.deps);
    expect(summary.refused).toBe(1);
    expect(h.err.join('')).toContain('Is your server running on that port?');
    // A dead local handler must not stop the tail.
    expect(summary.polls).toBe(2);
  });

  it('prints the event type and id for every event, forwarding or not', async () => {
    const { chatly } = oneNew();
    const h = harness({ maxPolls: 2 });
    await tail(chatly, options(), h.deps);
    const printed = h.out.join('\n');
    expect(printed).toContain('conversation.created');
    expect(printed).toContain('del_fwd');
  });
});

describe('tail — stopping', () => {
  it('stops on an aborted signal without another poll', async () => {
    const { chatly, calls } = apiFor({ pages: [{ items: [], nextCursor: null }] });
    const controller = new AbortController();
    controller.abort();
    const h = harness({ maxPolls: 50 });
    const summary = await tail(chatly, options(), { ...h.deps, signal: controller.signal });
    expect(summary.polls).toBe(0);
    // The baseline read still happened; nothing after it did.
    expect(calls.filter((c) => new URL(c.url).pathname === '/v1/webhooks/deliveries')).toHaveLength(
      1,
    );
  });
});
