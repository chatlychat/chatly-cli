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
import { buildPlan } from './diff.js';
import { parseDocument } from './document.js';
import { resourceDef } from './resources.js';

const OPT_IN = { provider: 'cookie_munch', cbid: 'cb_live_1' };

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
  lastSignedCompletionAt: null,
});

describe('the opt-in is created with a PUT, not a POST', () => {
  it('PUTs to the provider path, because there is no create route', () => {
    const parsed = parseDocument(doc({ privacyPartners: [OPT_IN] }));
    const plan = buildPlan(parsed, live({ privacyPartners: [] }));
    expect(writesFor(def('privacyPartners'), plan.items[0]!, new Map(), APPLY)).toEqual([
      {
        method: 'PUT',
        path: '/v1/privacy/partners/cookie_munch',
        // The key is in the PATH, and the body is the opt-in minus it.
        body: { provider: 'cookie_munch', cbid: 'cb_live_1' },
      },
    ]);
  });

  it('PUTs to the same path on an update', () => {
    const parsed = parseDocument(doc({ privacyPartners: [{ ...OPT_IN, cbid: 'cb_live_2' }] }));
    const plan = buildPlan(
      parsed,
      live({ privacyPartners: [{ ...unbound('cookie_munch'), enabled: true, cbid: 'cb_live_1' }] }),
    );
    const ops = writesFor(def('privacyPartners'), plan.items[0]!, new Map(), APPLY);
    expect(ops[0]?.method).toBe('PUT');
    expect(ops[0]?.path).toBe('/v1/privacy/partners/cookie_munch');
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
    expect(d?.existsWhen?.(unbound('cookie_munch'))).toBe(false);
    expect(d?.existsWhen?.({ ...unbound('cookie_munch'), enabled: true })).toBe(true);
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
  it('is declared opaque AND a secret', () => {
    const d = resourceDef('privacyPartners');
    expect(d?.opaque).toContain('completionSecret');
    expect(d?.secrets).toContain('completionSecret');
  });

  /* A PUT with no `completionsUrl` CLEARS it, so a plan has to warn. */
  it('is a full replace, so an omitted field is a change', () => {
    expect(resourceDef('privacyPartners')?.fullReplace).toBe(true);
  });
});
