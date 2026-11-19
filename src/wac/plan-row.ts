/**
 * What happens to ONE row: create it, update it, or refuse to touch it.
 *
 * Split out of `diff.ts` on 2026-11-06 at the 650-line ceiling, where that
 * file had been sitting with ZERO headroom — the previous change to it had to
 * be contorted into a net-zero-line shape, and a comment was moved out to pay
 * for a one-line call, which is exactly the thing the 650 rule exists to stop.
 * A file that can only accept changes that cost no lines is a file that taxes
 * the next unrelated edit.
 *
 * The seam is the question each half answers. `diff.ts` assembles a whole
 * plan — it indexes the live rows, walks the sections, finds the orphans and
 * counts the result. This file decides, for a single row, which of those
 * things it is and what the write would look like. Nothing here reads another
 * row or knows how many there are.
 *
 * The types still live in `diff.ts` and are imported as TYPES, so there is no
 * runtime cycle: `diff.ts` imports `planRow` and `orphanPathParams` from here,
 * and `import type` is erased.
 */
import { fullReplaceWarnings } from './diff-warnings.js';
import { droppedFields } from './field-rules-checks.js';
import { routeForField } from './resources.js';
import { isRedacted, narrowTo, REDACTED, sameValue, splitRedacted } from './values.js';

import type { FieldChange, KnownIds, LiveIndex, PlanItem, PlanOptions } from './diff.js';
import type { DocumentRow } from './document.js';
import type { ResourceDef } from './resources.js';

/**
 * The parent id a nested DELETE needs, read off the live row.
 *
 * `{}` for every workspace-level resource: none declares a `parent`, so
 * nothing changes for them. A parented row whose stamped parent id is missing
 * gets `{}` as well rather than a guess — `apply.ts` then refuses to build a
 * path with an unfilled placeholder, which is a loud failure instead of a
 * DELETE sent to a literal `{workspaceId}`.
 */
export function orphanPathParams(
  def: ResourceDef,
  row: Record<string, unknown>,
): Readonly<Record<string, string>> {
  if (def.parent === undefined) {
    return {};
  }
  const id = row[def.parent.wire];
  return typeof id === 'string' && id.length > 0 ? { [def.parent.wire]: id } : {};
}

export function planRow(
  def: ResourceDef,
  row: DocumentRow,
  norm: string,
  index: LiveIndex,
  known: ReadonlyMap<string, KnownIds>,
  opts: PlanOptions,
): PlanItem {
  const notes: string[] = [];
  const resolved: Record<string, string> = {};
  const pathParams: Record<string, string> = {};
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
    } else if (ref.pathParam === true) {
      pathParams[wire] = id;
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
    return planCreate(def, row, notes, resolved, pathParams, dependsOn);
  }
  return planUpdate(def, row, liveRow, notes, resolved, pathParams, dependsOn, opts);
}

function planCreate(
  def: ResourceDef,
  row: DocumentRow,
  notes: string[],
  resolved: Record<string, string>,
  pathParams: Record<string, string>,
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
      pathParams,
    );
  }
  /*
   * Before any field is described: a row whose create is IMPOSSIBLE from a
   * CLI, as against merely wrong. See `ResourceDef.blockedCreate`. Placed
   * ahead of the change list so the plan line carries the reason and nothing
   * else — a row waiting on a human approval is not a diff to read.
   */
  const impossible = def.blockedCreate?.(row.body);
  if (impossible !== undefined) {
    return blocked(def, row, impossible, dependsOn, pathParams);
  }
  const changes: FieldChange[] = Object.entries(row.body)
    .filter(([name]) => !def.opaque.includes(name))
    .map(([name, to]) => ({ name, to, route: undefined }));
  const extra = [...notes];
  for (const field of def.opaque) {
    const value = row.body[field];
    /*
     * An EMPTY opaque field earns no note. `''` is what a public `website`
     * docs source carries for `token` — the field is accepted and ignored
     * there, and three yamls in the wild carry `token: ''` with a comment
     * explaining the workaround — so "sent on this create and never readable
     * afterwards" described a credential nobody has as though one were being
     * entrusted to us. The reader then goes looking for where it is stored.
     */
    if (value !== undefined && value !== '' && value !== null) {
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
    pathParams,
    dependsOn,
  };
}

function planUpdate(
  def: ResourceDef,
  row: DocumentRow,
  liveRow: Record<string, unknown>,
  notes: string[],
  resolved: Record<string, string>,
  pathParams: Record<string, string>,
  dependsOn: ReadonlyArray<string>,
  opts: PlanOptions,
): PlanItem {
  const liveIdRaw = liveRow[def.idField];
  const liveId = typeof liveIdRaw === 'string' ? liveIdRaw : undefined;
  /*
   * No early refusal for a type with no update route.
   *
   * There was one — `update.length === 0` returned `blocked` before a single
   * field was compared — and it was harmless while every workspace-level type
   * either had an update route or was an upsert. Every Platform API type has
   * neither (CHT-F04), so a tenant that matched its document exactly planned
   * as BLOCKED: `plan` could never say "everything matches", which is the one
   * sentence the feature exists to print. Unchanged rows are now `noop`, and
   * a changed field is refused below by `routeForField` finding no route,
   * with the resource's own `updateBlocked` sentence.
   */
  const changes: FieldChange[] = [];
  const extra = [...notes];
  // Not a diff: the live row is broken on its own terms. `diff.ts` collects
  // the same verdict into `Plan.unhealthy` for the exit code. See
  // `ResourceDef.liveState`.
  const state = def.liveState?.(liveRow);
  if (state !== undefined) {
    extra.push(state.note);
  }

  const compare = (name: string, desired: unknown): void => {
    // A parented row's child key is HALF its natural key (`acme/ops@…`), so
    // it is skipped for the same reason — it matched, modulo `normalizeKey`.
    if (name === def.naturalKey || name === def.parent?.childKey) {
      /*
       * The key is what matched this row; it is not a field to change. A
       * document that renames a key is describing a DIFFERENT resource — the
       * new one is created and the old one shows up as an orphan, which is
       * the honest reading and the only one that works for `bots`, whose
       * PATCH schema has no `slug` at all.
       */
      return;
    }
    if (def.mergeFields?.includes(name) === true && !def.opaque.includes(name)) {
      /*
       * A merge field holding credentials (a channel's `config`) is split
       * per leaf: the redacted leaves are write-only, everything else is
       * diffed, so drift shows. Left alone unless `--write-only`, which
       * sends the whole value — the same contract as an opaque field.
       */
      const s = splitRedacted(liveRow[name], desired);
      if (s.redacted) {
        const route = routeForField(def, name);
        /*
         * The LEAVES by name, not "holds credentials" (CH-26).
         *
         * An operator who has just written `identityVerification.eventsSecret`
         * reads this line to find out what happened to it, and the old
         * wording could not tell them whether the field they wrote was the
         * one being skipped — or whether it was set at all. The paths are the
         * answer, and `${REDACTED}` reading back IS the answer to "is it
         * set": a leaf that is absent on the server is not redacted and shows
         * up as an ordinary change instead.
         *
         * Empty paths (a whole merge field redacted at its root) fall back to
         * the field name, which is all there is to say about it.
         */
        const leaves = s.paths.filter((p) => p !== '');
        const named = leaves.length > 0 ? leaves.join(', ') : name;
        const flag = opts.writeOnly === true ? '--write-only' : '--rotate-secret';
        if (opts.writeOnly === true || opts.rotateSecrets === true) {
          /*
           * `secret: true`: no renderer prints this value, whether or not it
           * came from `${env:…}`. See `FieldChange.secret`.
           */
          changes.push({ name, from: undefined, to: desired, route, secret: true });
          extra.push(`${named} cannot be read back; ${flag} writes it without a comparison.`);
        } else {
          extra.push(
            `${named} is SET on the server and reads back as \`${REDACTED}\`, so this plan ` +
              'cannot say whether the value matches the document. Pass `--rotate-secret` to ' +
              `write it (or \`--write-only\` for every unreadable field); the rest of ${name} ` +
              'is compared.',
          );
          if (!sameValue(s.live, s.desired)) {
            changes.push({ name, from: s.live, to: s.desired, route });
          }
        }
        return;
      }
    }
    // A MERGE-written field is compared on the keys the document names only.
    const live =
      def.mergeFields?.includes(name) === true ? narrowTo(liveRow[name], desired) : liveRow[name];
    const unreadable = def.opaque.includes(name)
      ? 'write-only'
      : isRedacted(live)
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
    const current = live;
    if (!sameValue(current, desired)) {
      changes.push({
        name,
        from: current,
        to: desired,
        route: def.create?.upsert === true ? undefined : routeForField(def, name),
      });
    }
  };

  /*
   * A field the route DROPS is left out of the diff entirely. It cannot read
   * back, so diffing it makes a row that no `apply` can settle — see
   * `droppedFields`. `unknownFieldWarnings` is what tells the author, and it
   * now says both halves of this: the field never takes effect, and a rerun
   * settles.
   */
  const dropped = droppedFields(def, row, liveRow);
  for (const [name, desired] of Object.entries(row.body)) {
    if (dropped.has(name)) {
      continue;
    }
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
      pathParams,
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
          pathParams,
        ),
        liveId,
        changes,
      };
    }
  }

  extra.push(...fullReplaceWarnings(def));

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
    pathParams,
    dependsOn,
  };
}

function blocked(
  def: ResourceDef,
  row: DocumentRow,
  reason: string,
  dependsOn: ReadonlyArray<string>,
  pathParams: Readonly<Record<string, string>> = {},
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
    /*
     * KEPT on a blocked row. `apply` never writes one, so it is not needed
     * for a request — but `--prune` and the JSON renderer both read a plan
     * item without knowing its action, and a field that is sometimes absent
     * is a field somebody reads as "this row has no parent".
     */
    pathParams,
    dependsOn,
  };
}
