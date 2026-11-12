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
import {
  discardedFieldWarnings,
  strictUnknownFieldKeys,
  unknownFieldWarnings,
} from './field-rules-checks.js';
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
  /**
   * This value CARRIES A CREDENTIAL, so no renderer may print it.
   *
   * Set where a write-only secret is being pushed deliberately
   * (`--rotate-secret`). `fromEnv` already masks a value that came from
   * `${env:…}`, and that is not enough on its own: an author who pasted the
   * secret into the file gets no masking from it, and `plan --json | tee
   * plan.json` is a thing somebody does on the first day. A flag on the
   * change is independent of where the value came from.
   */
  readonly secret?: boolean;
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
  /**
   * `type/key` for a live row that MATCHES the document and is broken anyway
   * (CH-05) — a documentation source whose last sync failed.
   *
   * A third list beside `blocked` and `refused`, and deliberately not folded
   * into either: those two are about whether a write will happen, this one is
   * about whether the resource works. `plan` answers 3 for it and `apply`'s
   * read-back refuses to say "everything matches" while it is non-empty.
   * Counting it as a `blocked` item would make every total wrong, which is
   * the mistake `planForJson` already records one list over.
   */
  readonly unhealthy: ReadonlyArray<string>;
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
   * Send the credentials that live INSIDE a merge-written field, and nothing
   * else that cannot be read back.
   *
   * `--rotate-secret`. The narrower half of `--write-only`, for the one job
   * people actually have: Atlas minted a new events signing secret, it is in
   * the file as `${env:…}`, and it has to reach
   * `config.identityVerification.eventsSecret`. `--write-only` does that too
   * and also re-sends every docs-source token and customer-card
   * `Authorization` header the document names — a blast radius nobody wants
   * from a secret rotation, and the reason this flag exists rather than a
   * line in the runbook saying "use --write-only".
   *
   * Chatly does NOT generate the value: Atlas mints it and an operator pastes
   * it (`workspace-channel-secrets.ts` classifies it `provider_credential`
   * for exactly that reason), so there is nothing for a server-side rotate
   * route to mint. The rotation is a WRITE of a value the author already
   * holds, which is why this is a plan option and not an endpoint.
   */
  readonly rotateSecrets?: boolean;
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
   * into an orphan line.
   *
   * The WORKSPACE document needs it too, and this line read "Empty for the
   * workspace document" while a `botRoutes`-only file blocked every row with
   * `names bots/fd-bot, which is neither on the server nor created by this
   * plan` (ForgeDeck 2026-11-07 item 4, reproduced twice). `referencedDefs`
   * in `commands/workspace-as-code.ts` derives the list from each def's own
   * `references`, so a new reference is covered without touching this.
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
  const unhealthy: string[] = []; // live rows that are broken; see `Plan.unhealthy`
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

    if (liveSection.possiblyTruncated === true) {
      pruneUnsafe.push(def.type);
    }

    const declared = new Set<string>();
    /*
     * The planned action per normalized key, for the warning rules. A Set of
     * "sendable" keys was not enough once the required-field rule needed
     * CREATE specifically, and two parallel collections answering different
     * questions about the same row is how they drift apart.
     */
    const actions = new Map<string, PlanItem['action']>();
    for (const row of section.rows) {
      const norm = normalizedKey(def, row.key);
      declared.add(norm);
      const item = planRow(def, row, norm, index, known, opts);
      items.push(item);
      actions.set(norm, item.action);
      /*
       * The same pure `liveState` call `planRow` makes for the NOTE, made
       * here for the EXIT CODE. Two calls rather than a field smuggled out
       * through `PlanItem`: it is a pure read of a row both already hold, and
       * a new item field would have to be threaded through the orphan and
       * blocked constructors that can never set it.
       */
      const live = index.byKey.get(norm);
      if (live !== undefined && def.liveState?.(live)?.failed === true) {
        unhealthy.push(`${def.type}/${row.key}`);
      }
      if (item.action === 'create') {
        // A later section may reference it; the id is unknown until apply.
        ids.set(norm, null);
      }
    }

    /*
     * Warnings are produced AFTER the rows are planned, because a rule that
     * predicts a server refusal has to know whether `apply` will send the row
     * at all. It used to run before this loop, and said "the server refuses
     * it" about a document `apply` exits 0 on without a single write —
     * ForgeDeck's seventh report, item 2. The SIXTH report's item 1 was the
     * same mistake one field over, in `refusedRowKeys`, and moving that call
     * is exactly what fixed it.
     *
     * Output order is unchanged: every warning for this section, section-level
     * and per-row alike, is still emitted as one block before the next
     * section's, and nothing in `planRow` reads `warnings`.
     */
    const refusing = sectionWarnings(def, section.rows, liveSection, index, (key) =>
      actions.get(normalizedKey(def, key)),
    );
    warnings.push(...refusing);
    /*
     * `refusedRowKeys` is given the REFUSING warnings only. It decides by
     * prefix match, so an advisory about a field the server silently drops
     * would otherwise make `plan` exit 3 on a document `apply` accepts.
     */
    refused.push(...refusedRowKeys(def, items, liveSection, refusing));
    warnings.push(...unknownFieldWarnings(def, section.rows));
    // Advisory for the same reason, and `index.byKey` is normalized, so the
    // document's own spelling has to be put through `normalizedKey` first.
    warnings.push(
      ...discardedFieldWarnings(def, section.rows, (key) =>
        index.byKey.get(normalizedKey(def, key)),
      ),
    );
    /*
     * A STRICT route's unknown field IS a refusal — it answers
     * `Unrecognized key(s)` and writes nothing — so it belongs in `refused`
     * even though its warning is appended as advice. A dropping route's does
     * not, and that asymmetry is the whole reason the two are separated here.
     */
    refused.push(
      ...strictUnknownFieldKeys(def, section.rows).filter((k: string) => {
        const action = actions.get(normalizedKey(def, k));
        return action === 'create' || action === 'update';
      }),
    );

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

  warnings.push(...businessHoursWarnings(live));
  return { items, warnings, pruneUnsafe, refused, unhealthy };
}

/**
 * "Business hours are off and a web channel is live" (CH-24).
 *
 * Cross-resource, so it cannot be a `ResourceDef.extraWarnings` hook — those
 * see one type's rows. It reads the live sections both resources already
 * fetched and writes nothing.
 *
 * shortcut: it only fires when the document declares BOTH sections, because
 * `plan` reads only the types the file mentions and that property is load
 * bearing (an unmanaged resource is not drift). A workspace whose file says
 * nothing about either is covered by `chatly doctor`, which reads
 * `business_hours.set` from the server for every workspace. Upgrade this if
 * `plan` ever grows a reason to read a type the document does not name.
 */
function businessHoursWarnings(live: ReadonlyMap<string, LiveSection>): string[] {
  const hours = live.get('businessHours')?.rows[0];
  if (hours === undefined || hours['enabled'] !== false) {
    return [];
  }
  const web = (live.get('channels')?.rows ?? []).filter(
    (c) => c['type'] === 'web' && c['enabled'] !== false,
  );
  if (web.length === 0) {
    return [];
  }
  return [
    `businessHours.enabled is false while ${String(web.length)} web channel(s) are enabled. ` +
      'Every visitor is told the same thing at 03:00 as at 11:00, no trigger and no workflow ' +
      'can branch on whether you are open, and routing cannot hold a conversation until ' +
      'somebody is on. Set `enabled: true` with a `tz` and a `schedule`.',
  ];
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
