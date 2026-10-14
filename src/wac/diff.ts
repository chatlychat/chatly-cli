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
import {
  looksLikeCredential,
  normalizedKey,
  projected,
  routeForField,
  type Action,
  type ResourceDef,
  type UpdateRoute,
} from './resources.js';
import { isRedacted, REDACTED, sameValue } from './values.js';

import type { DocumentRow, WacDocument } from './document.js';

export { isRedacted, REDACTED, sameValue } from './values.js';

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
  /** `type/key` for each reference, so apply can skip a failed dependency. */
  readonly dependsOn: ReadonlyArray<string>;
}

export interface Plan {
  readonly items: ReadonlyArray<PlanItem>;
  /** File-level observations: an unknown field, a list at its cap. */
  readonly warnings: ReadonlyArray<string>;
  /** Types whose live list may be incomplete, so `--prune` is refused. */
  readonly pruneUnsafe: ReadonlyArray<string>;
}

export interface LiveSection {
  /** Every row the list route returned, exactly as it came. */
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  /** The route caps its answer and the answer came back at the cap. */
  readonly possiblyTruncated?: boolean;
}

/* ── Live indexing ────────────────────────────────────────────────────── */

interface LiveIndex {
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
type KnownIds = Map<string, string | null>;

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
}

export function buildPlan(
  doc: WacDocument,
  live: ReadonlyMap<string, LiveSection>,
  opts: PlanOptions = {},
): Plan {
  const items: PlanItem[] = [];
  const warnings: string[] = [];
  const pruneUnsafe: string[] = [];
  const known = new Map<string, KnownIds>();

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
        dependsOn: [],
      });
    }
  }

  return { items, warnings, pruneUnsafe };
}

function planRow(
  def: ResourceDef,
  row: DocumentRow,
  norm: string,
  index: LiveIndex,
  known: ReadonlyMap<string, KnownIds>,
  opts: PlanOptions,
): PlanItem {
  const notes: string[] = [];
  const resolved: Record<string, string> = {};
  const dependsOn: string[] = [];

  /* ── References first: an unresolvable one blocks the whole row. ────── */
  for (const [wire, ref] of Object.entries(row.refs)) {
    dependsOn.push(`${ref.type}/${ref.key}`);
    const target = known.get(ref.type);
    const normRef = ref.key;
    if (target === undefined || !target.has(normRef)) {
      return blocked(
        def,
        row,
        `names ${ref.type}/${normRef}, which is neither on the server nor created by this ` +
          `plan. Add it under \`resources.${ref.type}\`, or correct the key.`,
        dependsOn,
      );
    }
    const id = target.get(normRef);
    if (id === null || id === undefined || id === '') {
      notes.push(`${wire} resolves to ${ref.type}/${normRef}, which this plan creates first.`);
    } else {
      resolved[wire] = id;
    }
  }

  if (index.ambiguous.has(norm)) {
    return blocked(
      def,
      row,
      `more than one ${def.label} on the server has ${def.naturalKey} "${row.key}", and ` +
        `${def.naturalKey} is what this file matches on. Nothing will be written to either — ` +
        'picking one of two is how the wrong resource gets overwritten. Rename or delete the ' +
        'duplicate first.',
      dependsOn,
    );
  }

  const liveRow = index.byKey.get(norm);
  if (liveRow === undefined) {
    return planCreate(def, row, notes, resolved, dependsOn);
  }
  return planUpdate(def, row, liveRow, notes, resolved, dependsOn, opts);
}

function planCreate(
  def: ResourceDef,
  row: DocumentRow,
  notes: string[],
  resolved: Record<string, string>,
  dependsOn: ReadonlyArray<string>,
): PlanItem {
  if (def.create === null) {
    return blocked(
      def,
      row,
      def.type === 'emailTemplates'
        ? `"${row.key}" is not one of the five template kinds. \`chatly email-templates list\` ` +
            'names them, and all five always exist — so a kind that is missing here is a ' +
            'misspelling, not an absence.'
        : `there is no route that creates a ${def.label}.`,
      dependsOn,
    );
  }
  const changes: FieldChange[] = Object.entries(row.body)
    .filter(([name]) => !def.opaque.includes(name))
    .map(([name, to]) => ({ name, to, route: undefined }));
  const extra = [...notes];
  for (const field of def.opaque) {
    if (row.body[field] !== undefined) {
      extra.push(`${field} is write-only: sent on this create and never readable afterwards.`);
    }
  }
  if (def.secrets.length > 0) {
    extra.push(
      `the create response carries a one-time ${def.secrets.join(' / ')} — \`apply\` prints ` +
        'it once and writes it nowhere.',
    );
  }
  return {
    type: def.type,
    label: def.label,
    key: row.key,
    action: 'create',
    liveId: undefined,
    changes,
    notes: extra,
    reason: undefined,
    row,
    resolved,
    dependsOn,
  };
}

function planUpdate(
  def: ResourceDef,
  row: DocumentRow,
  liveRow: Record<string, unknown>,
  notes: string[],
  resolved: Record<string, string>,
  dependsOn: ReadonlyArray<string>,
  opts: PlanOptions,
): PlanItem {
  const liveIdRaw = liveRow[def.idField];
  const liveId = typeof liveIdRaw === 'string' ? liveIdRaw : undefined;
  if (def.update.length === 0 && def.create?.upsert !== true) {
    return blocked(
      def,
      row,
      `it exists and there is no route that changes a ${def.label} in place.`,
      dependsOn,
    );
  }

  const changes: FieldChange[] = [];
  const extra = [...notes];

  const compare = (name: string, desired: unknown): void => {
    if (name === def.naturalKey) {
      /*
       * The key is what matched this row; it is not a field to change. A
       * document that renames a key is describing a DIFFERENT resource — the
       * new one is created and the old one shows up as an orphan, which is
       * the honest reading and the only one that works for `bots`, whose
       * PATCH schema has no `slug` at all.
       */
      return;
    }
    const unreadable = def.opaque.includes(name)
      ? 'write-only'
      : isRedacted(liveRow[name])
        ? `redacted (reads back as \`${REDACTED}\`)`
        : undefined;
    if (unreadable !== undefined) {
      if (opts.writeOnly !== true) {
        extra.push(
          `${name} is ${unreadable}, so this plan cannot say whether it changed. Left alone ` +
            'unless `--write-only` is passed.',
        );
        return;
      }
      /*
       * `--write-only`: send it, and be honest that this is not a diff. The
       * `from` is undefined because there is nothing to compare against —
       * `render.ts` prints `(unreadable)` rather than inventing a before.
       */
      changes.push({
        name,
        from: undefined,
        to: desired,
        route: def.create?.upsert === true ? undefined : routeForField(def, name),
      });
      extra.push(`${name} is ${unreadable}; --write-only sends it without a comparison.`);
      return;
    }
    const current = liveRow[name];
    if (!sameValue(current, desired)) {
      changes.push({
        name,
        from: current,
        to: desired,
        route: def.create?.upsert === true ? undefined : routeForField(def, name),
      });
    }
  };

  for (const [name, desired] of Object.entries(row.body)) {
    compare(name, desired);
  }
  for (const [wire, id] of Object.entries(resolved)) {
    compare(wire, id);
  }

  if (changes.length === 0) {
    return {
      type: def.type,
      label: def.label,
      key: row.key,
      action: 'noop',
      liveId,
      changes,
      notes: extra,
      reason: undefined,
      row,
      resolved,
      dependsOn,
    };
  }

  /*
   * A changed field no route can write.
   *
   * Reported as blocked for the WHOLE row rather than partly applied: a
   * webhook endpoint whose `eventTypes` changed and whose `schemaVersion`
   * also changed would otherwise come out of `apply` having pinned the
   * version and silently kept the old event list, which is a state nobody
   * asked for and nobody can see.
   */
  if (def.create?.upsert !== true) {
    const unroutable = changes.filter((c) => c.route === undefined);
    if (unroutable.length > 0) {
      return {
        ...blocked(
          def,
          row,
          `${unroutable.map((c) => `\`${c.name}\``).join(', ')} changed, and ` +
            (def.updateBlocked ?? `no route can change that on a ${def.label}.`),
          dependsOn,
        ),
        liveId,
        changes,
      };
    }
  }

  if (def.fullReplace === true) {
    extra.push(
      `the write REPLACES this ${def.label}: every field the document omits reverts to its ` +
        'default. Declare the whole resource here, not just what you want changed.',
    );
  }

  return {
    type: def.type,
    label: def.label,
    key: row.key,
    action: 'update',
    liveId,
    changes,
    notes: extra,
    reason: undefined,
    row,
    resolved,
    dependsOn,
  };
}

function blocked(
  def: ResourceDef,
  row: DocumentRow,
  reason: string,
  dependsOn: ReadonlyArray<string>,
): PlanItem {
  return {
    type: def.type,
    label: def.label,
    key: row.key,
    action: 'blocked',
    liveId: undefined,
    changes: [],
    notes: [],
    reason,
    row,
    resolved: {},
    dependsOn,
  };
}

/* ── Warnings ─────────────────────────────────────────────────────────── */

function sectionWarnings(
  def: ResourceDef,
  rows: ReadonlyArray<DocumentRow>,
  live: LiveSection,
  index: LiveIndex,
): ReadonlyArray<string> {
  const out: string[] = [];

  if (live.possiblyTruncated === true) {
    out.push(
      `${def.type}: the list route is @PaginationExempt and answered at its cap, so there may ` +
        'be rows this plan cannot see. `--prune` is refused for this type while that holds — ' +
        'a row past the cap is invisible, not absent.',
    );
  }

  if (index.keyless > 0) {
    out.push(
      `${def.type}: ${String(index.keyless)} ${def.label}(s) on the server have no ` +
        `\`${def.naturalKey}\`, so this file can neither match nor prune them. They are not ` +
        'listed below at all — give them one in the dashboard to bring them under management.',
    );
  }

  for (const key of index.ambiguous) {
    out.push(
      `${def.type}: ${def.naturalKey} "${key}" is on more than one ${def.label}` +
        (def.keyEnforced
          ? '.'
          : ` — the database does not make \`${def.naturalKey}\` unique for this resource, so ` +
            'only this file does.'),
    );
  }

  out.push(...vocabularyWarnings(def, rows, live.rows));
  return out;
}

/**
 * A field the document declares that NO live row carries.
 *
 * This is what stands in for a per-resource field allow-list, and it is
 * better evidence than one: the vocabulary comes from the server on every
 * run, so it cannot drift out of step with an API that shipped a field
 * yesterday. CLAUDE.md's `helpProfile` / `profile` bug — a key zod strips,
 * answering 200 while doing nothing — is exactly what it catches, and
 * `unwritable` in `resources.ts` catches the mirror case (a field the server
 * returns and no write path accepts).
 *
 * Two limits, both reported rather than hidden:
 *
 *  - With no live rows there is nothing to compare against, so a brand-new
 *    workspace gets no warnings at all.
 *  - A legitimately optional field nobody in this workspace has set produces
 *    a false positive. That is why it is a warning and not a refusal: being
 *    wrong costs one line of output, where refusing wrongly costs a config
 *    file that cannot be applied.
 */
export function vocabularyWarnings(
  def: ResourceDef,
  rows: ReadonlyArray<DocumentRow>,
  liveRows: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<string> {
  if (liveRows.length === 0 || rows.length === 0) {
    return [];
  }
  const serverFields = new Set<string>();
  for (const raw of liveRows) {
    for (const field of Object.keys(projected(def, raw))) {
      serverFields.add(field);
    }
  }
  const unknown = new Set<string>();
  for (const row of rows) {
    for (const field of Object.keys(row.body)) {
      if (serverFields.has(field) || def.opaque.includes(field)) {
        continue;
      }
      // A credential-looking name is write-only by nature, not a typo.
      if (looksLikeCredential(field)) {
        continue;
      }
      unknown.add(field);
    }
  }
  if (unknown.size === 0) {
    return [];
  }
  return [
    `${def.type}: ${[...unknown].map((f) => `\`${f}\``).join(', ')} — no ${def.label} on this ` +
      `server carries ${unknown.size === 1 ? 'that field' : 'those fields'}. The API validates ` +
      'with zod and zod STRIPS an unknown key, so a misspelling is a 200 that did nothing. ' +
      `The fields it does return: ${[...serverFields].sort().join(', ')}.`,
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
