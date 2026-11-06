/**
 * The diff. Pure: a document plus the live rows in, a plan out.
 *
 * No transport, no filesystem, no clock, nothing injected. That is not
 * fastidiousness — it is what lets the spec drive this with literal objects,
 * and it is half the proof that `chatly plan` writes nothing: the function
 * that decides what WOULD change has no way to change anything. The other
 * half is a recording transport asserting zero non-GET requests, in
 * `wac.spec.ts`.
 *
 * ═══ WHAT A DIFF MUST NOT DO ══════════════════════════════════════════════
 *
 * Report a change that is not one. A plan that says "3 to change" against a
 * workspace nobody has touched is a plan people stop reading, and then
 * `apply` gets run blind — which is the failure this whole feature exists to
 * prevent. Four rules come out of that:
 *
 *  1. ONLY the fields the document declares are compared. A server field the
 *     file says nothing about is unmanaged and is never mentioned. So a
 *     document can describe four fields of a bot and leave the other twenty
 *     to the dashboard, which is how a team actually works.
 *
 *  2. A field that cannot be READ BACK is never compared. Two kinds, both
 *     handled: the ones declared `opaque` (a customer card's `headers` are
 *     write-only by design — the read shape returns `headerNames`, names and
 *     never values, because that is where the bearer token is), and the ones
 *     the server hands back as the literal `__redacted__`, detected at
 *     runtime so a field nobody told this file about still cannot produce a
 *     phantom change. Each is reported once, as a note, saying it is
 *     unknowable rather than unchanged.
 *
 *  3. `undefined` and absent are one state. JSON has no `undefined`, so a key
 *     the server omits and a key it sends as `undefined` are the same thing,
 *     and only `null` is a value.
 *
 *  4. The live row is PROJECTED into the document's vocabulary first. A bot's
 *     `webhookUrl` comes back under `externalAgent`; an email template's
 *     customised copy comes back under `override`. Comparing against the
 *     un-projected row reports a change on every run, for ever. See
 *     `resources.ts`.
 *
 * ═══ AND WHAT IT MUST DO ══════════════════════════════════════════════════
 *
 * Refuse to guess. Two live rows with one natural key, a reference to a bot
 * that neither exists nor is being created, a changed field no route can
 * write — each produces a `blocked` item that `apply` will not touch, with
 * the reason on the line. The alternative in every case is picking one and
 * being wrong silently, which is how the wrong resource gets overwritten.
 */
import { refusedRowKeys, sectionWarnings } from './diff-warnings.js';
import { orphanPathParams, planRow } from './plan-row.js';
import {
  normalizedKey,
  projected,
  type Action,
  type ResourceDef,
  type UpdateRoute,
} from './resources.js';

import type { DocumentRow, WacDocument } from './document.js';

export { isRedacted, REDACTED, sameValue } from './values.js';
export { vocabularyWarnings } from './diff-warnings.js';

export interface FieldChange {
  readonly name: string;
  /** Absent on a create. */
  readonly from?: unknown;
  readonly to: unknown;
  /** The route that would write it. Undefined means nothing can. */
  readonly route: UpdateRoute | undefined;
}

export interface PlanItem {
  readonly type: string;
  readonly label: string;
  /** As written in the document, or as the server spells it for an orphan. */
  readonly key: string;
  readonly action: Action;
  /** The server's id, for an update or a prune. */
  readonly liveId: string | undefined;
  readonly changes: ReadonlyArray<FieldChange>;
  /** True of this row but not a change: unreadable fields, full replaces. */
  readonly notes: ReadonlyArray<string>;
  /** Set on `blocked`: why apply will not try. */
  readonly reason: string | undefined;
  readonly row: DocumentRow | undefined;
  /** Wire field → id, for references already resolvable at plan time. */
  readonly resolved: Readonly<Record<string, string>>;
  /**
   * Placeholder → id for a reference that fills the ROUTE PATH rather than
   * the body (`ResourceRef.pathParam`).
   *
   * Separate from `resolved` because the two have opposite treatment: a body
   * ref is COMPARED against the live row, and a path ref must never be — the
   * live row has no such field, so a diff on it would report a change every
   * run. Empty for every workspace-level resource, which declares no path
   * refs at all.
   *
   * Carried on an ORPHAN too, where there is no document row to resolve from:
   * the parent's id is read off the live row, because `--prune` needs it to
   * build the DELETE path.
   */
  readonly pathParams: Readonly<Record<string, string>>;
  /** `type/key` for each reference, so apply can skip a failed dependency. */
  readonly dependsOn: ReadonlyArray<string>;
}

export interface Plan {
  readonly items: ReadonlyArray<PlanItem>;
  /** File-level observations: an unknown field, a list at its cap. */
  readonly warnings: ReadonlyArray<string>;
  /** Types whose live list may be incomplete, so `--prune` is refused. */
  readonly pruneUnsafe: ReadonlyArray<string>;
  readonly refused: ReadonlyArray<string>; // see `refusedRowKeys` in diff-warnings.ts
}

export interface LiveSection {
  /** Every row the list route returned, exactly as it came. */
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  /** The route caps its answer and the answer came back at the cap. */
  readonly possiblyTruncated?: boolean;
  /**
   * Natural keys returned BEFORE `existsWhen` filtered them, for the
   * `existsWhen` resources only — see `unknownKeyWarnings`, which is the one
   * reader. A key absent here is one the server has never heard of.
   */
  readonly allKeys?: ReadonlyArray<string>;
  /** Unfiltered rows (pre-`existsWhen`); `extraWarnings` reads them — see `diff-warnings.ts`. */
  readonly allRows?: ReadonlyArray<Record<string, unknown>>;
}

/* ── Live indexing ────────────────────────────────────────────────────── */

export interface LiveIndex {
  /** Normalised key → projected row. */
  readonly byKey: ReadonlyMap<string, Record<string, unknown>>;
  /** Keys that appeared more than once: matched to nothing, on purpose. */
  readonly ambiguous: ReadonlySet<string>;
  /** Rows whose natural key is null/absent: invisible to this file. */
  readonly keyless: number;
}

function indexLive(def: ResourceDef, rows: ReadonlyArray<Record<string, unknown>>): LiveIndex {
  const byKey = new Map<string, Record<string, unknown>>();
  const ambiguous = new Set<string>();
  let keyless = 0;
  for (const raw of rows) {
    /*
     * A row the document can never match, dropped before anything else.
     *
     * `ignoreLive` is the revoked credential: the Platform API keeps a
     * revoked `ck_` key and a revoked bot credential in their lists with
     * `revokedAt` set. Filtered HERE rather than in the reader because this
     * is the one function that decides what a document row may be matched
     * to — a filter in the reader would leave a second path (a test driving
     * `buildPlan` with literal rows) able to match one.
     */
    if (def.ignoreLive?.(raw) === true) {
      continue;
    }
    const row = projected(def, raw);
    const key = row[def.naturalKey];
    if (typeof key !== 'string' || key.length === 0) {
      keyless += 1;
      continue;
    }
    const norm = normalizedKey(def, key);
    if (byKey.has(norm)) {
      ambiguous.add(norm);
      continue;
    }
    byKey.set(norm, { ...row, [def.idField]: raw[def.idField] });
  }
  return { byKey, ambiguous, keyless };
}

/* ── The plan ─────────────────────────────────────────────────────────── */

/** Natural key → server id, or `null` for "this run creates it". */
export type KnownIds = Map<string, string | null>;

/**
 * Build the plan.
 *
 * `live` holds only the types the document mentions. A type the file says
 * nothing about is not read, not diffed and not reported: an unmanaged
 * resource is not drift, and reporting it as such would make every plan a
 * wall of noise about the dashboard.
 */
export interface PlanOptions {
  /**
   * Treat every unreadable field as changed.
   *
   * `--write-only`. By default a field that cannot be read back is reported
   * as unknowable and left alone, because a diff that says "changed" on every
   * run is a diff nobody reads. This is the escape: you rotated the card's
   * `Authorization` header in the file and need it pushed, and no diff can
   * ever tell you that for you.
   */
  readonly writeOnly?: boolean;
  /**
   * Live rows of a type the document REFERENCES without declaring a section
   * for it — resolvable by a reference, never planned, never an orphan.
   *
   * The platform document's adoption shape needs it (CHT-F04): an `apiKeys`
   * row naming `workspace: "acme"` for a tenant somebody else created, with
   * no `workspaces:` section at all. Without this, `known` holds only
   * declared types and the row is blocked as naming something "neither on
   * the server nor created by this plan" — which is false, the tenant is on
   * the server. Declaring the section instead would turn every other tenant
   * into an orphan line. Empty for the workspace document.
   */
  readonly referenced?: ReadonlyArray<{ readonly def: ResourceDef; readonly section: LiveSection }>;
}

export function buildPlan(
  doc: WacDocument,
  live: ReadonlyMap<string, LiveSection>,
  opts: PlanOptions = {},
): Plan {
  const items: PlanItem[] = [];
  const warnings: string[] = [];
  const refused: string[] = []; // keys the server will refuse; see `refusedRowKeys`
  const pruneUnsafe: string[] = [];
  const known = new Map<string, KnownIds>();
  for (const { def, section } of opts.referenced ?? []) {
    const ids: KnownIds = new Map();
    for (const [key, row] of indexLive(def, section.rows).byKey) {
      const id = row[def.idField];
      ids.set(key, typeof id === 'string' ? id : '');
    }
    known.set(def.type, ids);
  }

  for (const section of doc.sections) {
    const { def } = section;
    const liveSection = live.get(def.type) ?? { rows: [] };
    const index = indexLive(def, liveSection.rows);

    const ids: KnownIds = new Map();
    for (const [key, row] of index.byKey) {
      const id = row[def.idField];
      ids.set(key, typeof id === 'string' ? id : '');
    }
    known.set(def.type, ids);

    warnings.push(...sectionWarnings(def, section.rows, liveSection, index));
    if (liveSection.possiblyTruncated === true) {
      pruneUnsafe.push(def.type);
    }

    const declared = new Set<string>();
    for (const row of section.rows) {
      const norm = normalizedKey(def, row.key);
      declared.add(norm);
      const item = planRow(def, row, norm, index, known, opts);
      items.push(item);
      if (item.action === 'create') {
        // A later section may reference it; the id is unknown until apply.
        ids.set(norm, null);
      }
    }
    refused.push(...refusedRowKeys(def, items, liveSection, warnings));

    for (const [key, row] of index.byKey) {
      if (declared.has(key)) {
        continue;
      }
      const id = row[def.idField];
      items.push({
        type: def.type,
        label: def.label,
        key: typeof row[def.naturalKey] === 'string' ? String(row[def.naturalKey]) : key,
        action: 'orphan',
        liveId: typeof id === 'string' ? id : undefined,
        changes: [],
        notes:
          def.remove === null
            ? [`\`--prune\` cannot delete this: ${def.removeBlocked ?? 'no DELETE route.'}`]
            : [],
        reason: undefined,
        row: undefined,
        resolved: {},
        /*
         * Off the LIVE row, because there is no document row to resolve a
         * reference from — this is a resource the file does not mention. A
         * nested DELETE path needs its parent's id
         * (`/v1/platform/workspaces/{workspaceId}/users/{id}`), and the only
         * place that id exists here is the row the reader fetched. The reader
         * stamps it; see `platform-live.ts`.
         */
        pathParams: orphanPathParams(def, row),
        dependsOn: [],
      });
    }
  }

  return { items, warnings, pruneUnsafe, refused };
}

/** Counts for the summary line. */
export function tally(plan: Plan): Record<Action, number> {
  const out: Record<Action, number> = {
    create: 0,
    update: 0,
    noop: 0,
    orphan: 0,
    blocked: 0,
  };
  for (const item of plan.items) {
    out[item.action] += 1;
  }
  return out;
}
