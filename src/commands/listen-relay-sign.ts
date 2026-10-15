/**
 * The signature a relayed SYNCHRONOUS call carries when it reaches localhost.
 *
 * ═══ WHY THE CLI SIGNS AND THE SERVER DOES NOT ════════════════════════════
 *
 * The server holds the real secret for every one of these surfaces, so the
 * obvious design is for it to sign the frame and for this CLI to forward it
 * byte for byte. That is rejected in `RELAY-SERVER-SPEC.md` §5 and the reason
 * is worth repeating where the signing happens: a frame carrying a
 * production-valid signature is a replayable credential, delivered to anyone
 * holding a `ck_` key with the relay permission. For a tool call the MAC
 * covers the method and the path, so the replay is narrow — but for a
 * customer-card fetch and a canvas step it covers `<ts>.<body>` only, and the
 * same signed bytes are accepted by the operator's REAL endpoint for the next
 * five minutes. So frames arrive unsigned and are signed here, with the
 * secret the developer passes in `--secret`, exactly as `listen` and
 * `listen --bot` already do for the ledgers.
 *
 * ═══ THE THREE CONSTRUCTIONS, AS THE SENDERS USE THEM ═════════════════════
 *
 * Read against the senders, not against the docs:
 *
 *   | kind            | sender                                              | header(s)                                           | base                          | `t` unit |
 *   | --------------- | --------------------------------------------------- | --------------------------------------------------- | ----------------------------- | -------- |
 *   | `ai_tool_call`  | `dialCustomTool`, `packages/shared/src/ai-tools`    | `x-chatly-signature: t=…,v1=…`                      | `<t>.<METHOD>.<path>.<body>`  | seconds  |
 *   | `customer_card` | `customer-cards.fetcher.ts` `attempt()`             | `x-chatly-signature: sha256=…` + `x-chatly-timestamp` | `<ts>.<body>`               | **ms**   |
 *   | `canvas_step`   | `widget-canvas.service.ts` `callIntegrator()`       | `x-chatly-canvas-signature: sha256=…` + `-ts`       | `<ts>.<body>`                 | **ms**   |
 *
 * Two of the three put `x-chatly-signature` on the wire with DIFFERENT
 * formats, and two send milliseconds where the third sends seconds. Both
 * traps are why each header is checked with the SDK's own
 * `verifyChatlySignature` under its own `surface` before the request goes
 * out, and a forward that does not verify is refused rather than sent — the
 * reasoning is `listen-core.ts`'s, and so is the unified
 * `x-chatly-signature-v2` minted beside each one.
 *
 * `path` in the tool-call base string is the LOCAL path, because that is the
 * request line the developer's handler verifies.
 */
import { createHmac } from 'node:crypto';

import { chatlyV2SigningPath, signChatlyV2, verifyChatlySignature } from '@chatlychat/sdk-node';

/** The three surfaces a relay carries. Values are the SDK's surface names. */
export const RELAY_KINDS = ['ai_tool_call', 'customer_card', 'canvas_step'] as const;
export type RelayKind = (typeof RELAY_KINDS)[number];

/**
 * Header names this CLI owns on a relayed request.
 *
 * Stripped from whatever the frame carried before signing, so a server that
 * got §5 wrong and sent the production signature cannot have it forwarded
 * beside ours — a handler that reads the first `x-chatly-signature` it finds
 * would then verify the server's MAC, which is over the PRODUCTION path, and
 * fail for a reason nobody could see. `host` and `content-length` are
 * `fetch`'s to set.
 */
export const RELAY_OWNED_HEADERS: ReadonlySet<string> = new Set([
  'x-chatly-signature',
  'x-chatly-signature-v2',
  'x-chatly-timestamp',
  'x-chatly-canvas-signature',
  'x-chatly-canvas-ts',
  'host',
  'content-length',
]);

function hmacHex(secret: string, base: string): string {
  return createHmac('sha256', secret).update(base).digest('hex');
}

/**
 * The signature headers for one relayed request, self-checked.
 *
 * Returns the headers to merge, or a message naming what failed — which can
 * only be a bug in this CLI, since it signed the bytes itself.
 */
export function signRelayedRequest(input: {
  readonly kind: RelayKind;
  readonly method: string;
  /** The absolute LOCAL url this request is about to be sent to. */
  readonly targetUrl: string;
  readonly body: string;
  readonly secret: string;
  readonly nowMs: number;
}): { ok: true; headers: Record<string, string> } | { ok: false; message: string } {
  const { kind, body, secret, nowMs } = input;
  const method = input.method.toUpperCase();
  const path = chatlyV2SigningPath(input.targetUrl);
  if (path === null) {
    return { ok: false, message: `"${input.targetUrl}" is not a URL` };
  }
  const seconds = Math.floor(nowMs / 1000);

  const headers: Record<string, string> = {};
  if (kind === 'ai_tool_call') {
    const t = String(seconds);
    headers['x-chatly-signature'] =
      `t=${t},v1=${hmacHex(secret, `${t}.${method}.${path}.${body}`)}`;
  } else {
    // MILLISECONDS, as both senders do: `Date.now().toString()`.
    const ts = String(Math.floor(nowMs));
    const value = `sha256=${hmacHex(secret, `${ts}.${body}`)}`;
    if (kind === 'customer_card') {
      headers['x-chatly-timestamp'] = ts;
      headers['x-chatly-signature'] = value;
    } else {
      headers['x-chatly-canvas-ts'] = ts;
      headers['x-chatly-canvas-signature'] = value;
    }
  }

  const legacyCheck = verifyChatlySignature({
    surface: kind,
    body,
    headers,
    secret,
    method,
    path,
    nowMs,
    // This check is of the surface's OWN construction; v2 is checked below.
    v2: 'ignore',
  });
  if (!legacyCheck.ok) {
    return { ok: false, message: `${legacyCheck.reason}: ${legacyCheck.message}` };
  }

  const v2 = signChatlyV2({
    base: 'target',
    secret,
    timestampSeconds: seconds,
    method,
    path,
    body,
  });
  const v2Check = verifyChatlySignature({
    surface: 'unified_v2',
    body,
    headers: { 'x-chatly-signature-v2': v2 },
    secret,
    method,
    path,
    nowMs,
  });
  if (!v2Check.ok) {
    return { ok: false, message: `${v2Check.reason}: ${v2Check.message}` };
  }
  headers['x-chatly-signature-v2'] = v2;
  return { ok: true, headers };
}
