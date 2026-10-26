/**
 * Which value a document row is matched on — split out of `document.ts` when
 * CHT-F04's parented rows pushed it past the 650-line ceiling.
 *
 * A real seam: `parseSection` decides what a row IS, this decides only what
 * it is CALLED, and the two shapes (one authored field, or a parent and a
 * child joined) are the whole of the difference between the workspace and
 * the platform document at the row level.
 */
import { addressOf, type ResourceDef } from './resource-def.js';

import type { Issue } from './document.js';

/** `a`, `b` and `c` — these go in error messages, so they read as English. */
export function list(names: ReadonlyArray<string>): string {
  if (names.length <= 1) {
    return names[0] ?? '(none)';
  }
  return `${names.slice(0, -1).join(', ')} and ${String(names[names.length - 1])}`;
}

/**
 * The value this row is matched on, or `undefined` with the issue recorded.
 *
 * Two shapes. A FLAT resource is matched on one authored field — a slug, a
 * short code, a url — and that field is `def.naturalKey`. A PARENTED one is
 * matched on `<parent>/<child>`, because an email identifies a member inside
 * one workspace and nothing at all across a platform document that describes
 * four of them; `def.naturalKey` is then the synthetic `address` and appears
 * on neither side of the wire.
 *
 * The parent field itself is NOT consumed here. It is a reference
 * (`def.references`), so the loop below strips it out of the body and
 * resolves the slug to an id — this only reads it, and reads it before that
 * loop runs, because a row with no parent cannot be addressed at all.
 */
export function keyOf(
  issues: Issue[],
  def: ResourceDef,
  row: Record<string, unknown>,
  path: string,
): string | undefined {
  /** What the message adds when only this file keeps the key unique. */
  const notUnique = (what: string): string =>
    def.keyEnforced
      ? ''
      : ` Note the database does NOT make \`${what}\` unique for this resource, so this file ` +
        'is the only thing keeping it unique.';

  if (def.parent !== undefined) {
    const { field, childKey, type } = def.parent;
    const parentValue = row[field];
    const childValue = row[childKey];
    const missing: string[] = [];
    if (typeof parentValue !== 'string' || parentValue.length === 0) {
      missing.push(`\`${field}\`: the \`${type}\` natural key, as a string`);
    }
    if (typeof childValue !== 'string' || childValue.length === 0) {
      missing.push(`\`${childKey}\`: a non-empty string`);
    }
    if (missing.length > 0) {
      issues.push({
        path,
        message:
          `every ${def.label} needs ${list(missing)}. Together they are what this file ` +
          `matches on — ${childKey} alone cannot identify a ${def.label}, because the same ` +
          `${childKey} in two workspaces is two different things.` +
          notUnique(`${field}` + ' plus ' + `${childKey}`),
      });
      return undefined;
    }
    return addressOf(String(parentValue), String(childValue));
  }

  const keyValue = row[def.naturalKey];
  if (typeof keyValue !== 'string' || keyValue.length === 0) {
    /*
     * The one field this file insists on, and the message says why rather
     * than just "required": somebody reading it on a fresh checkout needs
     * to know that the uuid they were about to paste is the wrong answer.
     */
    issues.push({
      path: `${path}.${def.naturalKey}`,
      message:
        `every ${def.label} needs \`${def.naturalKey}\`: a non-empty string. It is the ` +
        'natural key this file matches on, so `plan` can tell a create from an update ' +
        'without a server uuid — which does not exist yet in a new environment.' +
        notUnique(def.naturalKey),
    });
    return undefined;
  }
  if (def.keyPattern !== undefined && !def.keyPattern.test(keyValue)) {
    issues.push({
      path: `${path}.${def.naturalKey}`,
      message: `\`${def.naturalKey}\` "${keyValue}" must match ${String(def.keyPattern)}.`,
    });
    return undefined;
  }
  return keyValue;
}
