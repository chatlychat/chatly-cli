/**
 * Comparing two JSON values, and spotting one the server would not show us.
 *
 * Split out of `diff.ts` to keep both under the 650-line ceiling
 * (`scripts/check-file-size.mjs`). These two functions carry two of the four
 * rules in `diff.ts`'s header and are worth reading on their own: rule 3
 * (absent and `undefined` are one state, and only `null` is a value) lives in
 * `sameValue`, and the runtime half of rule 2 lives in `isRedacted`.
 */

/** The sentinel the API substitutes for a credential-bearing value. */
export const REDACTED = '__redacted__';

/* ── Value comparison ─────────────────────────────────────────────────── */

/** Deep structural equality over JSON values. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  // Rule 3: absent and `undefined` are one state; `null` is a value.
  if ((a === undefined || a === null) && (b === undefined || b === null)) {
    return (a === null) === (b === null);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((v, i) => sameValue(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
      if (!sameValue(ao[k], bo[k])) {
        return false;
      }
    }
    return true;
  }
  return false;
}

/** Does this value carry the redaction sentinel anywhere inside it? */
export function isRedacted(value: unknown): boolean {
  if (value === REDACTED) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(isRedacted);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value as Record<string, unknown>).some(isRedacted);
  }
  return false;
}

/* ── Merge-written fields ─────────────────────────────────────────────── */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The part of a live value a MERGE-written field describes: the keys the
 * document names, recursively. The server keeps every key the write omits,
 * so an omitted key is not a difference. Arrays are compared whole — a list
 * the document names is the list it wants.
 */
export function narrowTo(live: unknown, desired: unknown): unknown {
  if (!isPlainObject(live) || !isPlainObject(desired)) {
    return live;
  }
  return Object.fromEntries(Object.keys(desired).map((k) => [k, narrowTo(live[k], desired[k])]));
}

/**
 * A MERGE-written object compared leaf by leaf, so one redacted credential
 * hides itself and nothing else. `live` and `desired` come back with every
 * path whose live value is `__redacted__` (or sits inside a redacted array)
 * removed from BOTH; `redacted` says whether any was. Without this a single
 * `identityVerification.secret` in a channel's `config` made the whole
 * `config` unreadable, and drift on its other keys went unreported.
 */
export function splitRedacted(
  live: unknown,
  desired: unknown,
): { live: unknown; desired: unknown; redacted: boolean } {
  if (isPlainObject(live) && isPlainObject(desired)) {
    const l: Record<string, unknown> = {};
    const d: Record<string, unknown> = {};
    let redacted = false;
    for (const k of Object.keys(desired)) {
      const r = splitRedacted(live[k], desired[k]);
      if (r.redacted) {
        redacted = true;
      }
      if (r.live !== SKIP) {
        l[k] = r.live;
        d[k] = r.desired;
      }
    }
    return { live: l, desired: d, redacted };
  }
  return isRedacted(live)
    ? { live: SKIP, desired: SKIP, redacted: true }
    : { live, desired, redacted: false };
}
const SKIP = Symbol('redacted');
