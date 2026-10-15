/**
 * `chatly listen --bot <id>`, driven through the real SDK with only the
 * sockets faked.
 *
 * ═══ WHAT THESE TESTS ASSERT ON ═══════════════════════════════════════════
 *
 * **The request this command SENDS to the developer's own handler** — its
 * method, its URL, its exact body, every header, and what the two signatures
 * over that body verify as. Not a canned response: a fake transport that
 * answers every path with whatever shape the caller hoped for agrees with the
 * bug, which is how four mobile SDKs shipped a realtime client that could not
 * connect with green suites.
 *
 * The signature assertions are deliberately made TWICE, once through
 * `verifyChatlySignature` and once against a hand-written base string. The
 * first proves a customer's verifier will accept it; the second proves the
 * base string is the one documented, because a signer and a verifier written
 * from each other agree on a wrong construction.
 */
import { createHmac } from 'node:crypto';

import { ChatlyClient, verifyChatlySignature } from '@chatlychat/sdk-node';
import { describe, expect, it } from 'vitest';

import { tailBot } from './listen-bot.js';
import { parseListenOptions, type ListenDeps, type ListenOptions } from './listen-core.js';
import { parseArgs } from '../args.js';

const SECRET = 'chsec_local_dev';
const FORWARD = 'http://localhost:4010/agent?tenant=acme';
const BOT = 'b_1';
const NOW_MS = 1_760_000_000_000;
const NOW_SECONDS = 1_760_000_000;

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
}

function botRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: BOT,
    name: 'Orders agent',
    slug: 'orders-agent',
    type: 'external',
    externalAgent: {
      webhookUrl: 'https://agent.example.test/chatly',
      timeoutSeconds: 15,
      signingSecretSet: true,
      canStartConversations: false,
    },
    ...over,
  };
}

function deliveryRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ad_1',
    botId: BOT,
    conversationId: 'c_1',
    messageId: 'm_1',
    kind: 'message',
    status: 'delivered',
    attempt: 1,
    httpStatus: 200,
    durationMs: 31,
    error: null,
    nextRetryAt: null,
    deliveredAt: '2026-10-14T00:00:00.000Z',
    createdAt: '2026-10-14T00:00:00.000Z',
    ...over,
  };
}

/** A scripted API over the three routes this command reads. */
function apiFor(opts: {
  bot?: unknown;
  pages?: ReadonlyArray<unknown>;
  details?: Record<string, unknown>;
}): { chatly: ChatlyClient; calls: Call[] } {
  const calls: Call[] = [];
  let pageIndex = 0;
  const base = `/v1/bots/${BOT}/deliveries`;
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

    if (path.startsWith(`${base}/`)) {
      const id = path.slice(base.length + 1);
      return json(opts.details?.[id] ?? { ...deliveryRow({ id }), payload: {} });
    }
    if (path === base) {
      const pages = opts.pages ?? [{ items: [], nextCursor: null, hasMore: false }];
      const page = pages[Math.min(pageIndex, pages.length - 1)];
      pageIndex += 1;
      return json(page);
    }
    return json(opts.bot ?? botRow());
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
    botId: BOT,
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

describe('parseListenOptions — the --bot flags', () => {
  const parse = (argv: string[]): ListenOptions => parseListenOptions(parseArgs(argv));

  it('reads --bot', () => {
    expect(parse(['listen', '--bot', BOT]).botId).toBe(BOT);
  });

  it('refuses --bot together with --endpoint, because they are different ledgers', () => {
    expect(() => parse(['listen', '--bot', BOT, '--endpoint', 'ep_1'])).toThrow(
      /different ledgers/,
    );
  });

  it('refuses a whsec_ secret in bot mode, naming the chsec_ one', () => {
    expect(() => parse(['listen', '--bot', BOT, '--secret', 'whsec_x'])).toThrow(/chsec_/);
    expect(() => parse(['listen', '--bot', BOT, '--secret', 'whsec_x'])).toThrow(
      /chatly bots rotate-secret/,
    );
  });

  it('refuses a chsec_ secret in webhook mode, naming the whsec_ one', () => {
    // The mirror image, and the one that would otherwise reach a handler as
    // an unexplained 401.
    expect(() => parse(['listen', '--secret', 'chsec_x'])).toThrow(/whsec_/);
  });

  it('accepts a chsec_ secret with --bot', () => {
    expect(parse(['listen', '--bot', BOT, '--secret', SECRET]).secret).toBe(SECRET);
  });

  it('refuses a --status outside the four, because the route answers 400 not an empty page', () => {
    expect(() => parse(['listen', '--bot', BOT, '--status', 'retrying'])).toThrow(
      /pending, delivered, failed, dead/,
    );
  });
});

describe('tailBot — what it polls, and what it refuses', () => {
  it('reads the bot, then its ledger with the page limit', async () => {
    const { chatly, calls } = apiFor({});
    await tailBot(chatly, options({ pageLimit: 25 }), harness().deps);
    const paths = calls.map((c) => new URL(c.url).pathname);
    expect(paths[0]).toBe(`/v1/bots/${BOT}`);
    expect(paths).toContain(`/v1/bots/${BOT}/deliveries`);
    const log = calls.find((c) => new URL(c.url).pathname.endsWith('/deliveries'));
    expect(new URL(log?.url ?? '').searchParams.get('limit')).toBe('25');
  });

  it('sends --status to the server and no sort at all', async () => {
    // `sort` accepts `createdAt` only on this route, and descending is
    // already the default, so sending one is one more thing to get wrong.
    const { chatly, calls } = apiFor({});
    await tailBot(chatly, options({ status: 'dead' }), harness().deps);
    const q = new URL(calls.find((c) => new URL(c.url).pathname.endsWith('/deliveries'))?.url ?? '')
      .searchParams;
    expect(q.get('status')).toBe('dead');
    expect(q.get('sort')).toBeNull();
  });

  it('refuses a Chatly persona, because it has no ledger at all', async () => {
    const { chatly } = apiFor({ bot: botRow({ type: 'chatly', externalAgent: null }) });
    await expect(tailBot(chatly, options(), harness().deps)).rejects.toThrow(
      /not an external agent/,
    );
  });

  it('refuses an external agent with no webhookUrl, naming the command that sets one', async () => {
    const { chatly } = apiFor({
      bot: botRow({ externalAgent: { webhookUrl: null, signingSecretSet: true } }),
    });
    await expect(tailBot(chatly, options(), harness().deps)).rejects.toThrow(
      /chatly bots update-external/,
    );
  });

  it('warns in the banner when the agent has no signing secret', async () => {
    const { chatly } = apiFor({
      bot: botRow({
        externalAgent: { webhookUrl: 'https://a.test/x', signingSecretSet: false },
      }),
    });
    const h = harness();
    await tailBot(chatly, options(), h.deps);
    expect(h.out.join('\n')).toContain('NO SIGNING SECRET SET');
  });

  it('names the real destination and says it registered nothing', async () => {
    const { chatly } = apiFor({});
    const h = harness();
    await tailBot(chatly, options(), h.deps);
    const printed = h.out.join('\n');
    expect(printed).toContain('https://agent.example.test/chatly');
    expect(printed).toContain('Registers nothing on the server');
  });

  it('treats everything already in the ledger as seen', async () => {
    const { chatly, calls } = apiFor({
      pages: [{ items: [deliveryRow(), deliveryRow({ id: 'ad_2' })], nextCursor: null }],
    });
    const h = harness();
    const summary = await tailBot(chatly, options({ forwardTo: FORWARD, secret: SECRET }), h.deps);
    expect(summary.seen).toBe(0);
    expect(h.forwards).toHaveLength(0);
    // And it never read a payload, because it never had a new row.
    expect(calls.some((c) => new URL(c.url).pathname.includes('/deliveries/'))).toBe(false);
  });
});

describe('tailBot — the forwarded request', () => {
  const PAYLOAD = {
    eventId: 'ad_fwd',
    test: false,
    conversation: { id: 'c_1' },
    message: { body: 'where is my order' },
  };

  const oneNew = (over: Record<string, unknown> = {}): ReturnType<typeof apiFor> =>
    apiFor({
      pages: [
        { items: [], nextCursor: null },
        { items: [deliveryRow({ id: 'ad_fwd', ...over })], nextCursor: null },
      ],
      details: { ad_fwd: { ...deliveryRow({ id: 'ad_fwd', ...over }), payload: PAYLOAD } },
    });

  const run = async (
    over: Partial<ListenOptions> = {},
    h = harness({ maxPolls: 2 }),
  ): Promise<Harness> => {
    const { chatly } = oneNew();
    await tailBot(chatly, options({ forwardTo: FORWARD, secret: SECRET, ...over }), h.deps);
    return h;
  };

  it('POSTs the payload itself, with no envelope around it', async () => {
    /*
     * The external-agent protocol has no outer `{id,type,payload}` wrapper —
     * unlike the webhook dispatcher — so wrapping it here would make a
     * handler that works against this CLI fail against production.
     */
    const h = await run();
    const sent = h.forwards[0];
    expect(sent?.method).toBe('POST');
    expect(sent?.url).toBe(FORWARD);
    expect(JSON.parse(sent?.body ?? 'null')).toEqual(PAYLOAD);
  });

  it('carries the five headers the worker sends beside the signature', async () => {
    const h = await run();
    const headers = h.forwards[0]?.headers ?? {};
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-chatly-event']).toBe('agent.message');
    // `slug ?? id`, mirroring the worker, so a handler routing on this header
    // sees the value it sees in production.
    expect(headers['x-chatly-bot']).toBe('orders-agent');
    expect(headers['x-chatly-attempt']).toBe('1');
    // The ledger id IS the eventId in the payload, so dedupe behaves as it
    // will in production.
    expect(headers['x-chatly-delivery-id']).toBe('ad_fwd');
    expect(JSON.parse(h.forwards[0]?.body ?? '{}')).toMatchObject({ eventId: 'ad_fwd' });
    // Not a header Chatly sends.
    expect(headers['x-chatly-cli-forwarded']).toBe('1');
  });

  it('falls back to the bot id in x-chatly-bot when the agent has no slug', async () => {
    const { chatly } = apiFor({
      bot: botRow({ slug: null }),
      pages: [
        { items: [], nextCursor: null },
        { items: [deliveryRow({ id: 'ad_fwd' })], nextCursor: null },
      ],
    });
    const h = harness({ maxPolls: 2 });
    await tailBot(chatly, options({ forwardTo: FORWARD, secret: SECRET }), h.deps);
    expect(h.forwards[0]?.headers['x-chatly-bot']).toBe(BOT);
  });

  it('floors x-chatly-attempt at 1 on a row that has never been tried', async () => {
    // `attempt` counts attempts MADE, so a `pending` row is 0 — and 0 is not
    // a request number. The worker sends `attempt + 1` for the request it is
    // about to make.
    const { chatly } = oneNew({ attempt: 0, status: 'pending', httpStatus: null });
    const h = harness({ maxPolls: 2 });
    await tailBot(chatly, options({ forwardTo: FORWARD, secret: SECRET }), h.deps);
    expect(h.forwards[0]?.headers['x-chatly-attempt']).toBe('1');
  });

  it('signs x-chatly-signature so the agent under development can verify it', async () => {
    const h = await run();
    const sent = h.forwards[0];
    const result = verifyChatlySignature({
      surface: 'agent_delivery',
      body: sent?.body ?? '',
      headers: { 'x-chatly-signature': sent?.headers['x-chatly-signature'] ?? '' },
      secret: SECRET,
      nowMs: NOW_MS,
      // The v2 header is on the wire too; this assertion is about the legacy
      // construction specifically.
      v2: 'ignore',
    });
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
  });

  it('signs the legacy header over `<t>.<body>` and not the body alone', async () => {
    const h = await run();
    const sent = h.forwards[0];
    const header = sent?.headers['x-chatly-signature'] ?? '';
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    const t = /t=(\d+)/.exec(header)?.[1] ?? '';
    expect(t).toBe(String(NOW_SECONDS));
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
    // Agent deliveries carry no separate timestamp header, and inventing one
    // would teach a developer to read a header production does not send.
    expect(sent?.headers['x-chatly-timestamp']).toBeUndefined();
  });

  it('also mints the unified x-chatly-signature-v2, over t.METHOD.path.body', async () => {
    /*
     * C-02. The platform does not send this on agent deliveries yet, which is
     * the reason minting it here is useful: a developer can write the
     * verifier they will need before the sender moves.
     */
    const h = await run();
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
    const target = new URL(FORWARD);
    const path = `${target.pathname}${target.search}`;
    expect(path).toBe('/agent?tenant=acme');

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
    // And it is NOT the same digest as the legacy header: a verifier that
    // accepted either over the same base would hide a base-string bug.
    expect(header).not.toBe(sent?.headers['x-chatly-signature']);
  });

  it('does NOT sign when no --secret is given, and warns that verification will fail', async () => {
    const h = await run({ secret: null });
    expect(h.forwards[0]?.headers['x-chatly-signature']).toBeUndefined();
    expect(h.forwards[0]?.headers['x-chatly-signature-v2']).toBeUndefined();
    expect(h.out.join('\n')).toContain('UNSIGNED');
  });

  it('is honest in the banner that the signature is minted locally', async () => {
    const h = await run();
    expect(h.out.join('\n')).toContain('NOT the signature Chatly sent');
  });

  it('matches --event on the kind and on the wire name', async () => {
    for (const name of ['message', 'agent.message']) {
      const h = await run({ events: new Set([name]) });
      expect(h.forwards, name).toHaveLength(1);
    }
  });

  it('skips a delivery whose kind does not match --event', async () => {
    const h = await run({ events: new Set(['transfer']) });
    expect(h.forwards).toHaveLength(0);
  });

  it('counts a non-2xx as not forwarded, and hints at the secret on a 401', async () => {
    const h = harness({ maxPolls: 2, forwardStatus: 401 });
    const { chatly } = oneNew();
    const summary = await tailBot(chatly, options({ forwardTo: FORWARD, secret: SECRET }), h.deps);
    expect(summary.forwarded).toBe(0);
    expect(summary.refused).toBe(1);
    expect(h.err.join('')).toContain('--secret');
  });

  it('names the port when the local server is not running, and keeps tailing', async () => {
    const h = harness({ maxPolls: 2, throwOnForward: true });
    const { chatly } = oneNew();
    const summary = await tailBot(chatly, options({ forwardTo: FORWARD, secret: SECRET }), h.deps);
    expect(summary.refused).toBe(1);
    expect(h.err.join('')).toContain('Is your server running on that port?');
    expect(summary.polls).toBe(2);
  });

  it('prints the event name, id, attempt and status for every delivery', async () => {
    const h = await run({ forwardTo: null, secret: null });
    const printed = h.out.join('\n');
    expect(printed).toContain('agent.message');
    expect(printed).toContain('ad_fwd');
    expect(printed).toContain('attempt 1');
    expect(printed).toContain('delivered');
  });
});

describe('tailBot — stopping', () => {
  it('stops on an aborted signal without another poll', async () => {
    const { chatly, calls } = apiFor({});
    const controller = new AbortController();
    controller.abort();
    const h = harness({ maxPolls: 50 });
    const summary = await tailBot(chatly, options(), { ...h.deps, signal: controller.signal });
    expect(summary.polls).toBe(0);
    // The baseline read still happened; nothing after it did.
    expect(calls.filter((c) => new URL(c.url).pathname.endsWith('/deliveries'))).toHaveLength(1);
  });
});
