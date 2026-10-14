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
import { resourceDef, type ResourceDef } from '../resources.js';

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

export function live(
  rows: Record<string, ReadonlyArray<Record<string, unknown>>>,
): Map<string, LiveSection> {
  return new Map(Object.entries(rows).map(([k, v]) => [k, { rows: v }]));
}

export function def(type: string): ResourceDef {
  const found = resourceDef(type);
  if (found === undefined) {
    throw new Error(`no such resource type: ${type}`);
  }
  return found;
}

/* ══ The schema ═══════════════════════════════════════════════════════════ */
