/**
 * The check that reads each ARM of a union body on its own.
 *
 * Split from `field-rules-checks.ts`, which was at 652 lines against a
 * 650-line limit once this landed. The seam is real rather than arbitrary:
 * every other check in that file reads the MERGED view of a route's rules,
 * and this one exists precisely because the merged view cannot answer the
 * question — a body has to satisfy one whole arm, and both an intersection
 * and a union across arms lose that.
 */
import { rowPrefix, rulesFor, wireToRefKey } from './field-rules-checks.js';
import { article, jsonTypeOf, stringRuleMiss, typeSatisfies } from './field-types.js';

import type { DocumentAction } from './diff-warnings.js';
import type { DocumentRow } from './document.js';
import type { RouteFieldArm } from './field-rules.generated.js';
import type { ResourceDef } from './resources.js';

/**
 * A row that satisfies NO arm of a union body.
 *
 * ForgeDeck 2026-11-07 item 1, reproduced twice: `bots: [{ slug, name }]`
 * planned clean and exited 2, then `apply` answered `POST /v1/bots — Invalid
 * request body (this route accepts 2 shapes and the body matched none of
 * them; type: Invalid literal value, expected "external"; webhookUrl:
 * Required; systemPrompt: Required)`. Every one of those facts was in the
 * document the whole time.
 *
 * The reason the other checks here cannot see it is that they read ACROSS the
 * arms. `POST /v1/bots` intersects to `required: ['name']` — the one field
 * both shapes share — so a row carrying only `name` looks complete. And
 * `types` records a field only where every arm agrees, which is why
 * `POST /v1/ai/tools` was missed the same way: its `parameters` is an array in
 * one arm and undeclared in the other, so the table has no type for it and an
 * object passed. That route has no discriminator at all, which is why the
 * report's own suggestion — pick the arm from `type` — is not enough on its
 * own.
 *
 * CREATE only, for the reason `requiredFieldWarnings` gives: an update sends a
 * partial body, where an absent field means "leave as stored".
 */
export function unionArmWarnings(
  def: ResourceDef,
  rows: ReadonlyArray<DocumentRow>,
  actionFor: (key: string) => DocumentAction,
  alreadyNamed: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const rules = rulesFor(def);
  if (rules === undefined || rules.arms.length < 2) {
    return [];
  }
  const wires = wireToRefKey(def);
  const out: string[] = [];
  for (const row of rows) {
    if (actionFor(row.key) !== 'create') {
      continue;
    }
    const prefix = rowPrefix(def, row.key);
    /*
     * A row the per-field checks have already explained is skipped rather
     * than described twice. `type: 'galaxy'` contradicts both arms, so without
     * this it would collect the enum message AND "matches neither shape" —
     * and a warning printed twice is a defect this tracker has now closed
     * twice on its own merits.
     */
    if (alreadyNamed.some((m) => m.startsWith(prefix))) {
      continue;
    }
    const assessed = rules.arms.map((arm) => ({ arm, needs: armNeeds(arm, row, wires) }));
    /*
     * An arm counts as matched ONLY when it has nothing outstanding, and an
     * arm-enum miss is one of those things.
     *
     * ForgeDeck 2026-11-07 item 1, reproduced twice, and a defect introduced
     * by the previous round's fix: `{ type: 'external', systemPrompt: '…' }`
     * fills the CHATLY arm's required fields (`name`, `systemPrompt`) while
     * carrying a `type` that arm does not allow. The match test read only
     * required fields and declared types, so the row passed on an arm its own
     * value ruled out, and `apply` answered `webhookUrl: Required; type:
     * Invalid literal value, expected "chatly"`.
     *
     * The facts were already here — `wrongDiscriminator` knew them — but they
     * were only used to WORD the message, after the row had been let through.
     * A check that computes the right answer and uses it for presentation is
     * the subtler half of the same mistake the whole union check exists for.
     */
    if (assessed.some((a) => a.needs.length === 0)) {
      continue;
    }
    /*
     * Which arm to describe. A SINGLE-VALUE enum is how a discriminated union
     * is spelled, so `type: 'external'` leaves exactly one arm standing and
     * the message names that arm's missing field instead of every arm's.
     *
     * Only single-value enums narrow, which matters for the other repro:
     * `POST /v1/ai/tools` discriminates on nothing, and its `preset` enum has
     * two members. Narrowing on any enum would have dropped the preset arm —
     * the one whose allowed values the author needs to see.
     */
    const live = assessed.filter((a) => !wrongDiscriminator(a.arm, row));
    const shown = live.length > 0 ? live : assessed;
    const [only] = shown;
    if (shown.length === 1 && only !== undefined) {
      out.push(
        `${prefix}this route needs ${only.needs.join(', ')}, so the write will be refused. ` +
          'Set it in the document before applying.',
      );
      continue;
    }
    out.push(
      `${prefix}this route accepts ${String(rules.arms.length)} shapes and the row matches ` +
        `none of them — ${shown
          .map((a, i) => `shape ${String(i + 1)} needs ${a.needs.join(', ')}`)
          .join('; ')}, so the write will be refused.`,
    );
  }
  return out;
}

/**
 * What one arm is still missing from this row, named the way an author set it.
 *
 * Required fields, declared types, and the arm's own ENUMS — both the
 * field's and, for an array, its items'.
 *
 * The enums were deliberately left out of the first version, on the reasoning
 * that the field-level enum check reports a bad value with better wording.
 * That is true only of a MERGED enum: `type` is declared by both bot arms, so
 * `type: 'galaxy'` is caught there — but `type: 'external'` is a perfectly
 * good merged value and still forbidden by the chatly arm, and `preset:
 * 'nope'` is not in the merged table at all because only one arm declares it.
 * So the field-level check cannot see either, and leaving them out let a row
 * match an arm its own value ruled out (ForgeDeck 2026-11-07 item 1).
 */
export function armNeeds(
  arm: RouteFieldArm,
  row: DocumentRow,
  wires: ReadonlyMap<string, string>,
): ReadonlyArray<string> {
  const needs: string[] = [];
  for (const field of arm.required) {
    const value = row.body[field];
    const blank =
      value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
    // Same rule as `requiredFieldWarnings`: a required WIRE name counts as
    // present when the reference that supplies it is, and is named by the
    // document's own field when neither is.
    if (blank && row.refs[field] === undefined) {
      needs.push(`\`${wires.get(field) ?? field}\``);
    }
  }
  for (const [field, value] of Object.entries(row.body)) {
    const declared = arm.types[field];
    if (declared !== undefined && value !== undefined && value !== null) {
      const want = declared.split('|')[0] ?? 'string';
      if (!typeSatisfies(want, jsonTypeOf(value), value)) {
        needs.push(`\`${field}\` to be ${article(want)} ${want}`);
        continue;
      }
    }
    const allowed = arm.enums[field];
    if (allowed !== undefined && typeof value === 'string' && !allowed.includes(value)) {
      needs.push(
        `\`${field}\` to be one of ${allowed.map((v) => `\`${v}\``).join(', ')}` +
          ` (it is \`${value}\`)`,
      );
      continue;
    }
    /*
     * The arm's own ITEM enum, which the merged table cannot carry either: a
     * constraint merges only where every arm declares it, so an array field
     * one arm closes and another leaves open has no merged entry at all. The
     * merged check words a bad member with indices; here the arm is one
     * candidate among several, so it names the values rather than positions.
     */
    const allowedItems = arm.itemEnums[field];
    if (allowedItems !== undefined && Array.isArray(value)) {
      // `Array.isArray` narrows `unknown` to `any[]`, so the item needs
      // saying: these are whatever the author's JSON held.
      const items: ReadonlyArray<unknown> = value;
      const bad = items.filter((v) => typeof v !== 'string' || !allowedItems.includes(v));
      if (bad.length > 0) {
        needs.push(
          `\`${field}\` to carry only ${allowedItems.map((v) => `\`${v}\``).join(', ')} ` +
            `(it has ${bad.map((v) => `\`${String(v)}\``).join(', ')})`,
        );
        continue;
      }
    }
    /*
     * The arm's own length and form limits, which the merged table cannot
     * carry: a constraint merges only where every arm declares it, and the
     * tool `name` that ForgeDeck's repro broke is declared by ONE arm of
     * `POST /v1/ai/tools`. An arm the row fills but whose limits it breaks is
     * an arm the server refuses, so it counts as unmatched here for the same
     * reason a contradicted enum does.
     */
    const miss = stringRuleMiss(arm.strings[field], value);
    if (miss !== undefined) {
      needs.push(`\`${field}\` to ${miss}`);
    }
  }
  return needs;
}

/**
 * Whether the row's own values say the author did not mean this arm.
 *
 * SINGLE-VALUE enums only, because that is what a discriminator is: one arm
 * saying `type: 'external'` and the other `type: 'chatly'`. A multi-member
 * enum is an ordinary constrained field, and treating a bad value in one as a
 * "wrong arm" signal would hide the arm whose values the author needs to see —
 * `preset: 'nope'` would silently drop the preset arm from the message.
 *
 * Used ONLY to choose which arm to describe. Whether an arm MATCHES is
 * `armNeeds` alone; splitting those two was the item-1 defect.
 */
function wrongDiscriminator(arm: RouteFieldArm, row: DocumentRow): boolean {
  return Object.entries(row.body).some(([field, value]) => {
    const allowed = arm.enums[field];
    return (
      allowed !== undefined &&
      allowed.length === 1 &&
      typeof value === 'string' &&
      !allowed.includes(value)
    );
  });
}
