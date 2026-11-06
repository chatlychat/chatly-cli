/**
 * `plan` answers the questions the document already contains.
 *
 * ForgeDeck's fourth report, 2026-11-05 items 3 and 4, each reproduced twice.
 * Four documents planned as `create` and exited 0, and `apply` then refused
 * every one of them:
 *
 *   * no `cbid`                        -> `cbid: Required`
 *   * `cbid: ""`                       -> `String must contain at least 1 character(s)`
 *   * `completionsUrl` on another host -> `The completions URL must be on cookiemunch.net`
 *   * `completionsUrl`, no secret      -> a 200 that discarded the URL (now a 400)
 *
 * Every one of those facts was in the document the whole time, and `plan`
 * exists to answer exactly this before anything is written. A plan that says
 * yes to what the server will refuse is worse than no plan: it is a green
 * light with a failure behind it.
 *
 * The host rule is checked against `completionHostSuffixes`, which the list
 * route now returns, so this is a CHECK and not a second copy of the server's
 * rule. Both halves matter and both are tested: the warning follows a registry
 * that gains a host, and it stays silent when the server told us nothing.
 */
import { describe, expect, it } from 'vitest';

import { def, doc, live } from './__tests__/wac-fixtures.js';
import { requiredFieldWarnings, sectionWarnings } from './diff-warnings.js';
import { buildPlan } from './diff.js';
import { parseDocument } from './document.js';

const URL_OK = 'https://api.cookiemunch.net/v1/x';

/** A registry row for a provider nobody has opted into, carrying the host rule. */
const unbound = (suffixes: readonly string[] = ['cookiemunch.net']) => ({
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

const rowsFor = (body: Record<string, unknown>) =>
  parseDocument(doc({ privacyPartners: [body] })).sections[0]!.rows;

/** Everything `sectionWarnings` would print for one document against one registry. */
function warnings(body: Record<string, unknown>, suffixes?: readonly string[]): string[] {
  const parsed = parseDocument(doc({ privacyPartners: [body] }));
  const plan = buildPlan(parsed, live({ privacyPartners: [unbound(suffixes)] }));
  return [...plan.warnings];
}

describe('a required field the document omits', () => {
  it('warns when `cbid` is absent, naming it and saying the write is refused', () => {
    const [w, ...rest] = requiredFieldWarnings(def('privacyPartners'), rowsFor({
      provider: 'cookiemunch',
    }));
    expect(rest).toEqual([]);
    expect(w).toContain('cbid');
    expect(w).toContain('required');
  });

  /*
   * The second reported case, and the reason a presence test is not enough:
   * `""` is present and fails the route's `min(1)`.
   */
  it('warns on an EMPTY cbid, which a presence check would pass', () => {
    const [w, ...rest] = requiredFieldWarnings(def('privacyPartners'), rowsFor({
      provider: 'cookiemunch',
      cbid: '',
    }));
    expect(rest).toEqual([]);
    expect(w).toContain('cbid');
  });

  it('warns on whitespace, which the route trims to empty', () => {
    expect(
      requiredFieldWarnings(def('privacyPartners'), rowsFor({ provider: 'cookiemunch', cbid: '  ' })),
    ).toHaveLength(1);
  });

  it('is silent on a document that carries it', () => {
    expect(
      requiredFieldWarnings(
        def('privacyPartners'),
        rowsFor({ provider: 'cookiemunch', cbid: 'cb_live_1' }),
      ),
    ).toEqual([]);
  });

  /*
   * A resource that declares no `requiredFields` must be unaffected. Without
   * this the feature could be shipped as "warn on every empty field anywhere",
   * which would fire on every optional field in every other document.
   */
  it('is silent for a resource that declares none', () => {
    expect(requiredFieldWarnings(def('bots'), rowsFor({ provider: 'x' }))).toEqual([]);
  });
});

describe('the completions pair, checked before it is written', () => {
  it('warns on a completionsUrl with no completionSecret', () => {
    const w = warnings({ provider: 'cookiemunch', cbid: 'c', completionsUrl: URL_OK });
    expect(w.some((x) => x.includes('completionSecret'))).toBe(true);
  });

  it('is silent when both halves are present', () => {
    const w = warnings({
      provider: 'cookiemunch',
      cbid: 'c',
      completionsUrl: URL_OK,
      completionSecret: 'whsec_abc',
    });
    expect(w.some((x) => x.includes('completionSecret'))).toBe(false);
  });
});

describe('the completions host, checked against what the server published', () => {
  it('warns on a URL that is not on an allowed host', () => {
    const w = warnings({
      provider: 'cookiemunch',
      cbid: 'c',
      completionsUrl: 'https://evil.example.com/x',
      completionSecret: 'whsec_abc',
    });
    expect(w.some((x) => x.includes('evil.example.com') && x.includes('cookiemunch.net'))).toBe(
      true,
    );
  });

  it('accepts the host itself and any subdomain', () => {
    for (const url of ['https://cookiemunch.net/x', 'https://api.eu.cookiemunch.net/x']) {
      const w = warnings({
        provider: 'cookiemunch',
        cbid: 'c',
        completionsUrl: url,
        completionSecret: 'whsec_abc',
      });
      expect(w.some((x) => x.includes('only accepts'))).toBe(false);
    }
  });

  /*
   * The label boundary, which is the whole reason a suffix match is not a
   * `String.endsWith` on the bare suffix. `evilcookiemunch.net` ends with
   * `cookiemunch.net` and is a different registrable domain.
   */
  it('refuses a host that merely ENDS with the suffix', () => {
    const w = warnings({
      provider: 'cookiemunch',
      cbid: 'c',
      completionsUrl: 'https://evilcookiemunch.net/x',
      completionSecret: 'whsec_abc',
    });
    expect(w.some((x) => x.includes('only accepts'))).toBe(true);
  });

  /*
   * It FOLLOWS the server rather than holding its own copy: a registry that
   * gains a host makes the same document fine, with no CLI release.
   */
  it('follows the server when the registry lists another host', () => {
    const body = {
      provider: 'cookiemunch',
      cbid: 'c',
      completionsUrl: 'https://api.osano.com/x',
      completionSecret: 'whsec_abc',
    };
    expect(warnings(body).some((x) => x.includes('only accepts'))).toBe(true);
    expect(
      warnings(body, ['cookiemunch.net', 'osano.com']).some((x) => x.includes('only accepts')),
    ).toBe(false);
  });

  /*
   * And an empty list is NO EVIDENCE, not permission to warn. A server that
   * does not publish the field yet — every deployment older than this change —
   * must produce no host warnings at all rather than refusing every URL.
   */
  it('is silent when the server published no host list', () => {
    const w = warnings(
      {
        provider: 'cookiemunch',
        cbid: 'c',
        completionsUrl: 'https://anything.example.com/x',
        completionSecret: 'whsec_abc',
      },
      [],
    );
    expect(w.some((x) => x.includes('only accepts'))).toBe(false);
  });

  it('warns when the URL is not a URL at all', () => {
    const w = warnings({
      provider: 'cookiemunch',
      cbid: 'c',
      completionsUrl: 'not-a-url',
      completionSecret: 'whsec_abc',
    });
    expect(w.some((x) => x.includes('not a URL'))).toBe(true);
  });
});

describe('the warnings reach a real plan', () => {
  /*
   * `requiredFieldWarnings` and `extraWarnings` are wired inside
   * `sectionWarnings`, and a function nothing calls warns nobody — this is the
   * test that fails if the two `out.push` lines are dropped.
   */
  it('a plan over a bad document carries both kinds of warning', () => {
    const w = warnings({ provider: 'cookiemunch', completionsUrl: 'https://evil.example.com/x' });
    expect(w.some((x) => x.includes('cbid'))).toBe(true);
    expect(w.some((x) => x.includes('completionSecret'))).toBe(true);
    expect(w.some((x) => x.includes('only accepts'))).toBe(true);
  });

  it('a good document plans with no warnings of either kind', () => {
    const w = warnings({
      provider: 'cookiemunch',
      cbid: 'cb_live_1',
      completionsUrl: URL_OK,
      completionSecret: 'whsec_abc',
    });
    expect(w).toEqual([]);
  });

  /** `sectionWarnings` is exported and used directly elsewhere; keep it callable. */
  it('sectionWarnings is the single aggregation point', () => {
    expect(typeof sectionWarnings).toBe('function');
  });
});
