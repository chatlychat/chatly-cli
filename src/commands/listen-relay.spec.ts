/**
 * `chatly listen --relay` — what the CLI sends to the SERVER.
 *
 * The attach body, the long-poll, the answer it posts back, and how it reacts
 * to each answer `RELAY-SERVER-SPEC.md` allows. What reaches the developer's
 * own handler, and the teardown rules, are in
 * `listen-relay-forwarding.spec.ts`; the scripted server both drive is in
 * `listen-relay-harness.ts`, whose header carries the caveat that matters —
 * this proves what the CLI SENDS, and nothing about what the server answers.
 */
import { describe, expect, it } from 'vitest';

import {
  ALL,
  CANVAS,
  CARD,
  SESSION,
  TOOL,
  frame,
  harness,
  options,
  server,
} from './listen-relay-harness.js';
import {
  explainMissingServer,
  readFrames,
  relay,
  relayTargetUrl,
} from './listen-relay.js';
import { listen } from './listen.js';
import { parseArgs } from '../args.js';


describe('parseRelayOptions', () => {
  it('refuses a relay with no explicit target, naming all three flags', () => {
    expect(() => options('--forward-to http://localhost:3000')).toThrow(
      /--tool <id>[\s\S]*--card <id>[\s\S]*--canvas <channelId>/,
    );
  });

  it('refuses a relay with no --forward-to: a waiting caller needs an answer', () => {
    expect(() => options(`--tool ${TOOL}`)).toThrow(/needs --forward-to/);
  });

  it('refuses the ledger-tail flags, which mean nothing here', () => {
    expect(() => options(`--tool ${TOOL} --forward-to http://localhost:3000 --bot b_1`)).toThrow(
      /--bot tails a delivery ledger/,
    );
    expect(() => options(`--tool ${TOOL} --forward-to http://localhost:3000 --replay 3`)).toThrow(
      /--replay/,
    );
  });

  it('refuses a --forward-to with a query, which would be merged and mis-signed', () => {
    expect(() => options(`--tool ${TOOL} --forward-to http://localhost:3000/?a=1`)).toThrow(
      /query or fragment/,
    );
  });

  it('refuses a webhook or agent secret, which signs a different surface', () => {
    expect(() => options(`${ALL} --secret whsec_abc`)).toThrow(/webhook endpoint secret/);
    expect(() => options(`${ALL} --secret chsec_abc`)).toThrow(/external agent secret/);
  });

  it('assigns <id>=<secret> to that target, and keeps a padded secret whole', () => {
    // `abc==` contains `=` but `abc` is not a selected id, so it is a bare
    // secret — splitting it would invent a target and lose the secret.
    const o = options(`${ALL} --secret ${CARD}=card-secret --secret abc==`);
    expect(o.secrets.byTarget.get(CARD)).toBe('card-secret');
    expect(o.secrets.fallback).toBe('abc==');
  });

  it('refuses two bare secrets, which would be ambiguous', () => {
    expect(() => options(`${ALL} --secret one --secret two`)).toThrow(/<id>=<secret>/);
  });

  it('reads comma lists and repeats alike', () => {
    const o = options('--tool a,b --tool c --forward-to http://localhost:3000');
    expect(o.tools).toEqual(['a', 'b', 'c']);
  });
});

describe('listen dispatch', () => {
  it('refuses --tool without --relay rather than silently tailing a ledger', async () => {
    const { chatly, calls } = server();
    await expect(listen(chatly, parseArgs(['listen', '--tool', TOOL]))).rejects.toThrow(
      /--tool selects a target for --relay/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe('relayTargetUrl', () => {
  it("appends the configured url's path and query to the origin and prefix", () => {
    expect(relayTargetUrl('http://localhost:3000', '/orders/42?x=1')).toBe(
      'http://localhost:3000/orders/42?x=1',
    );
    expect(relayTargetUrl('http://localhost:3000/dev/', '/orders/42')).toBe(
      'http://localhost:3000/dev/orders/42',
    );
  });
});

describe('readFrames', () => {
  it('counts a frame it cannot read instead of dropping it silently', () => {
    const r = readFrames({ frames: [frame(), { id: 'x', kind: 'sms' }] });
    expect(r.frames).toHaveLength(1);
    expect(r.unreadable).toBe(1);
  });
});

describe('relay — attach', () => {
  it('attaches with exactly the selected ids, the protocol version and a 10-minute idle', async () => {
    const { chatly, calls } = server();
    const h = harness();
    await relay(chatly, options(ALL), h.deps);
    const attach = calls.find((c) => c.method === 'POST' && c.url.endsWith('/v1/relay-sessions'));
    expect(JSON.parse(attach?.body ?? '{}')).toMatchObject({
      protocol: 1,
      targets: { tools: [TOOL], customerCards: [CARD], canvasChannels: [CANVAS] },
      idleTimeoutSeconds: 600,
    });
    // A write, so the SDK sends an idempotency key: a retried attach must not
    // open a second session.
    expect(attach?.headers['idempotency-key']).toMatch(/.+/);
    expect(h.out.join('\n')).toContain('PRODUCTION calls');
    expect(h.out.join('\n')).toContain('key "laptop" (Ada)');
  });

  it('says plainly that the route is missing when the API predates it (404)', async () => {
    const { chatly } = server({ attach: { status: 404, code: 'not_found' } });
    const h = harness();
    await expect(relay(chatly, options(ALL), h.deps)).rejects.toThrow(
      /no relay route[\s\S]*nothing was redirected/,
    );
  });

  it('does not call a 422 (unknown target) a missing server', async () => {
    // The spec answers a typo'd id with 422 so the two cannot be confused.
    const { chatly } = server({ attach: { status: 422, code: 'relay_target_not_found' } });
    const h = harness();
    const err: unknown = await relay(chatly, options(ALL), h.deps).catch((e: unknown) => e);
    expect(explainMissingServer(err)).toBeNull();
    expect(String(err)).not.toContain('no relay route');
  });
});

describe('relay — what the CLI SENDS to the server', () => {
  // Asserted on the request, never on the canned reply: a fake that agrees
  // with whatever it is asked is how four mobile SDKs shipped dead realtime.
  // The shapes are `relayAttachSchema` / `relayAnswerSchema` in
  // `@livechat/shared/relay`, spelled out here because this package does not
  // depend on it; `scripts/check-relay-protocol-parity.mjs` covers the rest.

  it('sends the attach body with exactly the keys relayAttachSchema accepts', async () => {
    const { chatly, calls } = server();
    await relay(chatly, options(ALL), harness().deps);
    const attach = calls.find((c) => c.method === 'POST' && c.url.endsWith('/v1/relay-sessions'));
    const body = JSON.parse(attach?.body ?? '{}') as Record<string, unknown>;
    // The schema is z.object, which STRIPS an unknown key silently, so an
    // extra key here would look accepted while doing nothing.
    expect(Object.keys(body).sort()).toEqual([
      'idleTimeoutSeconds',
      'label',
      'protocol',
      'targets',
    ]);
    expect(Object.keys(body['targets'] as object).sort()).toEqual([
      'canvasChannels',
      'customerCards',
      'tools',
    ]);
    // 60..600 is the server's range; a longer idle is refused with 422.
    expect(body['idleTimeoutSeconds']).toBe(600);
    expect(body['label']).toMatch(/^chatly-cli \S+@\S+$/);
    expect((body['label'] as string).length).toBeLessThanOrEqual(200);
  });

  it('long-polls GET /frames with waitSeconds=10 and nothing else', async () => {
    const { chatly, calls } = server();
    await relay(chatly, options(ALL), harness().deps);
    const poll = calls.find((c) => c.method === 'GET');
    const url = new URL(poll?.url ?? 'http://none');
    expect(url.pathname).toBe(`/v1/relay-sessions/${SESSION}/frames`);
    // The server accepts 0..10 and the SDK transport times out at 15s.
    expect([...url.searchParams.entries()]).toEqual([['waitSeconds', '10']]);
    expect(poll?.body).toBeNull();
  });

  it('answers on the frame id with exactly the status-arm keys', async () => {
    const f = frame({ id: 'fr/odd id' });
    const { chatly, calls } = server({ polls: [{ status: 200, body: { frames: [f] } }] });
    await relay(chatly, options(ALL), harness().deps);
    const posted = calls.find((c) => c.method === 'POST' && c.url.includes('/frames/'));
    expect(new URL(posted?.url ?? 'http://none').pathname).toBe(
      `/v1/relay-sessions/${SESSION}/frames/fr%2Fodd%20id/response`,
    );
    const body = JSON.parse(posted?.body ?? '{}') as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['body', 'durationMs', 'headers', 'status']);
    expect(Number.isInteger(body['durationMs'])).toBe(true);
    expect(body['status']).toBeGreaterThanOrEqual(200);
  });

  it('answers a failure with exactly the error-arm keys and a vocabulary word', async () => {
    const { chatly, calls } = server({ polls: [{ status: 200, body: { frames: [frame()] } }] });
    const h = harness({
      respond: () => {
        throw new TypeError('connect ECONNREFUSED');
      },
    });
    await relay(chatly, options(ALL), h.deps);
    const posted = calls.find((c) => c.method === 'POST' && c.url.includes('/frames/'));
    const body = JSON.parse(posted?.body ?? '{}') as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['durationMs', 'error', 'message']);
    expect(body['error']).toBe('unreachable');
  });

  it('keeps an error message inside the 2,000 characters the server accepts', async () => {
    // Over the cap the server answers 422 and never records the answer, so
    // the visitor waits out the whole deadline instead of failing fast.
    const { chatly, calls } = server({ polls: [{ status: 200, body: { frames: [frame()] } }] });
    const h = harness({
      respond: () => {
        throw new TypeError('x'.repeat(5_000));
      },
    });
    await relay(chatly, options(ALL), h.deps);
    const posted = calls.find((c) => c.method === 'POST' && c.url.includes('/frames/'));
    const body = JSON.parse(posted?.body ?? '{}') as { message: string };
    expect(body.message.length).toBeLessThanOrEqual(2_000);
    expect(body.message.startsWith('http://localhost:3000')).toBe(true);
  });

  it('detaches with DELETE on the session id', async () => {
    const { chatly, calls } = server();
    await relay(chatly, options(ALL), harness().deps);
    const del = calls.find((c) => c.method === 'DELETE');
    expect(new URL(del?.url ?? 'http://none').pathname).toBe(`/v1/relay-sessions/${SESSION}`);
  });
});
