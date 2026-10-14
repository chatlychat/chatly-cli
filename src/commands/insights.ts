/**
 * Numbers without opening the dashboard: reports, billing and usage.
 *
 * ── The window is NOT the same on every report, and that was a live bug ──
 *
 * These commands used to pass `--from`/`--to` to every report. Three of the
 * four they covered do not read them: `reports/overview`, `reports/agents`
 * and `reports/conversations-by-day` take `@Query('days')` and nothing else,
 * so `chatly reports overview --from 2026-01-01 --to 2026-02-01` answered for
 * the last SEVEN days and said nothing about it. That is the zod-strips-an-
 * unknown-key failure in its query form: a confident report of the wrong
 * window.
 *
 * So the window flags differ per report, deliberately, and each group below
 * says which it accepts:
 *
 *   --days                       overview, agents, conversations-by-day,
 *                                sources, response-times, voice, attribution
 *   --weeks                      cohorts, and ONLY cohorts
 *   --date                       themes
 *   --from --to --days --group-by  teams, labels, sla   (`reports-extended`)
 *
 * The last group is the only one that resolves a real range, and its two
 * snake_case names (`group_by`, `business_hours`) are the only snake_case
 * query parameters on the whole SDK surface.
 */
import { ATTRIBUTION_DIMENSIONS } from '@chatlychat/sdk-node';

import { bool, num, str, type ParsedArgs } from '../args.js';
import { printJson } from '../output.js';
import { DAYS, RANGE, need, queryFrom, showObject, showRows } from './common.js';

import type { ChatlyClient, UsageEventType } from '@chatlychat/sdk-node';

/**
 * The ten dimensions `reports/attribution` accepts.
 *
 * Listed here because the route REFUSES an unknown value rather than
 * defaulting to `utm_source` — a typo quietly answered as something else
 * would be a confident report of the wrong thing, and the caller would have
 * no way to notice. Printing the list on a refusal saves a round trip.
 */
/*
 * Imported from the SDK, not re-listed. This file kept its own copy of the
 * ten so it could print them on a refusal; the SDK now exports the array as
 * a value for exactly that, so there is one list in this dependency chain
 * instead of two.
 */

/** The four meters `billing/usage` and `billing/usage/daily` accept. */
const USAGE_EVENT_TYPES = [
  'conversation.opened',
  'message.sent.agent',
  'message.sent.bot',
  'ai.tokens',
] as const;

export async function reports(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const sub = args.path[1] ?? 'overview';
  const days = (): Record<string, string | number> =>
    queryFrom(args, DAYS) as Record<string, string | number>;

  switch (sub) {
    // ── `?days` only ──────────────────────────────────────────────────────
    case 'overview':
      return showObject(await chatly.reports.overview(days()));
    case 'agents':
      // A BARE ARRAY, and the latency figures here are MEANS. The
      // percentiles are on `reports response-times`.
      return showRows(args, await chatly.reports.agents(days()), [
        'userId',
        'name',
        'conversations',
        'messages',
        'csatAverage',
      ]);
    case 'conversations-by-day':
      // A bare array, and days with no conversations are ABSENT rather than
      // zero — a caller plotting a series has to fill the gaps itself.
      return showRows(args, await chatly.reports.conversationsByDay(days()), ['day', 'count']);
    case 'sources':
      return showRows(args, await chatly.request('GET', '/v1/reports/sources', { query: days() }), [
        'channelType',
        'channelId',
        'channelName',
        'conversations',
      ]);
    case 'response-times':
      // p50/p95 for first response and resolution. Percentiles are null when
      // `sampleSize` is 0, which is not the same as zero seconds.
      return showObject(
        await chatly.request('GET', '/v1/reports/response-times', { query: days() }),
      );
    case 'voice':
      // Rates are 0-1, not percentages, and `recordingStorage.exact: false`
      // means the byte total is part extrapolation.
      return showObject(await chatly.request('GET', '/v1/reports/voice', { query: days() }));

    // ── `?dimension` + `?days` ────────────────────────────────────────────
    case 'attribution': {
      const dimension = str(args.flags, 'dimension') ?? args.path[2];
      if (
        dimension !== undefined &&
        !(ATTRIBUTION_DIMENSIONS as readonly string[]).includes(dimension)
      ) {
        throw new Error(
          `--dimension must be one of: ${ATTRIBUTION_DIMENSIONS.join(', ')}.\n` +
            'The route refuses an unknown value rather than defaulting, so a typo ' +
            'cannot become a report of the wrong thing.',
        );
      }
      // The row with `value: null` is the UNTAGGED bucket and is a real row —
      // dropping it inflates every other percentage.
      return showRows(
        args,
        await chatly.request('GET', '/v1/reports/attribution', {
          query: { ...days(), ...(dimension === undefined ? {} : { dimension }) },
        }),
        ['value', 'conversations', 'closed', 'percentage'],
      );
    }

    // ── `?weeks`, and only `?weeks` ───────────────────────────────────────
    case 'cohorts': {
      /*
       * `weeks`, NOT `days`. A `--days` here would be stripped by the
       * handler's query read and the report would silently use its default
       * of 8 weeks. The response echoes the CLAMPED window it actually used
       * (2-26), which can differ from what was asked for — label axes off
       * the echo, not off the input.
       */
      const weeks = num(args.flags, 'weeks');
      return showObject(
        await chatly.request('GET', '/v1/reports/cohorts', {
          query: weeks === undefined ? {} : { weeks },
        }),
      );
    }

    // ── `?date` ───────────────────────────────────────────────────────────
    case 'themes':
      /*
       * A SNAPSHOT, generated by a daily worker job. There is no regenerate.
       * `batchDate` names the batch every row was measured over and is null
       * with an empty list when none has been generated. Rows omit
       * `conversationIds` — `reports theme-conversations <id>` serves those.
       */
      return showObject(
        await chatly.request('GET', '/v1/reports/themes', {
          query: queryFrom(args, [['date', 'date']]),
        }),
      );
    case 'theme-conversations':
      // An unknown or purged theme id answers 200 with an EMPTY list, not a
      // 404 — this route cannot tell the two apart, and neither can you.
      return showObject(
        await chatly.request(
          'GET',
          `/v1/reports/themes/${encodeURIComponent(need(args, 2, 'a theme id'))}/conversations`,
        ),
      );

    // ── The full window contract ──────────────────────────────────────────
    case 'teams':
      /*
       * `businessHours.applied: false` means the duration figures are
       * CALENDAR time and `businessHours.reason` says why. The numbers are
       * never zeroed and never relabelled, so read the flag before captioning
       * them.
       */
      return showObject(
        await chatly.request('GET', '/v1/reports/teams', { query: queryFrom(args, RANGE) }),
      );
    case 'labels':
      // Capped at the 50 busiest labels, with the remainder in
      // `otherLabels`; `trend` covers the top 8 only. There is no cursor, so
      // there is no way to page to the tail.
      return showObject(
        await chatly.request('GET', '/v1/reports/labels', { query: queryFrom(args, RANGE) }),
      );
    case 'sla':
      /*
       * `--business-hours` is accepted by the two above and IGNORED here: the
       * handler reads the range and passes only that to the service. It is
       * left in `RANGE` rather than special-cased because the parameter is
       * harmless, but do not read an SLA figure as business-hours-adjusted.
       *
       * `breachesTruncated` is true when the breach list hit its 200-row cap.
       */
      return showObject(await chatly.reports.sla(queryFrom(args, RANGE)));

    default:
      throw new Error(`Unknown: reports ${sub}`);
  }
}

export async function billing(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const sub = args.path[1] ?? 'summary';
  const range = (): Record<string, string> => {
    const out: Record<string, string> = {};
    const from = str(args.flags, 'from');
    if (from !== undefined) {
      out['from'] = from;
    }
    const to = str(args.flags, 'to');
    if (to !== undefined) {
      out['to'] = to;
    }
    return out;
  };
  /**
   * The meter, from a positional or `--event-type`.
   *
   * Required by `/v1/billing/usage` and `/v1/billing/usage/daily`: both
   * validate it against a closed list and throw before doing anything else,
   * so a call without it is a guaranteed 400 rather than a summary of
   * everything. Four SDKs shipped it as optional.
   */
  const meter = (what: string): UsageEventType => {
    const value = args.path[2] ?? str(args.flags, 'event-type');
    if (value === undefined) {
      throw new Error(
        `Give a meter: \`chatly billing ${what} <event-type>\`.\n` +
          `One of: ${USAGE_EVENT_TYPES.join(', ')}.\n` +
          'The route reports ONE meter over a window, not a summary of everything.',
      );
    }
    /*
     * Checked HERE rather than left to the server.
     *
     * The handler validates against this same closed list and 400s on an
     * unknown value, so passing one through would turn a typo into an HTTP
     * error a user has to decode. We already hold the list — telling them
     * what the four are costs nothing and is the difference between a CLI
     * and a thin curl wrapper.
     *
     * It also narrows the type: `billing.usage` takes `UsageEventType`, and
     * returning a bare `string` is how this went out as `unknown` in four
     * SDKs at once.
     */
    if (!(USAGE_EVENT_TYPES as readonly string[]).includes(value)) {
      throw new Error(
        `\`${value}\` is not a meter.\n` + `One of: ${USAGE_EVENT_TYPES.join(', ')}.`,
      );
    }
    return value as UsageEventType;
  };

  switch (sub) {
    case 'summary':
      // `GET /v1/billing` — plan, seats, trial and cap state in one object.
      return showObject(await chatly.request('GET', '/v1/billing'));
    case 'plans':
      return showRows(args, await chatly.billing.plans(), [
        'id',
        'name',
        'priceCents',
        'interval',
        'seats',
      ]);
    case 'usage':
      return showObject(await chatly.billing.usage(meter('usage'), range()));
    case 'usage-daily':
      /*
       * DENSE: one entry per UTC day in `[from, to)`, zeros included — unlike
       * `reports conversations-by-day`, which omits empty days. The two look
       * alike and are not interchangeable.
       */
      return showObject(
        await chatly.request('GET', '/v1/billing/usage/daily', {
          query: { eventType: meter('usage-daily'), ...range() },
        }),
      );
    case 'usage-monthly':
      // One entry per known usage event type, ALWAYS all four, plus a `total`
      // that is already summed. `--month` is a UTC-midnight ISO date.
      return showObject(
        await chatly.request('GET', '/v1/billing/usage/monthly', {
          query: queryFrom(args, [['month', 'month']]),
        }),
      );
    case 'invoices': {
      /*
       * Cursor-paginated on the wire — `{ data, nextCursor }` — but its
       * envelope key is `data`, not `items`, so the shared manifest does not
       * flag it `paged` and no SDK offers a walker over it. `--all` is
       * therefore not offered here; follow `--cursor` by hand.
       */
      if (bool(args.flags, 'all')) {
        process.stderr.write(
          '--all is not available for invoices: the route pages under a `data` key rather ' +
            'than the `items` envelope every other list uses, so there is no SDK walker ' +
            'for it. Follow the printed cursor with --cursor.\n',
        );
        return 1;
      }
      const page = await chatly.request<{ data?: ReadonlyArray<unknown>; nextCursor?: unknown }>(
        'GET',
        '/v1/billing/invoices',
        {
          query: queryFrom(args, [
            ['cursor', 'cursor'],
            ['limit', 'limit', true],
          ]),
        },
      );
      if (bool(args.flags, 'json')) {
        printJson(page);
        return 0;
      }
      showRows(args, page, [
        'id',
        'status',
        'amountCents',
        'currency',
        'periodStart',
        'hostedInvoiceUrl',
      ]);
      const next = page.nextCursor;
      if (typeof next === 'string' && next.length > 0) {
        process.stdout.write(`next page: --cursor ${next}\n`);
      }
      return 0;
    }
    default:
      throw new Error(`Unknown: billing ${sub}`);
  }
}
