/**
 * The pieces every command group shares.
 *
 * Lifted out of `resources.ts` when the command surface grew past the point
 * where one file could hold it under the 650-line ceiling. Nothing here is
 * new behaviour — `renderList`, `need` and `props` are the same functions
 * four groups were already importing from each other.
 */
import { readFileSync } from 'node:fs';

import { autoPaginate } from '@chatlychat/sdk-node';

import { bool, num, str, type ParsedArgs } from '../args.js';
import { itemsOf, nextCursorOf, printJson, printTable } from '../output.js';

import type { ChatlyClient, Page, Query } from '@chatlychat/sdk-node';

/** Shared list behaviour: one page, or every page with `--all`. */
export async function renderList(
  args: ParsedArgs,
  columns: ReadonlyArray<string>,
  onePage: (query: Record<string, string | number>) => Promise<unknown>,
  everyPage?: () => AsyncGenerator<unknown, void, void>,
): Promise<number> {
  const json = bool(args.flags, 'json');
  if (bool(args.flags, 'all')) {
    if (everyPage === undefined) {
      process.stderr.write(
        '--all is not available for this command (it is not cursor-paginated).\n',
      );
      return 1;
    }
    const rows: unknown[] = [];
    for await (const row of everyPage()) {
      rows.push(row);
    }
    if (json) {
      printJson(rows);
    } else {
      printTable(rows, columns);
    }
    return 0;
  }

  const query: Record<string, string | number> = {};
  const limit = num(args.flags, 'limit');
  if (limit !== undefined) {
    query['limit'] = limit;
  }
  const cursor = str(args.flags, 'cursor');
  if (cursor !== undefined) {
    query['cursor'] = cursor;
  }
  const page = await onePage(query);
  if (json) {
    printJson(page);
    return 0;
  }
  printTable(itemsOf(page), columns);
  const next = nextCursorOf(page);
  if (next !== null) {
    process.stdout.write(`next page: --cursor ${next}   (or --all)\n`);
  }
  return 0;
}

/**
 * A table for a route that answers a bare array, or an object wrapping one.
 *
 * Deliberately NOT `renderList`: these routes are `@PaginationExempt` and
 * have no cursor, so printing a "next page" hint or accepting `--all` would
 * promise a walk that does not exist. `--all` on one of these falls through
 * to `renderList`'s refusal only when the caller passes it; here it is simply
 * not offered.
 */
export function showRows(
  args: ParsedArgs,
  value: unknown,
  columns: ReadonlyArray<string>,
  max?: number,
): number {
  if (bool(args.flags, 'json')) {
    printJson(value);
    return 0;
  }
  printTable(itemsOf(value), columns, max);
  return 0;
}

/** An object read: there is no table shape worth inventing, so print the JSON. */
export function showObject(value: unknown): number {
  printJson(value ?? { ok: true });
  return 0;
}

export function need(args: ParsedArgs, index: number, what: string): string {
  const value = args.path[index];
  if (value === undefined) {
    throw new Error(`Missing ${what}. See \`chatly --help\`.`);
  }
  return value;
}

/** `--prop key=value`, repeatable, into an object. */
export function props(args: ParsedArgs): Record<string, string> | undefined {
  const raw = args.flags['prop'];
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [String(raw)];
  if (list.length === 0) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const pair of list) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      throw new Error(`--prop expects key=value, got "${pair}"`);
    }
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

/**
 * One flag spec: the flag a person types, the name the API reads, and whether
 * it must be a number.
 *
 * ── Why the wire name is written out ──────────────────────────────────────
 *
 * The API validates every query with zod and zod object schemas STRIP an
 * unknown key, so a parameter under the wrong name produces a 200 and a
 * server that quietly did something else. That shipped in three callers at
 * once with `kinds[]` on `/v1/search`. The names on the right of these
 * tuples are read off the handler's schema in `apps/api/src/modules/**`, not
 * off the route's name, and several do not match what the name suggests:
 * `/v1/reports/cohorts` takes `weeks` and ignores `days`,
 * `/v1/reports/attribution` takes `dimension` and REFUSES an unknown value,
 * `/v1/macros` takes `query` rather than `q`, and the two extended-report
 * routes take snake_case `group_by` / `business_hours` while every other
 * parameter in the API is camelCase.
 */
export type FlagSpec = readonly [flag: string, wire: string, numeric?: boolean];

/** Build a query from the flags that were actually passed. Absent flags are absent. */
export function queryFrom(args: ParsedArgs, specs: ReadonlyArray<FlagSpec>): Query {
  const out: Record<string, string | number> = {};
  for (const [flag, wire, numeric] of specs) {
    if (numeric === true) {
      const value = num(args.flags, flag);
      if (value !== undefined) {
        out[wire] = value;
      }
      continue;
    }
    const value = str(args.flags, flag);
    if (value !== undefined) {
      out[wire] = value;
    }
  }
  return out;
}

/** `--days`, the window every `reports.*` route but three reads. */
export const DAYS: ReadonlyArray<FlagSpec> = [['days', 'days', true]];

/**
 * The full window contract, which only `reports/teams`, `reports/labels` and
 * `reports/sla` accept. `--from`/`--to` on any other report is silently
 * ignored by the handler, which is why they are not offered there.
 */
export const RANGE: ReadonlyArray<FlagSpec> = [
  ['days', 'days', true],
  ['from', 'from'],
  ['to', 'to'],
  ['group-by', 'group_by'],
  ['business-hours', 'business_hours'],
];

/**
 * A JSON body, from a file, from stdin, or inline.
 *
 * ── Why config writes take a document and not twenty flags ───────────────
 *
 * The bodies on this surface are nested objects — a bot carries guardrails,
 * a kb scope and an escalation-rule array; a routing rule carries a
 * condition list. Twenty flags per command would be a worse CLI and a second
 * place for a key name to be spelled wrong. The body goes to the API exactly
 * as written, so the schema in `apps/api` is the only spelling that matters.
 *
 * Note what that does and does not buy: the API still strips a key this file
 * has never heard of, so a typo in YOUR json is a 200 that did nothing. The
 * CLI simply refuses to add a second renaming layer on top.
 */
export function bodyFrom(args: ParsedArgs, what: string): unknown {
  const file = str(args.flags, 'file');
  const inline = str(args.flags, 'body');
  if (file !== undefined && inline !== undefined) {
    throw new Error('Pass --file or --body, not both.');
  }
  let raw: string;
  if (file !== undefined) {
    try {
      // `0` is stdin: `cat bot.json | chatly bots create --file -`.
      raw = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
    } catch (err) {
      throw new Error(`Cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (inline !== undefined) {
    raw = inline;
  } else {
    throw new Error(
      `Give ${what} as JSON: --file ./config.json (or --file - for stdin), or --body '{…}'.`,
    );
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed;
  } catch {
    throw new Error(`${file === undefined ? '--body' : file} is not valid JSON.`);
  }
}

/**
 * A cursor-paginated route the SDK has no typed walker for yet.
 *
 * Both halves go through `ChatlyClient.request` — the escape hatch the SDK
 * contract defines for the key-accessible routes with no named method — so
 * auth, the idempotency key, the retry policy and the typed errors are the
 * same ones every other command gets. The walk is the SDK's own
 * `autoPaginate`, which stops on a null cursor and throws rather than
 * spinning when the server repeats one.
 */
export function pagedVia(
  chatly: ChatlyClient,
  path: string,
  extra: Query = {},
): {
  onePage: (query: Record<string, string | number>) => Promise<unknown>;
  everyPage: () => AsyncGenerator<unknown, void, void>;
} {
  const fetchPage = (query: Query): Promise<Page<unknown>> =>
    chatly.request<Page<unknown>>('GET', path, { query: { ...extra, ...query } });
  return {
    onePage: (query) => fetchPage(query),
    everyPage: () =>
      autoPaginate<unknown>((cursor) => fetchPage(cursor === undefined ? {} : { cursor })),
  };
}
