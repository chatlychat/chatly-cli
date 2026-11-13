/**
 * Turning a wrong value into a SENTENCE, split out of `field-rules-checks.ts`
 * when that file reached 677 of the 650 lines `check-file-size` allows.
 *
 * The seam: everything left there reads the generated table and decides what
 * the route will refuse; everything here decides what to tell the author
 * about it. `valueAt` comes along because it is the same kind of thing — a
 * pure reader with no opinion about the document.
 */

/**
 * The value at a dotted path, or `undefined` where any step is missing or is
 * not a plain object. An array stops the walk: `a.0.b` is not a path this
 * table ever emits, and treating an index as a key would invent one.
 */
export function valueAt(body: Readonly<Record<string, unknown>>, path: string): unknown {
  let cur: unknown = body;
  for (const part of path.split('.')) {
    if (typeof cur !== 'object' || cur === null || Array.isArray(cur)) {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * One wrong value, with the types that produced it rather than only its text.
 *
 * It carries `want`/`got`/`value` because `advice` has to decide from them.
 * It used to decide from the SENTENCE — appending `Quote it.` whenever the
 * text contained `a number` or `a boolean` — and that sentence names BOTH the
 * type the document has and the type the route wants, so it fired on three
 * cases where quoting is the mistake (ForgeDeck 2026-11-06 item 2, reproduced
 * twice): `enabled: "yes"` where a boolean is wanted (already quoted, and the
 * quoting IS the bug), `ttlSeconds: 1.5` where an integer is wanted (`"1.5"`
 * is refused too), and `eventTypes: 5` where an array is wanted.
 */
export interface Problem {
  readonly text: string;
  readonly want?: string;
  readonly got?: string;
  readonly value?: unknown;
  /** The closed set of values the field accepts, where it declares one. */
  readonly allowedValues?: ReadonlyArray<string>;
}

/**
 * The one-line fix, where there is one that is actually a fix.
 *
 * Quoting helps in exactly one direction: the route wants a STRING and the
 * document has a number or a boolean. Everything else needs a different
 * value, not different punctuation, and `resources-privacy.ts` already had
 * this written down — "`Quote it` is the fix for a scalar and nonsense for a
 * container" — while this function ignored it.
 *
 * A fraction where a whole number belongs gets its own line, because it is
 * the one case where the author is in the right TYPE and the wrong value, and
 * "the route requires an integer" does not say what to do about `1.5`.
 */
export function advice(problems: ReadonlyArray<Problem>): string {
  const out: string[] = [];
  const quotable = problems.filter(
    (p) => p.want === 'string' && (p.got === 'number' || p.got === 'boolean'),
  );
  /*
   * A field with a CLOSED SET of values is the third case where quoting is a
   * dead end, and the only one the type direction cannot reveal (ForgeDeck
   * 2026-11-07 item 2, reproduced twice). `scope: 5` on a macro wants a
   * string and has a number, so the rule below fires — and `"5"` is refused
   * too, by the enum. Following the advice produced a second plan that failed
   * for a different reason, which is worse than giving no advice at all.
   *
   * The allowed values go in its place. They are NOT reachable from the enum
   * check in `wrongTypeWarnings`: that one compares the field's own value and
   * only runs once the type is right, so it never sees `5`.
   */
  const closed = quotable.filter((p) => p.allowedValues !== undefined);
  out.push(
    ...closed.map(
      (p) => `It must be one of ${(p.allowedValues ?? []).map((v) => `\`${v}\``).join(', ')}.`,
    ),
  );
  if (quotable.length > closed.length) {
    out.push('Quote it.');
  }
  if (
    problems.some(
      (p) =>
        p.want === 'integer' &&
        p.got === 'number' &&
        typeof p.value === 'number' &&
        !Number.isInteger(p.value),
    )
  ) {
    out.push('Round it to a whole number — quoting it does not help.');
  }
  return out.length === 0 ? '' : ` ${out.join(' ')}`;
}
