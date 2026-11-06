/**
 * Live `privacyPartners` rows, shaped like the list route's answer.
 *
 * Shared by `wac-privacy-field-rules.spec.ts` (what the rules SAY) and
 * `wac-privacy-refusal-reporting.spec.ts` (what `plan` COUNTS and PRINTS).
 * They were one 683-line file until 2026-11-06, which is 33 over the ceiling;
 * the seam is that question, not an arbitrary cut.
 *
 * `unbound` is the shape that matters most and the one a test is most likely
 * to get wrong: a provider the server OFFERS and nobody has opted into.
 * `existsWhen` for this resource is `enabled === true`, so `fetchLive` filters
 * this row out of `rows` and keeps it in `allRows` — and it is the only row
 * carrying `completionHostSuffixes`, which is why every host rule was dead on
 * a first create. See the fixture note in `wac-fixtures.ts`.
 */

/** A URL on a host the fixture server accepts. */
export const URL_OK = 'https://api.cookiemunch.net/v1/x';

export const unbound = (suffixes: readonly string[] = ['cookiemunch.net']) => ({
  provider: 'cookiemunch',
  label: 'cookiemunch',
  enabled: false,
  cbid: null,
  externalId: '0199f3c2-7a1e-7c3b-9d2a-5e4f6a7b8c9d',
  executorKeyUrl: 'https://api.chatlychat.com/v1/privacy/partners/cookiemunch/{externalId}/key',
  lastMintedAt: null,
  completionsUrl: null,
  completionSecretSet: false,
  supportsCompletions: true,
  completionHostSuffixes: suffixes,
  lastSignedCompletionAt: null,
});

/** A live row for a provider somebody HAS opted into, with both halves stored. */
export const bound = (over: Record<string, unknown> = {}) => ({
  ...unbound(),
  enabled: true,
  cbid: 'cb_live_1',
  completionsUrl: 'https://api.cookiemunch.net/v1/stored',
  completionSecretSet: true,
  ...over,
});
