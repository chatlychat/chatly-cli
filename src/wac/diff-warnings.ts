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

import type { LiveIndex, LiveSection, PlanItem } from './diff.js';
import type { DocumentRow } from './document.js';

/* ── Warnings ─────────────────────────────────────────────────────────── */

/** The one place a per-row warning's prefix is written, so a key can be matched back. */
export function rowPrefix(def: ResourceDef, key: string): string {
  return `${def.type}/${key}: `;
}

export function sectionWarnings(
  def: ResourceDef,
  rows: ReadonlyArray<DocumentRow>,
  live: LiveSection,
  index: LiveIndex,
  willSend: (key: string) => boolean,
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
  out.push(...requiredFieldWarnings(def, rows));
  /*
   * The UNFILTERED answer, because that is what a warning wants to observe.
   * `live.rows` has had `existsWhen` applied, so on a first create the row
   * carrying the server's own rules is gone — which is how the privacy host
   * check came to work only when a binding already existed.
   */
  out.push(...(def.extraWarnings?.(rows, live.allRows ?? live.rows, willSend) ?? []));
  return out;
}

/**
 * A required field the document omits, or sets to something empty.
 *
 * ForgeDeck 2026-11-05 item 4, reproduced twice: a `privacyPartners` row with
 * no `cbid` and one with `cbid: ""` both planned as `create` and exited 0, and
 * `apply` then failed with `cbid: Required` and `String must contain at least
 * 1 character(s)`. Both facts were in the document the whole time.
 *
 * Only on rows this plan would CREATE, which is why `liveKeys` is taken: an
 * update sends a partial body and a field absent from it is "leave as stored",
 * so warning there would fire on every narrow edit. An empty STRING is checked
 * as well as an absent key because `""` passes a presence test and fails the
 * route, which is the second of the two reported cases.
 */
export function requiredFieldWarnings(
  def: ResourceDef,
  rows: ReadonlyArray<DocumentRow>,
): ReadonlyArray<string> {
  const required = def.requiredFields;
  if (required === undefined || required.length === 0) {
    return [];
  }
  const out: string[] = [];
  for (const row of rows) {
    const missing = required.filter((f) => {
      const v = row.body[f];
      return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
    });
    if (missing.length > 0) {
      out.push(
        `${rowPrefix(def, row.key)}${missing.map((f) => `\`${f}\``).join(', ')} ` +
          `${missing.length === 1 ? 'is' : 'are'} required and ` +
          `${missing.length === 1 ? 'is' : 'are'} missing or empty, so the write will be ` +
          'refused. Set it in the document before applying.',
      );
    }
  }
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

/**
 * The sentence `plan` prints above a `fullReplace` update.
 *
 * `fullReplace` governs what `apply` SENDS — every declared field, because a
 * partial body would reset the rest. Whether the SERVER then resets what the
 * document omitted is a separate question, and for one resource the answer is
 * no, so the sentence is overridable per resource.
 *
 * ForgeDeck's fifth report, 2026-11-06 item 4, reproduced twice: a
 * `privacyPartners` document carrying only `cbid` planned with "every field
 * the document omits reverts to its default", and after `apply` the live row
 * still had its `completionsUrl` and `completionSecretSet: true`.
 * `PrivacyPartnerService.enable` resolves each half as "what the caller sent,
 * else what is stored", so an omitted field is KEPT. Someone removing the URL
 * to stop reports would believe it was off while it was still reporting —
 * the most expensive kind of wrong, because the plan said the right thing
 * would happen.
 *
 * The flag stays `true` on that resource and must: `cbid` is required on every
 * PUT, so a partial body is a 400. Only the sentence was wrong.
 *
 * Lives here rather than in `diff.ts` because that file sits exactly at the
 * 650-line ceiling, and this is the file whose entire job is the warnings
 * `buildPlan` prints.
 */
export function fullReplaceWarnings(def: ResourceDef): ReadonlyArray<string> {
  if (def.fullReplace !== true) {
    return [];
  }
  return [
    def.fullReplaceNote ??
      `the write REPLACES this ${def.label}: every field the document omits reverts to its ` +
        'default. Declare the whole resource here, not just what you want changed.',
  ];
}

/**
 * Which rows the server is going to REFUSE, as keys.
 *
 * ForgeDeck's fifth report (2026-11-06, item 3): seven documents each planned
 * as `1 to create … 0 that cannot be applied` and exited 2 — the same code a
 * good change exits — and `apply` then refused every one. A warning nobody
 * counts does not reach a pipeline, so `plan` looked identical whether the
 * change was ready or doomed.
 *
 * Derived from the MESSAGES rather than re-running the rules, because a second
 * evaluation is a second place to be wrong: two copies of the same predicate
 * drift and then the count disagrees with the text above it. Matching is exact
 * — the candidate keys are known, and `rowPrefix` is the single place the
 * prefix is written — so this is not parsing.
 *
 * `unknownKeyWarnings` is a refusal too (the PUT answers 404) and it aggregates
 * every unlisted key into ONE section-level message, so its rows are added from
 * the same `allKeys` test it uses rather than from its text.
 *
 * ─── ONLY ROWS `apply` WOULD SEND ─────────────────────────────────────────
 *
 * It takes the PLAN ITEMS, not the document rows, and keeps only `create` and
 * `update`. ForgeDeck's sixth report (2026-11-06 item 1), reproduced twice: a
 * document carrying a `completionSecret` and no `completionsUrl` against a live
 * row whose completions are already off planned `unchanged` — a secret is a
 * credential, so `looksLikeCredential` keeps it out of the diff — and `plan`
 * printed `REFUSED` and exited 3 while `apply` sent nothing and exited 0.
 *
 * The warning itself is still right and still printed: a secret sitting in a
 * document with nowhere to report is worth saying. What was wrong was calling
 * it a refusal, because the server never sees it. A `REFUSED` line on a
 * document that applies cleanly teaches the reader to ignore the line, which
 * is the same argument the `completionsUrl`-with-a-stored-secret warning was
 * removed on one report earlier.
 *
 * `blocked` is an ACTION, so a row is never both blocked and refused — which
 * is what lets the summary add the two counts without double-counting.
 */
export function refusedRowKeys(
  def: ResourceDef,
  items: ReadonlyArray<PlanItem>,
  live: LiveSection,
  messages: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const rows: DocumentRow[] = [];
  for (const item of items) {
    if (item.type !== def.type || item.row === undefined) {
      continue;
    }
    if (item.action === 'create' || item.action === 'update') {
      rows.push(item.row);
    }
  }
  const out = new Set<string>();
  for (const row of rows) {
    if (messages.some((m) => m.startsWith(rowPrefix(def, row.key)))) {
      out.add(row.key);
    }
  }
  const known = def.existsWhen === undefined ? undefined : live.allKeys;
  if (known !== undefined && known.length > 0) {
    const set = new Set(known);
    for (const row of rows) {
      // Same test `unknownKeyWarnings` applies, including its empty-key guard.
      if (row.key !== '' && !set.has(normalizedKey(def, row.key))) {
        out.add(row.key);
      }
    }
  }
  return [...out];
}
