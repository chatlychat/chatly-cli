/**
 * `chatly listen --bot <id>` — tail one external agent's push deliveries.
 *
 * ═══ WHY THIS IS A SECOND LOOP AND NOT A FLAG ON THE FIRST ════════════════
 *
 * It is a different ledger with a different row shape, a different signature
 * header and a different secret:
 *
 *   | | webhook subscription | external agent |
 *   | --- | --- | --- |
 *   | ledger | `GET /v1/webhooks/deliveries` | `GET /v1/bots/{id}/deliveries` |
 *   | row names the event | `eventType` (`conversation.created`) | `kind` (`message`, sent as `agent.message`) |
 *   | signature header | `x-livechat-signature` | `x-chatly-signature` |
 *   | secret | the endpoint's `whsec_` | the bot's `chsec_` |
 *   | permission | `integrations:read` | `triggers:read` |
 *
 * Both routes were read against their handlers before this was written —
 * `AgentDeliveriesController` carries `@AllowApiKey()` and
 * `@RequirePermission('triggers:read')` on the list and on the per-delivery
 * read, so a `ck_` key can poll both. A route list in this repo has been
 * wrong in both directions, so neither was taken on trust.
 *
 * ── What the ledger can and cannot give a developer ──────────────────────
 *
 * The payload on a row is the exact OBJECT that was serialised and signed —
 * `agent_deliveries.payload` is `jsonb`, written once and re-sent byte for
 * byte on every retry so that dedupe-by-`eventId` compares equal. What is not
 * stored is the signature, and `jsonb` does not preserve key order, so the
 * forwarded bytes here are a re-serialisation and the signature is minted
 * locally from `--secret`. `listen-core.ts` says what that is worth.
 *
 * One thing this ledger has that the webhook one does not: the delivery row's
 * `id` IS the `eventId` inside the payload. So `x-chatly-delivery-id` on a
 * forwarded request carries the same value the real delivery carried, and a
 * handler deduping on it behaves exactly as it will in production.
 *
 * ── The three synchronous surfaces ───────────────────────────────────────
 *
 * AI tool calls, customer-card fetches and canvas/step requests are
 * synchronous and have no ledger at all. `--relay` (`listen-relay.ts`) is
 * the answer for those; `RELAY-SERVER-SPEC.md` is its contract.
 */
import {
  AGENT_SIGN_PLAN,
  forward,
  remember,
  type ListenDeps,
  type ListenOptions,
  type ListenSummary,
} from './listen-core.js';
import { printJson } from '../output.js';

import type { ChatlyClient } from '@chatlychat/sdk-node';

/** `GET /v1/bots/{id}`, as `botDtoSchema` renders it — the fields used here. */
interface BotRow {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly slug?: unknown;
  readonly type?: unknown;
  readonly externalAgent?: {
    readonly webhookUrl?: unknown;
    readonly timeoutSeconds?: unknown;
    readonly signingSecretSet?: unknown;
  } | null;
}

/** One `agent_deliveries` row, as `agentDeliveryItemSchema` renders it. */
interface AgentDeliveryRow {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly attempt: number;
  readonly httpStatus: number | null;
  readonly durationMs: number | null;
  readonly error: string | null;
  readonly conversationId: string;
  readonly createdAt: string;
}

interface AgentDeliveryDetail extends AgentDeliveryRow {
  /** `unknown`, because a row written before a payload key existed carries the shape of that day. */
  readonly payload: unknown;
}

/** The resolved agent, proved to be one that can receive a delivery. */
interface ResolvedBot {
  readonly id: string;
  readonly name: string;
  /** What goes in `x-chatly-bot`: the slug if it has one, else the id. */
  readonly ref: string;
  readonly webhookUrl: string;
  readonly signingSecretSet: boolean;
}

function asRows(value: unknown): AgentDeliveryRow[] {
  const items =
    typeof value === 'object' && value !== null ? (value as { items?: unknown }).items : undefined;
  if (!Array.isArray(items)) {
    return [];
  }
  return items.filter((row): row is AgentDeliveryRow => {
    if (typeof row !== 'object' || row === null) {
      return false;
    }
    const r = row as Record<string, unknown>;
    return typeof r['id'] === 'string' && typeof r['kind'] === 'string';
  });
}

/**
 * Read the bot and refuse the two states in which nothing can ever arrive.
 *
 * A Chatly persona has no ledger at all — nothing is pushed anywhere, so the
 * route 404s — and an external agent with no `webhookUrl` is never dispatched
 * to. Both are a tail that stays empty forever, which reads as a broken
 * command, so both are errors naming the command that fixes them.
 */
async function resolveBot(chatly: ChatlyClient, botId: string): Promise<ResolvedBot> {
  const bot = await chatly.request<BotRow>('GET', `/v1/bots/${encodeURIComponent(botId)}`);
  if (bot.type !== 'external' || bot.externalAgent === null || bot.externalAgent === undefined) {
    throw new Error(
      `Bot ${botId} is a Chatly persona, not an external agent, so it has no delivery ledger —\n` +
        'nothing is pushed anywhere for it. `chatly bots list` shows the type of each bot; only\n' +
        'a `type: "external"` one receives signed POSTs you can tail.',
    );
  }
  const webhookUrl = bot.externalAgent.webhookUrl;
  if (typeof webhookUrl !== 'string' || webhookUrl.length === 0) {
    throw new Error(
      `External agent ${botId} has no webhookUrl, so no delivery is ever attempted and this\n` +
        'ledger will stay empty. Set one first:\n' +
        `  chatly bots update-external ${botId} --body '{"webhookUrl":"https://example.test/agent"}'\n\n` +
        'That URL is the real destination. This command tails what was attempted against it\n' +
        'rather than replacing it.',
    );
  }
  const id = typeof bot.id === 'string' ? bot.id : botId;
  const slug = typeof bot.slug === 'string' && bot.slug.length > 0 ? bot.slug : null;
  return {
    id,
    name: typeof bot.name === 'string' ? bot.name : botId,
    // The worker sends `bot.slug ?? bot.id`; mirroring it means a handler
    // that routes on this header sees the same value it sees in production.
    ref: slug ?? id,
    webhookUrl,
    signingSecretSet: bot.externalAgent.signingSecretSet === true,
  };
}

function banner(opts: ListenOptions, bot: ResolvedBot, deps: ListenDeps): void {
  deps.out(
    `Tailing the delivery ledger of "${bot.name}" (${bot.id}), ` +
      `every ${String(opts.intervalMs / 1000)}s.`,
  );
  deps.out(`  real destination: ${bot.webhookUrl}`);
  if (!bot.signingSecretSet) {
    // A real delivery is signed with a secret this agent does not have, so
    // the ledger will stay empty for a reason that is not this command's.
    deps.out(
      '  [NO SIGNING SECRET SET — the platform cannot sign a delivery to this agent. ' +
        `Run \`chatly bots rotate-secret ${bot.id}\`.]`,
    );
  }
  if (opts.status !== null) {
    deps.out(`  only status=${opts.status}  (server-side; failed will be retried, dead will not)`);
  }
  if (opts.events !== null) {
    deps.out(
      `Filtering to: ${[...opts.events].join(', ')}  ` +
        '(client-side, on the delivery `kind` — `message` and `agent.message` both match)',
    );
  }
  deps.out(
    opts.forwardTo === null
      ? 'Printing only. Pass --forward-to http://localhost:PORT/path to POST each delivery on.'
      : `Forwarding to ${opts.forwardTo}`,
  );
  if (opts.forwardTo !== null) {
    deps.out(
      opts.secret === null
        ? 'UNSIGNED: no --secret, so forwarded requests carry no x-chatly-signature and your ' +
            "agent's verifier will reject them. Pass the agent's chsec_ secret."
        : 'Signed locally with --secret, as x-chatly-signature AND x-chatly-signature-v2. ' +
            'This is NOT the signature Chatly sent — the ledger does not store one, and the ' +
            'payload is re-serialised out of jsonb — so it proves nothing about the original ' +
            'request.',
    );
  }
  deps.out('Registers nothing on the server; there is nothing to clean up. Ctrl-C to stop.\n');
}

/**
 * Does this row match `--event`?
 *
 * Both spellings, because the row says `message` and the wire header says
 * `agent.message`, and a developer reading their own logs has seen the second
 * one. Refusing the spelling they have is a worse answer than accepting both.
 */
function matchesEvent(opts: ListenOptions, row: AgentDeliveryRow): boolean {
  if (opts.events === null) {
    return true;
  }
  return opts.events.has(row.kind) || opts.events.has(`agent.${row.kind}`);
}

/**
 * The tail loop for one agent's ledger.
 *
 * Exported for the spec, and bounded by `deps.maxPolls` for the same reason
 * the webhook loop is.
 */
export async function tailBot(
  chatly: ChatlyClient,
  opts: ListenOptions,
  deps: ListenDeps,
): Promise<ListenSummary> {
  const botId = opts.botId;
  if (botId === null) {
    throw new Error('tailBot needs --bot <id>');
  }
  const bot = await resolveBot(chatly, botId);
  banner(opts, bot, deps);

  const path = `/v1/bots/${encodeURIComponent(botId)}/deliveries`;
  const query: Record<string, string | number> = { limit: opts.pageLimit };
  if (opts.status !== null) {
    query['status'] = opts.status;
  }
  /*
   * No `sort`. The route accepts `createdAt` only — not `id`, because this
   * table's ids are `gen_random_uuid()` (v4, not v7), so ordering by id is
   * ordering by nothing — and `createdAt` descending is already the default.
   * Sending it would be one more thing to get wrong.
   */

  const seen = new Set<string>();
  let seenCount = 0;
  let forwarded = 0;
  let refused = 0;
  let polls = 0;

  // The baseline, for the reason the webhook loop has one: without it the
  // first poll POSTs everything already in the ledger at a handler the
  // developer has just started.
  const firstPage = asRows(await chatly.request<unknown>('GET', path, { query }));
  for (const row of firstPage.slice(opts.replay)) {
    remember(seen, row.id);
  }
  if (opts.replay > 0) {
    deps.out(`Replaying the ${String(Math.min(opts.replay, firstPage.length))} most recent.\n`);
  }

  for (;;) {
    if (deps.signal.aborted) {
      break;
    }
    if (deps.maxPolls !== undefined && polls >= deps.maxPolls) {
      break;
    }
    polls += 1;

    const page =
      polls === 1 ? firstPage : asRows(await chatly.request<unknown>('GET', path, { query }));

    // Newest-first off the wire; replay in the order they happened.
    const fresh = page.filter((row) => !seen.has(row.id)).reverse();
    if (polls > 1 && fresh.length === page.length && page.length === opts.pageLimit) {
      deps.err(
        `warning: all ${String(opts.pageLimit)} rows on this page were new, so deliveries may ` +
          'have been missed between polls. Use a shorter --interval or a larger --limit.\n',
      );
    }

    for (const row of fresh) {
      remember(seen, row.id);
      if (!matchesEvent(opts, row)) {
        continue;
      }
      seenCount += 1;
      const detail = await chatly.request<AgentDeliveryDetail>(
        'GET',
        `${path}/${encodeURIComponent(row.id)}`,
      );
      /*
       * The payload is forwarded AS THE WHOLE BODY, not wrapped in an
       * envelope. That is what the real delivery POSTs — the external-agent
       * protocol has no outer `{id,type,payload}` wrapper — and wrapping it
       * here would mean a handler that works against this CLI fails against
       * production.
       */
      const body = JSON.stringify(detail.payload ?? {});
      if (opts.json) {
        printJson({ delivery: row, payload: detail.payload });
      } else {
        const http = row.httpStatus === null ? '—' : String(row.httpStatus);
        const ms = row.durationMs === null ? '—' : `${String(row.durationMs)}ms`;
        deps.out(
          `agent.${row.kind}  ${row.id}  attempt ${String(row.attempt)}  ${row.status}  ` +
            `http ${http}  ${ms}  ${row.createdAt}` +
            (row.error === null ? '' : `  (${row.error})`),
        );
      }
      if (opts.forwardTo !== null) {
        const sent = await forward(opts, deps, {
          id: row.id,
          body,
          headers: {
            // The five headers the worker sends beside the signature.
            'x-chatly-event': `agent.${row.kind}`,
            'x-chatly-bot': bot.ref,
            /*
             * The worker sends `attempt + 1`, the number of the request it is
             * making, where the column counts attempts already MADE. Here the
             * attempts have already happened, so the faithful value for the
             * last one is the column itself — floored at 1, because a
             * `pending` row has made none and `0` is not a request number.
             */
            'x-chatly-attempt': String(Math.max(1, row.attempt)),
            // The ledger id IS the `eventId` in the payload, so this is the
            // same value the real delivery carried.
            'x-chatly-delivery-id': row.id,
          },
          plan: AGENT_SIGN_PLAN,
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
