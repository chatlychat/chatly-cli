/**
 * The JSON type vocabulary the field checks speak.
 *
 * Its own module because TWO checks need it and neither can own it: the
 * per-field check in `field-rules-checks.ts` and the per-arm check in
 * `union-arm-checks.ts`, which already imports `rulesFor` from the first.
 * Leaving these there and importing them back is a runtime import cycle, and
 * `check-import-cycles` is the gate that would have found it after the fact.
 *
 * Nothing here imports anything, which is what makes it safe to depend on
 * from both directions.
 */
/**
 * What the author WROTE, in the vocabulary they wrote it in.
 *
 * A whole number is reported as a `number`, never an `integer`: `integer` is
 * a thing a route can REQUIRE, not a thing JSON has, and the server's own
 * message says `Expected string, received number`. Describing `5` as "an
 * integer" to someone who typed `5` where a string belongs is a worse answer
 * for the same defect.
 */
export function jsonTypeOf(value: unknown): string {
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

/**
 * Whether the value satisfies the declared type.
 *
 * `integer` is the one declared type that is not a JSON type, so it is checked
 * against the VALUE: a route declaring `integer` refuses `1.5` and takes `60`,
 * and one declaring `number` takes both. String equality on the names gets one
 * of those two wrong whichever way it is written.
 */
export function typeSatisfies(want: string, got: string, value: unknown): boolean {
  if (want === 'integer') {
    return typeof value === 'number' && Number.isInteger(value);
  }
  return want === got;
}

export function article(kind: string): string {
  return kind === 'array' || kind === 'object' || kind === 'integer' ? 'an' : 'a';
}

/**
 * How a string value breaks the length or form the route declares, as a
 * fragment both checks can word.
 *
 * ForgeDeck 2026-11-07 item 3, reproduced twice: `systemPrompt: 'Be nice'`
 * and a tool named `fd-tool2` both planned clean and exited 2, and `apply`
 * answered `String must contain at least 20 character(s)` and `Invalid`.
 *
 * One helper and not two, because the merged check and the per-arm check read
 * the same data and the arm one is the only place an arm-specific limit is
 * visible. The caller supplies the verb — `must ${miss}` reads as the route's
 * refusal, `to ${miss}` as what a shape still needs.
 *
 * Returns `undefined` when there is nothing to say, including for a value
 * that is not a string: the TYPE check owns that message, and saying both
 * would blame the length of something that is not text.
 */
export function stringRuleMiss(
  rule: { readonly min?: number; readonly max?: number; readonly pattern?: string } | undefined,
  value: unknown,
): string | undefined {
  if (rule === undefined || typeof value !== 'string') {
    return undefined;
  }
  if (rule.min !== undefined && value.length < rule.min) {
    return (
      `be at least ${String(rule.min)} character${rule.min === 1 ? '' : 's'} ` +
      `(it is ${String(value.length)})`
    );
  }
  if (rule.max !== undefined && value.length > rule.max) {
    return (
      `be at most ${String(rule.max)} character${rule.max === 1 ? '' : 's'} ` +
      `(it is ${String(value.length)})`
    );
  }
  if (rule.pattern !== undefined && !matches(rule.pattern, value)) {
    return `match \`${rule.pattern}\` (it is \`${value}\`)`;
  }
  return undefined;
}

/**
 * A pattern this build of node cannot compile is NOT a finding.
 *
 * The table is generated from the served document, so a future route could
 * spell a construct `RegExp` here refuses. Throwing out of `plan` over it
 * would break every other check in the same run, and claiming the value is
 * wrong would be a warning about a document the server accepts — the one
 * failure this whole table exists to avoid.
 */
function matches(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return true;
  }
}
