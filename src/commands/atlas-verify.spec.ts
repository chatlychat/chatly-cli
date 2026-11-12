/**
 * `chatly channels verify-events-secret` (CH-26).
 *
 * ═══ THE GOLDEN VECTOR, AND WHY IT IS THE WHOLE POINT ═════════════════════
 *
 * This package cannot import the server's `signAtlasWebhook` (published vs
 * private — see `atlas-verify.ts`'s header), so the two halves are pinned
 * against ONE literal signature instead: the same vector is asserted in
 * `apps/api/src/modules/atlas-receiver/atlas-receiver.spec.ts`. A drift on
 * either side changes one of the two and fails that side's test by name.
 *
 * Comparing the signer to a re-implementation of itself here would be the
 * tautology this repo keeps finding — `markdown/index.spec.ts`'s golden table
 * exists for the same reason.
 *
 * The consequence of a drift is worth stating, because it is why this matters
 * more than it looks: a wrong signer cannot admit a forgery (the server still
 * holds the only verifier), it can only report `mismatch` on a CORRECT
 * secret. That sends an operator to re-paste a secret that was already right,
 * which is the support conversation this whole feature exists to end.
 *
 * CONTROL for each assertion is in its comment. Run 2026-11-11 against a
 * mechanical slice of this file driven by `node` (this tree's `node_modules`
 * is empty), with the real verifier sliced out of `atlas-webhook.ts`.
 */
import { describe, expect, it, vi } from 'vitest';

import { SECRET_ENV, signAtlasEvent, testEvent, verifyEventsSecret } from './atlas-verify.js';
import { parseArgs } from '../args.js';

import type { ChatlyClient } from '@chatlychat/sdk-node';

/**
 * The vector. Identical to the one in the API's own spec — change one and
 * change both, or one of the two goes red.
 */
const VECTOR = {
  id: 'evt_fixed',
  timestampMs: 1_762_891_980_000,
  body: '{"x":1}',
  secret: 's3cret',
  signature: 'v1,o/1HWoJ67ij3zh3sZk3Bn9Ntyo80grNK7DafJCE8CMU=',
};

describe('signAtlasEvent', () => {
  /*
   * CONTROL: dropping the timestamp from the signed material, or digesting as
   * hex instead of base64, each make this fail on the literal. Both were run;
   * both failed by name.
   */
  it('matches the vector the server’s verifier is pinned to', () => {
    expect(
      signAtlasEvent({
        id: VECTOR.id,
        timestampMs: VECTOR.timestampMs,
        body: VECTOR.body,
        secret: VECTOR.secret,
      }),
    ).toBe(VECTOR.signature);
  });

  /* The id and the timestamp are both inside the MAC, which is what stops a
   * captured body being replayed with a fresh timestamp. CONTROL: signing
   * over the body alone makes both of these equal the first. */
  it('covers the id and the timestamp, not just the body', () => {
    const base = { body: VECTOR.body, secret: VECTOR.secret };
    const a = signAtlasEvent({ ...base, id: 'a', timestampMs: VECTOR.timestampMs });
    const b = signAtlasEvent({ ...base, id: 'b', timestampMs: VECTOR.timestampMs });
    const c = signAtlasEvent({ ...base, id: 'a', timestampMs: VECTOR.timestampMs + 1 });
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe('testEvent', () => {
  /*
   * CONTROL: naming the type `session.revoked` makes this fail. The route
   * never parses the payload, so this is defence behind that — but a test
   * event that READS like a destructive one is the thing somebody copies out
   * of a terminal and replays by hand.
   */
  it('is not a real Atlas event type, and carries no subject', () => {
    const { id, payload } = testEvent(1);
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    expect(parsed['type']).toBe('chatly.cli.verify');
    expect(parsed['data']).toEqual({});
    expect(parsed['id']).toBe(id);
  });
});

describe('verifyEventsSecret', () => {
  const client = (answer: unknown): { chatly: ChatlyClient; sent: unknown[] } => {
    const sent: unknown[] = [];
    const chatly = {
      request: vi.fn(async (method: string, path: string, init?: { body?: unknown }) => {
        sent.push({ method, path, body: init?.body });
        return answer;
      }),
    } as unknown as ChatlyClient;
    return { chatly, sent };
  };
  const args = parseArgs(['channels', 'verify-events-secret', 'ch_web_1']);

  /*
   * Asserting on what the CLI SENT, not on the canned answer — the lesson
   * from the four mobile SDKs that shipped unable to connect with green
   * suites.
   *
   * CONTROL: sending `secret` in the body (the design that lets the server do
   * the signing) makes this fail on the `not.toContain`. That is the one
   * mistake this feature must not make: it would put the credential in a
   * request log to answer a question about whether it is already stored.
   */
  it('sends a signature and never the secret', async () => {
    const { chatly, sent } = client({ verified: true, detail: 'ok' });
    expect(await verifyEventsSecret(chatly, args, { [SECRET_ENV]: VECTOR.secret })).toBe(0);
    const [call] = sent as Array<{ method: string; path: string; body: Record<string, unknown> }>;
    expect(call?.method).toBe('POST');
    expect(call?.path).toBe('/v1/atlas-receiver/verify');
    expect(call?.body['channel']).toBe('ch_web_1');
    expect(JSON.stringify(call?.body)).not.toContain(VECTOR.secret);
    expect(String(call?.body['signature'])).toMatch(/^v1,/);
  });

  /*
   * CONTROL: returning 0 on `verified: false` makes this fail. A verify that
   * exits 0 whatever it found is the same defect as `12 ok, 0 failed` over a
   * dead receiver — and this command's whole purpose is to be a deploy gate.
   */
  it('exits non-zero when the stored secret does not verify', async () => {
    const { chatly } = client({ verified: false, reason: 'mismatch', detail: 'no' });
    expect(await verifyEventsSecret(chatly, args, { [SECRET_ENV]: VECTOR.secret })).toBe(1);
  });

  /*
   * CONTROL: defaulting the secret to `''` instead of throwing makes this
   * resolve to 1 with a `mismatch` — "Atlas has a different secret" invented
   * out of an unexported variable, which is the exact shape of
   * `reference_env_fallback_reaches_production`.
   */
  it('refuses to sign with no secret rather than signing with an empty one', async () => {
    const { chatly, sent } = client({ verified: false });
    await expect(verifyEventsSecret(chatly, args, {})).rejects.toThrow(SECRET_ENV);
    expect(sent).toEqual([]);
  });

  /* CONTROL: reading the channel off `args.path[1]` (the subcommand) makes
   * this fail — it would verify a channel called `verify-events-secret`. */
  it('needs a channel', async () => {
    const { chatly } = client({ verified: true });
    await expect(
      verifyEventsSecret(chatly, parseArgs(['channels', 'verify-events-secret']), {
        [SECRET_ENV]: VECTOR.secret,
      }),
    ).rejects.toThrow(/channel/);
  });
});
