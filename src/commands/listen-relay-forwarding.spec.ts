/**
 * `chatly listen --relay` — what reaches localhost, and what happens when the
 * terminal is shut down.
 *
 * Split out of `listen-relay.spec.ts` when that file crossed the 650-line
 * ceiling. The two halves are not arbitrary: the other file is about what the
 * CLI SENDS TO THE SERVER (the attach body, the poll, the answer it posts),
 * and this one is about what it sends to the DEVELOPER'S OWN handler — the
 * forwarded request, its re-signature, and the teardown rules. They share the
 * harness in `./listen-relay-harness.js`.
 *
 * The caveat from the other file applies here too and is the important one:
 * the "server" is a fake `fetch` under the REAL `ChatlyClient`, so this proves
 * what the CLI does with each answer the spec allows, and proves nothing about
 * what the server actually answers.
 */
import { verifyChatlySignature } from '@chatlychat/sdk-node';
import { describe, expect, it } from 'vitest';

import {
  ALL,
  CANVAS,
  CARD,
  NOW_MS,
  SECRET,
  SESSION,
  TOOL,
  frame,
  harness,
  options,
  server,
  type Answer,
  type Call,
} from './listen-relay-harness.js';
import {
  RELAY_IDLE_TIMEOUT_MS,
  answerFrame,
  relay,
  type RelayFrame,
} from './listen-relay.js';

import type { ListenDeps } from './listen-core.js';

describe('relay — forwarding and signing', () => {
  async function relayOne(
    f: RelayFrame,
    argv = `${ALL} --secret ${SECRET}`,
  ): Promise<{ forward: Call | undefined; answer: unknown; err: string[] }> {
    const { chatly, calls } = server({ polls: [{ status: 200, body: { frames: [f] } }] });
    const h = harness();
    await relay(chatly, options(argv), h.deps);
    const posted = calls.find((c) => c.url.endsWith(`/frames/${f.id}/response`));
    return {
      forward: h.forwards[0],
      answer: JSON.parse(posted?.body ?? 'null'),
      err: h.err,
    };
  }

  it('forwards a tool call with its method and path, and posts the answer back', async () => {
    const { forward, answer } = await relayOne(frame());
    expect(forward?.method).toBe('GET');
    expect(forward?.url).toBe('http://localhost:3000/orders/42?expand=items');
    expect(forward?.body).toBeNull();
    expect(forward?.headers['x-chatly-contact-external-id']).toBe('u_7');
    expect(answer).toMatchObject({
      status: 200,
      body: '{"ok":true}',
      headers: { 'content-type': 'application/json' },
    });
  });

  it('signs a tool call so ai_tool_call verifies over the LOCAL path', async () => {
    const { forward } = await relayOne(
      frame({ path: '/v2/orders/42' }),
      `--tool ${TOOL} --forward-to http://localhost:3000/dev --secret ${SECRET}`,
    );
    const sig = { 'x-chatly-signature': forward?.headers['x-chatly-signature'] ?? '' };
    const verify = (path: string) =>
      verifyChatlySignature({
        surface: 'ai_tool_call',
        body: '',
        headers: sig,
        secret: SECRET,
        method: 'GET',
        path,
        nowMs: NOW_MS,
        v2: 'ignore',
      });
    const local = verify('/dev/v2/orders/42');
    expect(local.ok, local.ok ? '' : local.message).toBe(true);
    // And not over the production path, which the handler never receives.
    expect(verify('/v2/orders/42').ok).toBe(false);
  });

  it('signs a customer-card fetch with a MILLISECOND x-chatly-timestamp', async () => {
    const body = '{"cardKeys":["billing"]}';
    const { forward } = await relayOne(
      frame({
        id: 'fr_c',
        kind: 'customer_card',
        targetId: CARD,
        method: 'POST',
        path: '/cards',
        body,
      }),
    );
    expect(forward?.headers['x-chatly-timestamp']).toBe(String(NOW_MS));
    expect(forward?.headers['x-chatly-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    const r = verifyChatlySignature({
      surface: 'customer_card',
      body: forward?.body ?? '',
      headers: forward?.headers ?? {},
      secret: SECRET,
      nowMs: NOW_MS,
      v2: 'ignore',
    });
    expect(r.ok, r.ok ? '' : r.message).toBe(true);
  });

  it('signs a canvas step with x-chatly-canvas-signature and -ts', async () => {
    const body = '{"canvasId":"cv_1"}';
    const { forward } = await relayOne(
      frame({
        id: 'fr_v',
        kind: 'canvas_step',
        targetId: CANVAS,
        method: 'POST',
        path: '/canvas',
        body,
      }),
    );
    expect(forward?.headers['x-chatly-canvas-ts']).toBe(String(NOW_MS));
    const r = verifyChatlySignature({
      surface: 'canvas_step',
      body: forward?.body ?? '',
      headers: forward?.headers ?? {},
      secret: SECRET,
      nowMs: NOW_MS,
      v2: 'ignore',
    });
    expect(r.ok, r.ok ? '' : r.message).toBe(true);
  });

  it('mints a verifying x-chatly-signature-v2 on every kind', async () => {
    for (const f of [
      frame(),
      frame({
        id: 'fr_c',
        kind: 'customer_card',
        targetId: CARD,
        method: 'POST',
        path: '/c',
        body: '{}',
      }),
      frame({
        id: 'fr_v',
        kind: 'canvas_step',
        targetId: CANVAS,
        method: 'POST',
        path: '/v',
        body: '{}',
      }),
    ]) {
      const { forward } = await relayOne(f);
      const url = new URL(forward?.url ?? 'http://x');
      const r = verifyChatlySignature({
        surface: 'unified_v2',
        body: forward?.body ?? '',
        headers: { 'x-chatly-signature-v2': forward?.headers['x-chatly-signature-v2'] ?? '' },
        secret: SECRET,
        method: f.method,
        path: `${url.pathname}${url.search}`,
        nowMs: NOW_MS,
      });
      expect(r.ok, `${f.kind}: ${r.ok ? '' : r.message}`).toBe(true);
    }
  });

  it('strips a signature the server should not have sent, and signs its own', async () => {
    const { forward } = await relayOne(
      frame({ headers: { 'x-chatly-signature': 't=1,v1=production', 'x-chatly-timestamp': '1' } }),
    );
    expect(forward?.headers['x-chatly-signature']).not.toContain('production');
    expect(forward?.headers['x-chatly-timestamp']).toBeUndefined();
  });

  it('sends unsigned, and says so, when the target has no secret', async () => {
    const { chatly } = server({ polls: [{ status: 200, body: { frames: [frame()] } }] });
    const h = harness();
    await relay(chatly, options(ALL), h.deps);
    expect(h.forwards[0]?.headers['x-chatly-signature']).toBeUndefined();
    expect(h.forwards[0]?.headers['x-chatly-signature-v2']).toBeUndefined();
    expect(h.out.join('\n')).toContain(`UNSIGNED for ${TOOL}`);
  });

  it('uses the per-target secret over the fallback', async () => {
    const { forward } = await relayOne(
      frame(),
      `${ALL} --secret fallback --secret ${TOOL}=${SECRET}`,
    );
    const r = verifyChatlySignature({
      surface: 'ai_tool_call',
      body: '',
      headers: { 'x-chatly-signature': forward?.headers['x-chatly-signature'] ?? '' },
      secret: SECRET,
      method: 'GET',
      path: '/orders/42?expand=items',
      nowMs: NOW_MS,
      v2: 'ignore',
    });
    expect(r.ok).toBe(true);
  });

  it('refuses to forward a frame for an id this relay did not ask for', async () => {
    const { forward, answer } = await relayOne(frame({ targetId: 'tool_someone_elses' }));
    expect(forward).toBeUndefined();
    expect(answer).toMatchObject({ error: 'not_selected' });
  });

  it('answers unreachable when nothing is listening locally', async () => {
    const opts = options(ALL);
    const h = harness({
      respond: () => {
        throw new TypeError('fetch failed');
      },
    });
    const a = await answerFrame(opts, h.deps, frame(), new AbortController().signal);
    expect(a).toMatchObject({ error: 'unreachable' });
  });

  it("aborts the local forward at the caller's deadline", async () => {
    const opts = options(ALL);
    const h = harness({ now: () => Date.now() });
    // A handler that never answers until its request is aborted.
    const hang = ((_u: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      })) as unknown as typeof fetch;
    const a = await answerFrame(
      opts,
      { ...h.deps, fetchFn: hang },
      frame({ deadlineAt: new Date(Date.now() + 30).toISOString() }),
      new AbortController().signal,
    );
    expect(a).toMatchObject({ error: 'timeout' });
  });

  it('refuses an oversized local answer rather than relaying it', async () => {
    const opts = options(ALL);
    const h = harness({ respond: () => new Response('x'.repeat(1_048_577), { status: 200 }) });
    const a = await answerFrame(opts, h.deps, frame(), new AbortController().signal);
    expect(a).toMatchObject({ error: 'too_large' });
  });
});

describe('relay — idle timeout and teardown', () => {
  it('detaches after 10 minutes with no call, and DELETEs the session', async () => {
    let t = NOW_MS;
    const { chatly, calls } = server();
    const h = harness({
      maxPolls: 100,
      // Every clock read advances two minutes, so idle passes within a few polls.
      now: () => {
        t += 2 * 60_000;
        return t;
      },
    });
    const r = await relay(chatly, options(ALL), h.deps);
    expect(r.endReason).toBe('idle');
    expect(r.polls).toBeLessThan(100);
    expect(
      calls.some((c) => c.method === 'DELETE' && c.url.endsWith(`/v1/relay-sessions/${SESSION}`)),
    ).toBe(true);
  });

  it('a call resets the idle clock', async () => {
    let t = NOW_MS;
    const step = RELAY_IDLE_TIMEOUT_MS / 4;
    const polls: Answer[] = Array.from({ length: 12 }, (_, i) =>
      i % 3 === 2
        ? { status: 200, body: { frames: [frame({ id: `fr_${String(i)}` })] } }
        : { status: 200, body: { frames: [] } },
    );
    const { chatly } = server({ polls });
    const h = harness({
      maxPolls: 12,
      now: () => {
        t += step / 2;
        return t;
      },
    });
    const r = await relay(chatly, options(ALL), h.deps);
    // Without the reset this would idle out after ~4 polls.
    expect(r.endReason).toBe('max_polls');
    expect(r.frames).toBe(4);
  });

  it('stops on 410 from the server, in its vocabulary, without a DELETE', async () => {
    const { chatly, calls } = server({
      polls: [{ status: 410, code: 'relay_ended_lease_expired' }],
    });
    const h = harness({ maxPolls: 5 });
    const r = await relay(chatly, options(ALL), h.deps);
    expect(r.endReason).toBe('lease_expired');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('detaches with a DELETE on Ctrl-C', async () => {
    const ctrl = new AbortController();
    const { chatly, calls } = server();
    const h = harness({ maxPolls: 100, signal: ctrl.signal });
    const original = h.deps.out;
    // Abort as soon as the banner has printed: the next loop check sees it.
    const deps: ListenDeps = {
      ...h.deps,
      out: (l) => {
        original(l);
        ctrl.abort();
      },
    };
    const r = await relay(chatly, options(ALL), deps);
    expect(r.endReason).toBe('interrupted');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
  });

  it('keeps polling through a transient poll failure', async () => {
    const { chatly } = server({
      polls: [
        { status: 503, code: 'unavailable' },
        { status: 200, body: { frames: [frame()] } },
      ],
    });
    const h = harness({ maxPolls: 2 });
    const r = await relay(chatly, options(ALL), h.deps);
    expect(r.frames).toBe(1);
    expect(h.err.join('')).toContain('poll failed');
  });
});
