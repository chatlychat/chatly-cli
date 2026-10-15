/**
 * `chatly listen` — watch this workspace's outbound traffic and forward it to
 * a local URL.
 *
 * Two ledgers: webhook subscriptions by default, and one external agent's
 * push deliveries with `--bot <id>` (`listen-bot.ts`). And one live mode,
 * `--relay` (`listen-relay.ts`), for the three synchronous surfaces no ledger
 * can carry — whose server half is `apps/api/src/modules/relay/`, built against
 * `RELAY-SERVER-SPEC.md`. Everything the two ledgers share
 * — the flags, the seen-set, the signing and the forward leg — is in
 * `listen-core.ts`, which also records what the minted signature is and is
 * not.
 *
 * ═══ HOW A LAPTOP RECEIVES EVENTS AT ALL ══════════════════════════════════
 *
 * Chatly delivers webhooks by POSTing to a URL, so a machine behind NAT cannot
 * be a destination. Three ways out were considered and only one of them is
 * real with a `ck_` workspace key:
 *
 *  **(a) Poll the delivery log. This is what this command does.**
 *  `GET /v1/webhooks/deliveries` records one row per attempt — event type,
 *  payload, attempt number, HTTP status, latency, error, next retry — and is
 *  open to a `ck_` key (`@AllowApiKey()` on `WebhookDeliveriesController`,
 *  `integrations:read`), keyset-paginated newest-first on `created_at`, with
 *  `endpointId` and `status` filters. `GET /v1/webhooks/deliveries/{id}`
 *  returns the exact payload we POSTed. Both verified against their handlers,
 *  because a route list in this repo has been wrong in both directions.
 *
 *  **(b) Subscribe over the realtime socket. Not possible.**
 *  `apps/realtime/src/gateway.ts` accepts exactly two credentials in its
 *  handshake: an agent RS256 access token or a visitor HS256 token. A
 *  workspace API key is neither, and there is no key-accessible route that
 *  mints either one. The realtime envelope vocabulary is also not the webhook
 *  catalogue — it is the dashboard's own event stream, with a different shape
 *  and a different subscription model.
 *
 *  **(c) Register a temporary subscription and deregister on exit. Not
 *  possible either, and this is the finding worth writing down.**
 *  `POST /v1/webhooks` carries `@AllowApiKey()`. `DELETE /v1/webhooks/{id}`
 *  does **not** — it is the one route on that controller without it, so a key
 *  gets a 403. A CLI that registered an endpoint could therefore never remove
 *  it, and `listen` would leak a subscription into the customer's workspace on
 *  every run, with no key-accessible way to disable it either (there is no
 *  enable/disable route; the only PATCH moves the schema pin). So **this
 *  command registers nothing and has nothing to clean up** — stated in its own
 *  startup banner, because "what did that leave behind" is the first question
 *  a developer tool of this shape has to answer.
 *
 * ═══ THE THREE SURFACES THIS STILL CANNOT SHOW ════════════════════════════
 *
 * AI tool calls, customer-card fetches and canvas/step requests are
 * **synchronous**: Chatly calls out and waits for the answer inside a
 * visitor's request. There is no ledger to poll, because the response is the
 * point — a log row would arrive after the visitor has already been told
 * something went wrong. Relaying them needs a server-side surface that holds
 * the inbound request open while a locally connected CLI answers it, which is
 * a route and a socket in `apps/api`, not something this poller can fake.
 * Written up in the C-01 report rather than half-built here.
 *
 * ═══ WHAT THIS CANNOT DO, AND THE ROUTE THAT WOULD FIX IT ═════════════════
 *
 * It cannot relay Chatly's OWN signature, because the server does not keep
 * it. `webhook_deliveries` stores `payload` as `jsonb` and that is all: the
 * signature is computed per attempt from the endpoint's secret and never
 * persisted, the secret is returned by exactly one route and never read back,
 * `jsonb` does not preserve key order, and the signed envelope's `id` is the
 * BullMQ-era `deliveryId` which is not the delivery row's `id`. So the exact
 * signed bytes are unreconstructable by construction, not by omission. The
 * same is true of `agent_deliveries`.
 *
 * A true `stripe listen` — the developer's handler seeing byte-for-byte what
 * production sends — needs a server-side surface, and there are two shapes:
 *
 *   1. `GET /v1/webhooks/tail` as Server-Sent Events: `@AllowApiKey()`,
 *      `integrations:read`, emitting `{ id, type, signedBody, signature }`
 *      from the same `signWebhookPayload` the dispatcher uses. Best for the
 *      use case; needs a streaming route and a fan-out off the webhook queue.
 *   2. Cheaper: add `signed_body text` and `signature text` to
 *      `webhook_deliveries` (and `agent_deliveries`), return them from the
 *      per-delivery read, and this poller relays them untouched. One
 *      migration, two columns, no new route shape.
 *
 * Both are in `apps/api`, `apps/worker` and `packages/db`, so neither is done
 * here. Until one lands, this command is honest about what it mints.
 */
import { tailBot } from './listen-bot.js';
import {
  WEBHOOK_SIGN_PLAN,
  forward,
  parseListenOptions,
  remember,
  sleepUntilAborted,
  type ListenDeps,
  type ListenOptions,
  type ListenSummary,
} from './listen-core.js';
import { parseRelayOptions, relay, relayOnlyFlagWithoutRelay } from './listen-relay.js';
import { bool, type ParsedArgs } from '../args.js';
import { printJson } from '../output.js';

import type { ChatlyClient } from '@chatlychat/sdk-node';

export {
  parseListenOptions,
  type ListenDeps,
  type ListenOptions,
  type ListenSummary,
} from './listen-core.js';

/** One `GET /v1/webhooks` row, as `endpointListItemSchema` renders it. */
interface EndpointRow {
  readonly id?: unknown;
  readonly url?: unknown;
  readonly eventTypes?: unknown;
  readonly enabled?: unknown;
}

/** One `webhook_deliveries` row, as the list renders it. */
interface DeliveryRow {
  readonly id: string;
  readonly endpointId: string;
  readonly eventType: string;
  readonly attempt: number;
  readonly status: string;
  readonly httpStatus: number | null;
  readonly createdAt: string;
  readonly error: string | null;
}

/** The detail read adds the two fields the list omits. */
interface DeliveryDetail extends DeliveryRow {
  readonly payload: Record<string, unknown>;
  readonly url: string;
}

function asRows(value: unknown): DeliveryRow[] {
  const items =
    typeof value === 'object' && value !== null ? (value as { items?: unknown }).items : undefined;
  if (!Array.isArray(items)) {
    return [];
  }
  return items.filter((row): row is DeliveryRow => {
    if (typeof row !== 'object' || row === null) {
      return false;
    }
    const r = row as Record<string, unknown>;
    return typeof r['id'] === 'string' && typeof r['eventType'] === 'string';
  });
}

/**
 * Which endpoints this will see traffic from, and the refusal when there are
 * none.
 *
 * The empty case is the one worth getting right: a developer running
 * `chatly listen` with no subscription configured sees an empty tail forever
 * and concludes the command is broken, when the real answer is that no event
 * has ever been dispatched to this workspace. So it is an error naming the
 * command that fixes it.
 */
async function resolveEndpoints(chatly: ChatlyClient, opts: ListenOptions): Promise<EndpointRow[]> {
  const endpoints = await chatly.request<unknown>('GET', '/v1/webhooks');
  const rows = Array.isArray(endpoints) ? (endpoints as EndpointRow[]) : [];
  if (rows.length === 0) {
    throw new Error(
      'This workspace has no webhook subscriptions, so nothing is ever dispatched and the\n' +
        'delivery log this command tails will stay empty.\n\n' +
        'Create one first:\n' +
        '  chatly webhooks create --url https://example.test/hook --event conversation.created\n' +
        '`chatly webhooks events` lists the subscribable names.\n\n' +
        'The URL has to be one the platform can reach — it is the real destination, and this\n' +
        'command tails what was attempted against it rather than replacing it.\n\n' +
        "To tail an external agent's push deliveries instead, use `chatly listen --bot <id>`.",
    );
  }
  if (opts.endpointId !== null) {
    const match = rows.find((r) => r.id === opts.endpointId);
    if (match === undefined) {
      throw new Error(
        `No webhook endpoint "${opts.endpointId}" in this workspace. The ids are:\n` +
          rows.map((r) => `  ${String(r.id)}  ${String(r.url)}`).join('\n'),
      );
    }
    return [match];
  }
  return rows;
}

/**
 * The startup banner.
 *
 * It says what was registered (nothing) and what the signature is (minted
 * here), because both are things a developer would otherwise have to read
 * this file to find out — and the second one changes how they should read a
 * passing verification in their own handler.
 */
function banner(opts: ListenOptions, endpoints: readonly EndpointRow[], deps: ListenDeps): void {
  deps.out(
    `Tailing ${String(endpoints.length)} webhook endpoint(s) via the delivery log, ` +
      `every ${String(opts.intervalMs / 1000)}s.`,
  );
  for (const e of endpoints) {
    const types = Array.isArray(e.eventTypes) ? e.eventTypes.length : 0;
    deps.out(
      `  ${String(e.id)}  ${String(e.url)}  ${String(types)} event type(s)` +
        (e.enabled === false ? '  [DISABLED — it receives nothing]' : ''),
    );
  }
  if (opts.events !== null) {
    deps.out(
      `Filtering to: ${[...opts.events].join(', ')}  ` +
        '(client-side — an event no endpoint subscribes to never reaches the log at all)',
    );
  }
  deps.out(
    opts.forwardTo === null
      ? 'Printing only. Pass --forward-to http://localhost:PORT/path to POST each event on.'
      : `Forwarding to ${opts.forwardTo}`,
  );
  if (opts.forwardTo !== null) {
    deps.out(
      opts.secret === null
        ? 'UNSIGNED: no --secret, so forwarded requests carry no x-livechat-signature and your ' +
            "handler's verifier will reject them. Pass the endpoint's whsec_ secret."
        : 'Signed locally with --secret, as x-livechat-signature AND x-chatly-signature-v2. ' +
            'This is NOT the signature Chatly sent — the delivery log does not store one — so ' +
            'it proves nothing about the original request.',
    );
  }
  deps.out('Registers nothing on the server; there is nothing to clean up. Ctrl-C to stop.\n');
}

/**
 * The tail loop, abortable, with the process boundary left to the caller.
 *
 * Exported so the spec can drive it with a bounded `maxPolls` and a scripted
 * fetch, rather than racing a timer against a signal handler.
 */
export async function tail(
  chatly: ChatlyClient,
  opts: ListenOptions,
  deps: ListenDeps,
): Promise<ListenSummary> {
  const endpoints = await resolveEndpoints(chatly, opts);
  banner(opts, endpoints, deps);

  const query: Record<string, string | number> = { limit: opts.pageLimit };
  if (opts.endpointId !== null) {
    query['endpointId'] = opts.endpointId;
  }
  if (opts.status !== null) {
    query['status'] = opts.status;
  }

  const seen = new Set<string>();
  let seenCount = 0;
  let forwarded = 0;
  let refused = 0;
  let polls = 0;

  /*
   * The baseline. Without it, the first poll replays everything already in
   * the log — which for a busy workspace is `--limit` surprise POSTs at a
   * handler the developer just started. `--replay N` deliberately leaves the
   * newest N rows unseen, which is the "show me the last few" case.
   */
  const firstPage = asRows(
    await chatly.request<unknown>('GET', '/v1/webhooks/deliveries', { query }),
  );
  for (const row of firstPage.slice(opts.replay)) {
    remember(seen, row.id);
  }
  if (opts.replay > 0) {
    deps.out(`Replaying the ${String(Math.min(opts.replay, firstPage.length))} most recent.\n`);
  }

  const matches = (row: DeliveryRow): boolean =>
    opts.events === null || opts.events.has(row.eventType);

  for (;;) {
    if (deps.signal.aborted) {
      break;
    }
    if (deps.maxPolls !== undefined && polls >= deps.maxPolls) {
      break;
    }
    polls += 1;

    /*
     * The first poll REUSES the baseline page rather than asking again. Two
     * identical requests back to back is one more than the rate limit needs
     * to see, and with `--replay` the baseline page is exactly what has to be
     * replayed — so there is no case where re-reading it is right.
     */
    const page =
      polls === 1
        ? firstPage
        : asRows(await chatly.request<unknown>('GET', '/v1/webhooks/deliveries', { query }));

    // Newest-first off the wire; replay in the order they happened.
    const fresh = page.filter((row) => !seen.has(row.id)).reverse();
    /*
     * Poll 1 is exempt: it is the baseline page, not a window this loop could
     * have overflowed, and with `--replay N` its `fresh` rows are new on
     * purpose. From poll 2 on, a FULL page with nothing already seen on it
     * means ≥ --limit deliveries landed since the last look and some are gone
     * from the window.
     */
    if (polls > 1 && fresh.length === page.length && page.length === opts.pageLimit) {
      /*
       * Every row on a FULL page was new, so the window may have overflowed
       * between polls and some deliveries were never seen. This command reads
       * one page per poll by design — walking the cursor backwards on every
       * tick would re-read the whole log — so the honest thing is to say it.
       */
      deps.err(
        `warning: all ${String(opts.pageLimit)} rows on this page were new, so events may have ` +
          'been missed between polls. Use a shorter --interval or a larger --limit.\n',
      );
    }

    for (const row of fresh) {
      remember(seen, row.id);
      if (!matches(row)) {
        continue;
      }
      seenCount += 1;
      const detail = await chatly.request<DeliveryDetail>(
        'GET',
        `/v1/webhooks/deliveries/${encodeURIComponent(row.id)}`,
      );
      /*
       * The envelope the worker signs is `{ id, type, payload }`. `id` here
       * is the DELIVERY ROW's id, not the `deliveryId` that was in the
       * original signed body — that value is not stored anywhere readable. It
       * is still stable per attempt, which is what a handler deduping on it
       * needs.
       */
      const envelope = { id: row.id, type: row.eventType, payload: detail.payload };
      if (opts.json) {
        printJson({ ...envelope, delivery: row });
      } else {
        const http = row.httpStatus === null ? '—' : String(row.httpStatus);
        deps.out(
          `${row.eventType}  ${row.id}  attempt ${String(row.attempt)}  ${row.status}  ` +
            `http ${http}  ${row.createdAt}` +
            (row.error === null ? '' : `  (${row.error})`),
        );
      }
      if (opts.forwardTo !== null) {
        const sent = await forward(opts, deps, {
          id: row.id,
          body: JSON.stringify(envelope),
          headers: {
            'x-livechat-event': envelope.type,
            'x-livechat-delivery': envelope.id,
          },
          plan: WEBHOOK_SIGN_PLAN,
        });
        if (sent) {
          forwarded += 1;
        } else {
          refused += 1;
        }
      }
    }

    if (deps.maxPolls !== undefined && polls >= deps.maxPolls) {
      break;
    }
    await deps.sleep(opts.intervalMs, deps.signal);
  }

  return { seen: seenCount, forwarded, refused, polls };
}

/**
 * The command entry point.
 *
 * SIGINT and SIGTERM abort the loop rather than killing the process, so the
 * summary still prints and the exit code is 0 — a developer tool stopped on
 * purpose did not fail.
 */
export async function listen(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const relayMode = bool(args.flags, 'relay');
  if (!relayMode) {
    /*
     * `--tool` on a ledger tail would be silently ignored, and the developer
     * would wait for a tool call that the ledger can never contain.
     */
    const stray = relayOnlyFlagWithoutRelay(args);
    if (stray !== null) {
      throw new Error(
        `--${stray} selects a target for --relay, and no ledger records those calls. Did you ` +
          `mean:\n  chatly listen --relay --${stray} <id> --forward-to http://localhost:3000`,
      );
    }
  }
  // Parse BEFORE installing signal handlers, so a refusal leaves none behind.
  const relayOpts = relayMode ? parseRelayOptions(args) : null;
  const opts = relayMode ? null : parseListenOptions(args);
  const controller = new AbortController();
  const stop = (): void => {
    controller.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const deps: ListenDeps = {
    fetchFn: globalThis.fetch.bind(globalThis),
    now: () => Date.now(),
    sleep: sleepUntilAborted,
    signal: controller.signal,
    out: (line) => {
      process.stdout.write(`${line}\n`);
    },
    err: (line) => {
      process.stderr.write(line);
    },
  };

  try {
    if (relayOpts !== null) {
      const r = await relay(chatly, relayOpts, deps);
      process.stdout.write(
        `\nDetached (${r.endReason}). ${String(r.frames)} call(s) relayed, ` +
          `${String(r.answered)} answered by your handler, ${String(r.failed)} not.\n`,
      );
      // The server ending a relay the developer did not ask to end is a failure.
      return r.endReason === 'interrupted' || r.endReason === 'idle' ? 0 : 1;
    }
    if (opts === null) {
      throw new Error('unreachable: neither relay nor ledger options were parsed');
    }
    const summary =
      opts.botId === null ? await tail(chatly, opts, deps) : await tailBot(chatly, opts, deps);
    process.stdout.write(
      `\nStopped. ${String(summary.seen)} event(s) seen` +
        (opts.forwardTo === null
          ? '.\n'
          : `, ${String(summary.forwarded)} forwarded, ${String(summary.refused)} not.\n`),
    );
    return 0;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
