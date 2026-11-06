/**
 * Shared fixtures for the workspace-as-code suites.
 *
 * Extracted when `wac.spec.ts` reached 717 of the 650 lines
 * `check-file-size` allows. Split at the FIXTURE boundary rather than by
 * trimming assertions: there is not one assertion in this file, so a reader
 * looking for what is pinned still finds all of it in a `*.spec.ts`.
 */

import { type ApplyOptions } from '../apply.js';
import { type LiveSection } from '../diff.js';
import { DocumentError, parseDocument } from '../document.js';
import { naturalKeys, resourceDef, type ResourceDef } from '../resources.js';

export const APPLY: ApplyOptions = { prune: false, pruneUnsafe: [], writeOnly: false };

export function doc(resources: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { version: 1, resources, ...extra };
}

export function issues(input: unknown, env: Record<string, string> = {}): string[] {
  try {
    parseDocument(input, env);
  } catch (err) {
    if (err instanceof DocumentError) {
      return err.issues.map((i) => `${i.path}: ${i.message}`);
    }
    throw err;
  }
  return [];
}

/**
 * The live index as the REAL fetch builds it, which is not what this used to
 * return.
 *
 * It was `{ rows: v }` — no `existsWhen` filter, no `allKeys`, no `allRows` —
 * and `fetchLive` in `workspace-as-code.ts` does all three. For the one
 * resource with an `existsWhen` that difference was the bug rather than a
 * detail: `privacyPartners` lists the whole registry with `enabled: false` for
 * what nobody opted into, the real `plan` never sees those rows in
 * `live.rows`, and this fixture handed them over. So every rule reading a
 * field off the unbound row was tested against a shape production never
 * produces, and the host check passed here while doing nothing on a first
 * create — ForgeDeck's fifth report, 2026-11-06 item 3.
 *
 * A fixture that invents a shape makes the suite agree with the bug. Mirror
 * `fetchLive` here, and if that function changes, change this with it.
 */
export function live(
  rows: Record<string, ReadonlyArray<Record<string, unknown>>>,
): Map<string, LiveSection> {
  return new Map(
    Object.entries(rows).map(([k, v]) => {
      const def = resourceDef(k);
      if (def?.existsWhen === undefined) {
        return [k, { rows: v }];
      }
      const kept = v.filter((r) => def.existsWhen?.(r) === true);
      return [k, { rows: kept, allKeys: naturalKeys(def, v), allRows: v }];
    }),
  );
}

export function def(type: string): ResourceDef {
  const found = resourceDef(type);
  if (found === undefined) {
    throw new Error(`no such resource type: ${type}`);
  }
  return found;
}

/* ══ The schema ═══════════════════════════════════════════════════════════ */
