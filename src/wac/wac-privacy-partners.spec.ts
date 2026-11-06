/**
 * The `privacyPartners` resource (ForgeDeck 2026-11-05 item 10).
 *
 * Three things about it are unlike every other resource, and each is a
 * one-line field that a later edit could drop with nothing else failing — so
 * each gets a test naming the consequence rather than the field.
 */
import { describe, expect, it } from 'vitest';

import { APPLY, def, doc, live } from './__tests__/wac-fixtures.js';
import { writesFor } from './apply.js';
import { unknownKeyWarnings } from './diff-warnings.js';
import { buildPlan } from './diff.js';
import { parseDocument } from './document.js';
import { resourceDef } from './resources.js';

const OPT_IN = { provider: 'cookiemunch', cbid: 'cb_live_1' };

/** A registry row for a provider nobody has opted into. */
const unbound = (provider: string) => ({
  provider,
  label: provider,
  enabled: false,
  cbid: null,
  externalId: '0199f3c2-7a1e-7c3b-9d2a-5e4f6a7b8c9d',
  executorKeyUrl: `https://api.chatlychat.com/v1/privacy/partners/${provider}/{externalId}/executor-key`,
  lastMintedAt: null,
  completionsUrl: null,
  completionSecretSet: false,
  supportsCompletions: true,
  completionHostSuffixes: [],
  lastSignedCompletionAt: null,
});

describe('the opt-in is created with a PUT, not a POST', () => {
  it('PUTs to the provider path, because there is no create route', () => {
    const parsed = parseDocument(doc({ privacyPartners: [OPT_IN] }));
    const plan = buildPlan(parsed, live({ privacyPartners: [] }));
    expect(writesFor(def('privacyPartners'), plan.items[0]!, new Map(), APPLY)).toEqual([
      {
        method: 'PUT',
        path: '/v1/privacy/partners/cookiemunch',
        /*
         * The key is in the PATH and NOT in the body. The route's body is
         * `.strict()`, so a `provider` key here is a 400 and the opt-in
         * cannot be created at all — ForgeDeck 2026-11-05 item 1, which this
         * test shipped asserting rather than catching.
         */
        body: { cbid: 'cb_live_1' },
      },
    ]);
  });

  it('PUTs to the same path on an update', () => {
    const parsed = parseDocument(doc({ privacyPartners: [{ ...OPT_IN, cbid: 'cb_live_2' }] }));
    const plan = buildPlan(
      parsed,
      live({ privacyPartners: [{ ...unbound('cookiemunch'), enabled: true, cbid: 'cb_live_1' }] }),
    );
    const ops = writesFor(def('privacyPartners'), plan.items[0]!, new Map(), APPLY);
    expect(ops[0]?.method).toBe('PUT');
    expect(ops[0]?.path).toBe('/v1/privacy/partners/cookiemunch');
  });
});

describe('the registry row is not an existing resource', () => {
  /*
   * `GET /v1/privacy/partners` returns EVERY provider in the registry with
   * `enabled: false` for the ones nobody opted into. `existsWhen` filters
   * those at the fetch; this asserts what breaks without it — a document
   * naming a provider would see it as already present and plan an update
   * rather than the PUT that enables it.
   */
  it('plans a create for a provider that is listed but not enabled', () => {
    const parsed = parseDocument(doc({ privacyPartners: [OPT_IN] }));
    // Mirrors the filtered fetch: the unbound row never reaches the diff.
    const plan = buildPlan(parsed, live({ privacyPartners: [] }));
    expect(plan.items[0]?.action).toBe('create');
  });

  it('is the filter the fetch applies, and it selects on `enabled`', () => {
    const d = resourceDef('privacyPartners');
    expect(d?.existsWhen).toBeDefined();
    expect(d?.existsWhen?.(unbound('cookiemunch'))).toBe(false);
    expect(d?.existsWhen?.({ ...unbound('cookiemunch'), enabled: true })).toBe(true);
  });
});

describe('the completion secret is never rewritten blind', () => {
  /*
   * `completionSecret` is a `whsec_` secret the API never returns, so a diff
   * cannot tell whether it changed. Listed in `opaque`, which makes `plan`
   * say so and leave it alone unless `--write-only` is passed — the
   * alternative is re-sending a secret on every apply, which rotates nothing
   * and logs a write that changed no state.
   */
  it('is declared opaque, and deliberately NOT in `secrets`', () => {
    const d = resourceDef('privacyPartners');
    expect(d?.opaque).toContain('completionSecret');
    /*
     * This asserted `secrets` CONTAINED it until 2026-11-05, and that is what
     * made the false promise survive. `def.secrets` drives a line in
     * `planCreate` — "the create response carries a one-time
     * completionSecret, apply prints it once and writes it nowhere" — and
     * there has never been one to print: the value is an INPUT the operator
     * holds, and the route answers the boolean `completionSecretSet`.
     * ForgeDeck reported the absence twice, once as a missing feature and then
     * again as a false promise. `harvestSecrets` scans a write RESPONSE, so it
     * was always scanning for something absent.
     *
     * Asserted EMPTY rather than merely "not containing it", because the
     * promise is a property of the list being non-empty: a different entry
     * appearing here would print the same banner about a different field.
     */
    expect(d?.secrets).toEqual([]);
  });

  /* A PUT with no `completionsUrl` CLEARS it, so a plan has to warn. */
  it('is a full replace, so an omitted field is a change', () => {
    expect(resourceDef('privacyPartners')?.fullReplace).toBe(true);
  });
});

describe('a provider the server does not list is caught at plan time', () => {
  /*
   * ForgeDeck 2026-11-05 item 4, reproduced twice: a document naming the
   * provider `nope` planned as `create`, `plan` exited 0, and the PUT then
   * answered `404 Privacy partner not found`. `GET /v1/privacy/partners`
   * returns the whole REGISTRY, so the plan had the evidence in hand and
   * `existsWhen` was throwing it away — the filter that makes a create
   * plannable also hides the difference between "not opted in" and "no such
   * provider". `allKeys` carries the pre-filter list for exactly this.
   */
  const rows = parseDocument(doc({ privacyPartners: [{ provider: 'nope', cbid: 'x' }] }))
    .sections[0]!.rows;

  it('warns, naming the provider and what the server offers', () => {
    const [warning, ...rest] = unknownKeyWarnings(def('privacyPartners'), rows, [
      'cookiemunch',
      'osano',
    ]);
    expect(rest).toEqual([]);
    expect(warning).toContain('"nope"');
    expect(warning).toContain('404');
    expect(warning).toContain('cookiemunch, osano');
  });

  it('is silent on a provider that IS listed but not enabled', () => {
    const listed = parseDocument(doc({ privacyPartners: [OPT_IN] })).sections[0]!.rows;
    expect(unknownKeyWarnings(def('privacyPartners'), listed, ['cookiemunch'])).toEqual([]);
  });

  /*
   * Only for an `existsWhen` resource. Everywhere else an absent key is what a
   * create is FOR, so this would fire on every new row — and with no list at
   * all (a server that answered nothing) there is no evidence to warn on.
   */
  it('is silent for a resource whose list route holds only what exists', () => {
    expect(unknownKeyWarnings(def('bots'), rows, ['something'])).toEqual([]);
  });

  it('is silent when the pre-filter list is absent or empty', () => {
    expect(unknownKeyWarnings(def('privacyPartners'), rows, undefined)).toEqual([]);
    expect(unknownKeyWarnings(def('privacyPartners'), rows, [])).toEqual([]);
  });
});
