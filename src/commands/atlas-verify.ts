/**
 * `chatly channels verify-events-secret <channel>` (CH-26).
 *
 * ═══ WHAT IT IS FOR ══════════════════════════════════════════════════════
 *
 * Atlas mints the per-connection events signing secret and an operator pastes
 * it into Chatly. Until this existed, the only thing that told you the two
 * halves matched was a real Atlas event arriving — and when they do not
 * match, the receiver answers 401 and attributes it to no workspace, so there
 * is nothing to read either. FormFlow sat on 126 consecutive 401s with
 * `chatly doctor` reporting 12 ok.
 *
 * So: sign a test event HERE, with the secret you believe Atlas has, and ask
 * `POST /v1/atlas-receiver/verify` whether it verifies against what is
 * stored. The secret never leaves this process.
 *
 * ═══ THE SIGNING IS THREE LINES AND IT IS DUPLICATED ON PURPOSE ═══════════
 *
 * `signAtlasWebhook` lives in `apps/api`, which this PUBLISHED package cannot
 * import — the same rule that keeps `resolveOidcIssuers` out of
 * `doctor-checks.ts`. The alternative, sending the secret to the server and
 * letting it do the signing, is the one design that defeats the point: it
 * would put the credential on the wire and in a request log to answer a
 * question about whether it is already stored.
 *
 * What makes the duplication safe is that it is the SIGNING half, not the
 * verifying half. ADR 0072's rule is about verifiers, and the server still
 * has exactly one (`verifyAtlasWebhook`). A signer that drifts cannot admit a
 * forgery; it can only produce a `mismatch` on a correct secret, which is a
 * loud wrong answer rather than a quiet one — and
 * `atlas-verify-signature.spec.ts` pins the format against the vector the
 * receiver's own spec uses.
 */
import { createHmac } from 'node:crypto';

import { bool, str, type ParsedArgs } from '../args.js';
import { printJson } from '../output.js';
import { need } from './common.js';

import type { ChatlyClient } from '@chatlychat/sdk-node';

/** Where the secret comes from when `--secret` is not passed. */
export const SECRET_ENV = 'ATLAS_CHATLY_EVENTS_SECRET';

/**
 * Atlas's own scheme: HMAC-SHA256 over `<id>.<timestamp>.<body>`, base64,
 * announced as `v1,<mac>`. The timestamp is INSIDE the signed material, which
 * is what stops a captured body being replayed with a fresh one.
 */
export function signAtlasEvent(input: {
  readonly id: string;
  readonly timestampMs: number;
  readonly body: string;
  readonly secret: string;
}): string {
  const mac = createHmac('sha256', input.secret)
    .update(`${input.id}.${String(input.timestampMs)}.${input.body}`)
    .digest('base64');
  return `v1,${mac}`;
}

/**
 * The test event.
 *
 * Deliberately NOT a real event type. `type` is a name no Atlas event carries
 * and `data` is empty, so the one thing this body could ever do if some
 * future receiver did parse it is nothing — defence behind the route's own
 * guarantee that it never parses the payload at all.
 */
export function testEvent(now: number): { id: string; payload: string } {
  const id = `evt_chatly_cli_verify_${String(now)}`;
  return {
    id,
    payload: JSON.stringify({
      id,
      type: 'chatly.cli.verify',
      instance_id: 'chatly-cli-verify',
      data: {},
    }),
  };
}

interface VerifyAnswer {
  readonly verified?: unknown;
  readonly reason?: unknown;
  readonly secretSet?: unknown;
  readonly channelId?: unknown;
  readonly detail?: unknown;
}

/**
 * Exit 0 only when the stored secret verified. Non-zero is what makes this
 * usable as the deploy gate the customer asked for.
 */
export async function verifyEventsSecret(
  chatly: ChatlyClient,
  args: ParsedArgs,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const channel = need(args, 2, 'a channel id or publicId');
  const secret = str(args.flags, 'secret') ?? env[SECRET_ENV];
  if (secret === undefined || secret === '') {
    // Refused by name rather than defaulted: an empty secret would be signed
    // with, answer `mismatch`, and read as "Atlas has a different secret".
    throw new Error(
      `No secret to sign with. Pass --secret, or export ${SECRET_ENV} with the value Atlas ` +
        'gave you. This is the secret you believe Atlas HAS — it is never sent to Chatly.',
    );
  }
  const now = Date.now();
  const { id, payload } = testEvent(now);
  const answer = await chatly.request<VerifyAnswer>('POST', '/v1/atlas-receiver/verify', {
    body: {
      channel,
      id,
      timestamp: now,
      signature: signAtlasEvent({ id, timestampMs: now, body: payload, secret }),
      payload,
    },
  });
  const ok = answer.verified === true;
  if (bool(args.flags, 'json')) {
    printJson(answer);
    return ok ? 0 : 1;
  }
  const detail = typeof answer.detail === 'string' ? answer.detail : '';
  process.stdout.write(
    `${ok ? 'ok  ' : 'FAIL'}  atlas events secret (${channel})\n      ${
      ok
        ? detail
        : `${detail}${typeof answer.reason === 'string' ? ` [${answer.reason}]` : ''}`
    }\n`,
  );
  return ok ? 0 : 1;
}
