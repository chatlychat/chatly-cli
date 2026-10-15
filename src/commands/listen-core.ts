/**
 * What `chatly listen` does the same way for every surface it tails.
 *
 * ═══ WHY THIS FILE EXISTS ═════════════════════════════════════════════════
 *
 * `listen` tails two ledgers now — webhook subscriptions
 * (`/v1/webhooks/deliveries`) and an external agent's push deliveries
 * (`/v1/bots/{id}/deliveries`) — and will tail more. The poll loop differs
 * per ledger; the flags, the seen-set, the signing and the forward leg do
 * not. They are here so there is one of each, and so `listen.ts` stays under
 * this repo's 650-line ceiling.
 *
 * ═══ THE SIGNATURE IT MINTS, AND THE SELF-CHECK ═══════════════════════════
 *
 * Neither ledger stores the signature Chatly sent — `webhook_deliveries` and
 * `agent_deliveries` both store the PAYLOAD as `jsonb` and nothing else, and
 * `jsonb` does not preserve key order, so the exact signed bytes are
 * unreconstructable by construction rather than by omission. So a forwarded
 * request is re-signed here, from `--secret`, and every forward carries TWO
 * headers:
 *
 *   - the surface's own legacy header (`x-livechat-signature` for an event
 *     webhook, `x-chatly-signature` for an agent delivery), `t=…,v1=…` over
 *     `<t>.<rawBody>` — what the platform sends today;
 *   - `x-chatly-signature-v2`, `t=…,v1=…` over
 *     `<t>.<METHOD>.<path>.<rawBody>` — the unified construction every
 *     surface is moving to (C-02). The platform does not send this on either
 *     surface yet, which is exactly why minting it locally is useful: a
 *     developer can write and test the verifier they will need before the
 *     sender moves.
 *
 * `path` in that base string is the path of the request being signed — the
 * local `--forward-to` path, because that is the request the receiver
 * verifies. Both headers are verified with the SDK's own
 * `verifyChatlySignature` BEFORE the request goes out, and a forward whose
 * own signature does not verify is refused rather than sent. That self-check
 * is not ceremony: it is the one thing that catches a signer and a verifier
 * drifting on construction or on timestamp unit, which is a bug this product
 * has actually shipped — the scheme once emitted milliseconds in the header
 * while signing a seconds value, and every correct handler rejected us.
 */
import { createHmac } from 'node:crypto';

import { chatlyV2SigningPath, signChatlyV2, verifyChatlySignature } from '@chatlychat/sdk-node';

import { bool, num, str, type ParsedArgs } from '../args.js';

/** Which construction the legacy header on a surface uses. */
export interface SignPlan {
  /** The surface the legacy header belongs to, for the self-check. */
  readonly surface: 'event_webhook' | 'agent_delivery';
  /** The header name carrying `t=…,v1=…`. */
  readonly legacyHeader: string;
  /**
   * A header carrying `t` on its own, when the real sender sends one.
   * `null` on agent deliveries, which do not.
   */
  readonly timestampHeader: string | null;
}

export const WEBHOOK_SIGN_PLAN: SignPlan = {
  surface: 'event_webhook',
  legacyHeader: 'x-livechat-signature',
  timestampHeader: 'x-livechat-timestamp',
};

export const AGENT_SIGN_PLAN: SignPlan = {
  surface: 'agent_delivery',
  legacyHeader: 'x-chatly-signature',
  timestampHeader: null,
};

export interface ListenOptions {
  /** Where to POST each event. `null` prints without forwarding. */
  readonly forwardTo: string | null;
  /** `--bot <id>`: tail that external agent's delivery ledger instead. */
  readonly botId: string | null;
  readonly endpointId: string | null;
  /** Client-side event filter. `null` means every event in the log. */
  readonly events: ReadonlySet<string> | null;
  readonly status: string | null;
  /** The secret to re-sign forwarded requests with. `null` sends unsigned. */
  readonly secret: string | null;
  readonly intervalMs: number;
  /** How many deliveries already in the log to forward before tailing. */
  readonly replay: number;
  /** Rows per poll. Also the most this can see between two polls. */
  readonly pageLimit: number;
  readonly json: boolean;
}

export interface ListenDeps {
  /** For the FORWARD leg only. API calls go through the SDK's own transport. */
  readonly fetchFn: typeof fetch;
  readonly now: () => number;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly signal: AbortSignal;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /**
   * Stop after this many polls. Test-only, and the reason it exists rather
   * than a timer the test races: a tail loop with no bound is not a thing a
   * unit test can assert the end of.
   */
  readonly maxPolls?: number;
}

export interface ListenSummary {
  readonly seen: number;
  readonly forwarded: number;
  readonly refused: number;
  readonly polls: number;
}

/** Deliveries remembered before the oldest id is dropped. */
const SEEN_CAP = 5_000;

const DEFAULT_INTERVAL_SECONDS = 2;
const MIN_INTERVAL_SECONDS = 1;
const DEFAULT_PAGE_LIMIT = 50;

/**
 * The four words both ledgers use, with the same meanings: `failed` will be
 * retried and `dead` will not. Validated here because the bot ledger answers
 * a **400** on a word outside the four rather than an empty page.
 */
export const DELIVERY_STATUSES = ['pending', 'delivered', 'failed', 'dead'] as const;

/** Drop the oldest ids once the set is at its cap. Sets iterate in insertion order. */
export function remember(seen: Set<string>, id: string): void {
  seen.add(id);
  if (seen.size > SEEN_CAP) {
    for (const old of seen) {
      seen.delete(old);
      if (seen.size <= SEEN_CAP) {
        break;
      }
    }
  }
}

/** `t=<unix seconds>,v1=<hex>` over `<t>.<body>`, the way the worker signs. */
function tv1(body: string, secret: string, t: string, prefix = ''): string {
  const v1 = createHmac('sha256', secret).update(`${t}.${prefix}${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

/**
 * The signature headers for one forwarded request, self-checked.
 *
 * Returns the headers to merge, or a message naming what went wrong — which
 * can only be a bug in this CLI, since it signed the bytes itself moments
 * earlier. See this file's header for why both headers are minted.
 */
export function signedForwardHeaders(input: {
  readonly plan: SignPlan;
  readonly body: string;
  readonly secret: string;
  readonly nowMs: number;
  /** The absolute `--forward-to` URL, whose path goes into the v2 digest. */
  readonly targetUrl: string;
}): { ok: true; headers: Record<string, string> } | { ok: false; message: string } {
  const t = Math.floor(input.nowMs / 1000).toString();
  const { plan, body, secret, nowMs } = input;

  const legacy = tv1(body, secret, t);
  const legacyCheck = verifyChatlySignature({
    surface: plan.surface,
    body,
    headers: { [plan.legacyHeader]: legacy },
    secret,
    nowMs,
    // The v2 header is minted below and lives in the same bag on the wire;
    // this check is specifically of the LEGACY construction, so the policy
    // that would prefer v2 has to be off.
    v2: 'ignore',
  });
  if (!legacyCheck.ok) {
    return { ok: false, message: `${legacyCheck.reason}: ${legacyCheck.message}` };
  }

  const headers: Record<string, string> = { [plan.legacyHeader]: legacy };
  if (plan.timestampHeader !== null) {
    headers[plan.timestampHeader] = t;
  }

  /*
   * The unified v2 header. `method` is POST because that is what this
   * forwards, and `path` is the target's own path — the receiver verifies
   * the request IT received, so the path in the digest has to be the one on
   * that request line.
   */
  const path = chatlyV2SigningPath(input.targetUrl);
  if (path === null) {
    return { ok: false, message: `--forward-to "${input.targetUrl}" is not a URL` };
  }
  /*
   * Through the shared signer, so this emits the `b=t` base marker.
   *
   * It used to build the value by hand, and its own docblock said "the
   * platform does not send this on either surface yet" — which is now false
   * for both. Worse, a hand-rolled value carries no marker, and an absent
   * marker means the LEGACY `<t>.<rawBody>` construction: a receiver reading
   * `b=` to decide what to verify would have been told, by the one tool whose
   * job is to rehearse production, that the unified base is the body base.
   *
   * From `@chatlychat/sdk-node`, NOT from `@livechat/shared`. This package
   * builds with plain `tsc` and publishes `dist` declaring only the SDK, so
   * an import of the internal scope would emit a reference to a package that
   * is not on npm and `npm i -g @chatlychat/cli` would fail at run time with
   * MODULE_NOT_FOUND — a break no test here would see, because in the
   * monorepo the import resolves. The SDK's copy is held byte-for-byte
   * against the one the API and worker send with by
   * `packages/shared/src/webhook-signature/v2.parity.spec.ts`, so this still
   * teaches exactly the shape production sends.
   */
  const v2 = signChatlyV2({
    base: 'target',
    secret,
    timestampSeconds: Number(t),
    method: 'POST',
    path,
    body,
  });
  const v2Check = verifyChatlySignature({
    surface: 'unified_v2',
    body,
    headers: { 'x-chatly-signature-v2': v2 },
    secret,
    method: 'POST',
    path,
    nowMs,
  });
  if (!v2Check.ok) {
    return { ok: false, message: `${v2Check.reason}: ${v2Check.message}` };
  }
  headers['x-chatly-signature-v2'] = v2;

  return { ok: true, headers };
}

/** One request to forward: already-built headers and the exact bytes. */
export interface ForwardRequest {
  /** The delivery id, for the log lines. */
  readonly id: string;
  readonly body: string;
  /** Everything but the signature headers, which this adds. */
  readonly headers: Record<string, string>;
  readonly plan: SignPlan;
}

/** POST one event on, verifying the headers we just minted before sending. */
export async function forward(
  opts: ListenOptions,
  deps: ListenDeps,
  req: ForwardRequest,
): Promise<boolean> {
  if (opts.forwardTo === null) {
    return false;
  }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...req.headers,
    // Not a header Chatly sends. A handler that logs it can tell a replayed
    // local forward from a real delivery, which matters the first time
    // somebody points this at a staging environment.
    'x-chatly-cli-forwarded': '1',
  };

  if (opts.secret !== null) {
    const signed = signedForwardHeaders({
      plan: req.plan,
      body: req.body,
      secret: opts.secret,
      nowMs: deps.now(),
      targetUrl: opts.forwardTo,
    });
    if (!signed.ok) {
      deps.err(
        `refusing to forward ${req.id}: the signature this CLI minted does not verify ` +
          `(${signed.message}). This is a bug in chatly listen, not in your handler — ` +
          'please report it.\n',
      );
      return false;
    }
    Object.assign(headers, signed.headers);
  }

  try {
    const res = await deps.fetchFn(opts.forwardTo, {
      method: 'POST',
      headers,
      body: req.body,
      signal: deps.signal,
    });
    if (!res.ok) {
      deps.err(
        `   ↳ ${opts.forwardTo} answered ${String(res.status)}. ` +
          (res.status === 401 || res.status === 403
            ? 'That is usually signature verification — check --secret matches the endpoint.\n'
            : '\n'),
      );
      return false;
    }
    deps.out(`   ↳ ${String(res.status)} from ${opts.forwardTo}`);
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    deps.err(
      `   ↳ ${opts.forwardTo} unreachable: ${reason}. Is your server running on that port?\n`,
    );
    return false;
  }
}

function parseEventFilter(args: ParsedArgs): ReadonlySet<string> | null {
  const raw = args.flags['event'];
  if (raw === undefined) {
    return null;
  }
  const list = (Array.isArray(raw) ? raw : [String(raw)]).flatMap((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
  return list.length === 0 ? null : new Set(list);
}

/**
 * Read the flags, refusing anything that cannot work, with the fix named.
 *
 * The two secret prefixes are the one refusal worth reading twice: a webhook
 * endpoint's secret is `whsec_` and an external agent's is `chsec_`, they are
 * minted by different routes, and neither verifies the other's traffic. The
 * symptom of crossing them is a 401 from your own handler, which looks
 * exactly like a verifier bug.
 */
export function parseListenOptions(args: ParsedArgs): ListenOptions {
  const forwardTo = str(args.flags, 'forward-to') ?? null;
  if (forwardTo !== null) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(forwardTo);
    } catch {
      parsed = null;
    }
    /*
     * One message for both failures, because `localhost:3000` — the mistake
     * everyone makes — hits the SECOND branch, not the first: the WHATWG
     * parser reads `localhost:` as a SCHEME and succeeds. A test caught this
     * command telling a developer who typed `localhost:3000` that the scheme
     * `"localhost:"` was unsupported, which is true and useless.
     */
    if (parsed === null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      throw new Error(
        `--forward-to "${forwardTo}" is not an http(s) URL${
          parsed === null ? '' : ` (it parsed as the scheme "${parsed.protocol}")`
        }. Include the scheme:\n` + '  chatly listen --forward-to http://localhost:3000/webhooks',
      );
    }
  }

  const botId = str(args.flags, 'bot') ?? null;
  const endpointId = str(args.flags, 'endpoint') ?? null;
  if (botId !== null && endpointId !== null) {
    throw new Error(
      '--bot and --endpoint tail different ledgers and cannot be combined. --bot <id> tails one ' +
        "external agent's push deliveries; --endpoint <id> tails one webhook subscription's.",
    );
  }

  const intervalSeconds = num(args.flags, 'interval') ?? DEFAULT_INTERVAL_SECONDS;
  if (intervalSeconds < MIN_INTERVAL_SECONDS) {
    throw new Error(
      `--interval ${String(intervalSeconds)} is below the ${String(MIN_INTERVAL_SECONDS)}s floor. ` +
        'This polls a real API on your own rate limit; a tighter loop buys nothing, because the ' +
        'delivery row is written after the attempt completes.',
    );
  }

  const pageLimit = num(args.flags, 'limit') ?? DEFAULT_PAGE_LIMIT;
  if (pageLimit < 1) {
    throw new Error(`--limit ${String(pageLimit)} must be at least 1.`);
  }

  const replay = num(args.flags, 'replay') ?? 0;
  if (replay < 0) {
    throw new Error(`--replay ${String(replay)} cannot be negative.`);
  }
  if (replay > pageLimit) {
    throw new Error(
      `--replay ${String(replay)} is more than --limit ${String(pageLimit)}, and this command ` +
        'only ever reads one page per poll. Raise --limit to match.',
    );
  }

  const status = str(args.flags, 'status') ?? null;
  if (botId !== null && status !== null && !DELIVERY_STATUSES.includes(status as never)) {
    // The route validates this against a zod enum and answers 400, not an
    // empty page. Refusing here names the four words.
    throw new Error(
      `--status "${status}" is not one of ${DELIVERY_STATUSES.join(', ')}. ` +
        '`failed` will be retried; `dead` will not.',
    );
  }

  const secret = str(args.flags, 'secret') ?? null;
  if (secret !== null && botId === null && !secret.startsWith('whsec_')) {
    throw new Error(
      `--secret should be the endpoint's whsec_ signing secret (got "${secret.slice(0, 6)}…").\n` +
        'It is returned exactly once, by `chatly webhooks create`, and by no other route — if ' +
        'you no longer have it, create another endpoint.\n' +
        "With --bot, pass the AGENT's chsec_ secret instead; the two do not verify each other's " +
        'traffic.',
    );
  }
  if (secret !== null && botId !== null && !secret.startsWith('chsec_')) {
    throw new Error(
      `--secret should be the external agent's chsec_ signing secret (got "${secret.slice(
        0,
        6,
      )}…").\n` +
        'It is shown once by `chatly bots create` and once by `chatly bots rotate-secret <id>`, ' +
        'and no read route returns it.\n' +
        "A webhook endpoint's whsec_ secret signs a different surface and will not verify here.",
    );
  }

  return {
    forwardTo,
    botId,
    endpointId,
    events: parseEventFilter(args),
    status,
    secret,
    intervalMs: intervalSeconds * 1000,
    replay,
    pageLimit,
    json: bool(args.flags, 'json'),
  };
}

/** An abortable sleep, so Ctrl-C does not wait out the poll interval. */
export function sleepUntilAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
