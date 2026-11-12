/**
 * Values shared by `resources.ts` and the resource definitions that live
 * outside it.
 *
 * Its own file because the first attempt had `resources-privacy.ts` import
 * `SERVER_OWNED` back from `resources.ts`, which `check-import-cycles` caught
 * as a RUNTIME cycle — the kind that crashes at boot rather than failing to
 * build, since both modules evaluate a `const` at module scope.
 */

/**
 * The natural key of a SINGLETON resource — one row per workspace, no id
 * (CH-24).
 *
 * Here rather than in `resources-singletons.ts` because BOTH sides have to
 * agree on it: `rowsFrom` stamps it onto the live answer and `parseSection`
 * stamps it onto the document row, and if the two ever differed the row
 * would plan as a create for a resource with no create route. One constant,
 * imported by both.
 */
export const SINGLETON_KEY = 'default';

/** Columns the server owns on every resource; no document may write them. */
export const SERVER_OWNED = ['id', 'workspaceId', 'createdAt', 'updatedAt'] as const;

/**
 * `normaliseShortCode` on the server: strip a leading `/`, then lowercase.
 *
 * Here rather than inline in the `macros` definition so the rules in
 * `resource-conditionals.ts` cannot drift from the `normalizeKey` the row
 * matching uses — two copies of a normaliser is two answers to "is this row
 * already on the server", and this one decides whether a create-only warning
 * fires.
 */
export const normaliseShortCode = (key: string): string => key.replace(/^\//, '').toLowerCase();

/**
 * A JSON object, or `undefined` — `null` and an array are NOT objects here.
 *
 * Here rather than in `resources.ts` because `resource-conditionals.ts` needs
 * the same test and importing it back from `resources.ts` is the runtime
 * cycle `SERVER_OWNED` is in this file to avoid.
 *
 * **The `value !== null` clause is the whole point.** `typeof null` is
 * `'object'`, and `resource-conditionals.ts` shipped a hand-rolled
 * `typeof live?.['externalAgent'] === 'object'` that was therefore true for
 * every Chatly bot — `toBotView` returns `externalAgent: null` for one — so
 * each one was read as an external agent and its discarded delivery config
 * was diffed for ever. Use this; do not write the test again.
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
