/**
 * The warnings `buildPlan` prints above a plan, one section at a time.
 *
 * Split out of `diff.ts` when CHT-F04's path parameters pushed that file past
 * the 650-line ceiling. It is a real seam rather than a cut: nothing here
 * decides an action. These functions only observe — a truncated list, rows
 * with no natural key, a key on two rows, a field no live row carries — and
 * the plan is the same with or without them.
 */
import { looksLikeCredential, normalizedKey, projected, type ResourceDef } from './resources.js';

import type { LiveIndex, LiveSection } from './diff.js';
import type { DocumentRow } from './document.js';

/* ── Warnings ─────────────────────────────────────────────────────────── */

export function sectionWarnings(
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
        'listed below at all — ' +
        (def.keylessHint ?? 'give them one in the dashboard to bring them under management.'),
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

  out.push(...unknownKeyWarnings(def, rows, live.allKeys));
  out.push(...vocabularyWarnings(def, rows, live.rows));
  return out;
}

/**
 * A key the server's own enumeration does not contain.
 *
 * ForgeDeck 2026-11-05 item 4, reproduced twice: a document naming the
 * provider `nope` planned as `create` and exited 0, and the PUT then answered
 * `404 Privacy partner not found` — a plan that said yes to the one thing it
 * could have said no to, with the evidence already in hand. `GET
 * /v1/privacy/partners` returns the whole registry, so an unlisted provider is
 * not a guess.
 *
 * Only for a resource with an `existsWhen`, because only there does the list
 * route enumerate more than the workspace holds. Everywhere else an absent key
 * is exactly what a create is FOR, and warning would fire on every new row.
 */
export function unknownKeyWarnings(
  def: ResourceDef,
  rows: ReadonlyArray<DocumentRow>,
  allKeys: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  if (def.existsWhen === undefined || allKeys === undefined || allKeys.length === 0) {
    return [];
  }
  const known = new Set(allKeys);
  const missing = rows
    .map((r) => r.key)
    .filter((k) => k !== '' && !known.has(normalizedKey(def, k)));
  if (missing.length === 0) {
    return [];
  }
  return [
    `${def.type}: ${missing.map((k) => `"${k}"`).join(', ')} — this server lists no ${def.label} ` +
      `by that ${def.naturalKey}, so the write will 404. It offers: ` +
      `${[...known].sort().join(', ')}.`,
  ];
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
