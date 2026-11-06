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

import { bound, unbound, URL_OK } from './__tests__/privacy-fixtures.js';
import { def, doc, live } from './__tests__/wac-fixtures.js';
import { requiredFieldWarnings, sectionWarnings } from './diff-warnings.js';
import { buildPlan } from './diff.js';
import { parseDocument } from './document.js';

/** A registry row for a provider nobody has opted into, carrying the host rule. */
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
    const [w, ...rest] = requiredFieldWarnings(
      def('privacyPartners'),
      rowsFor({
        provider: 'cookiemunch',
      }),
    );
    expect(rest).toEqual([]);
    expect(w).toContain('cbid');
    expect(w).toContain('required');
  });

  /*
   * The second reported case, and the reason a presence test is not enough:
   * `""` is present and fails the route's `min(1)`.
   */
  it('warns on an EMPTY cbid, which a presence check would pass', () => {
    const [w, ...rest] = requiredFieldWarnings(
      def('privacyPartners'),
      rowsFor({
        provider: 'cookiemunch',
        cbid: '',
      }),
    );
    expect(rest).toEqual([]);
    expect(w).toContain('cbid');
  });

  it('warns on whitespace, which the route trims to empty', () => {
    expect(
      requiredFieldWarnings(
        def('privacyPartners'),
        rowsFor({ provider: 'cookiemunch', cbid: '  ' }),
      ),
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
      completionSecret: 'whsec_abcdefghijklmnop',
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
      completionSecret: 'whsec_abcdefghijklmnop',
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
        completionSecret: 'whsec_abcdefghijklmnop',
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
      completionSecret: 'whsec_abcdefghijklmnop',
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
      completionSecret: 'whsec_abcdefghijklmnop',
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
        completionSecret: 'whsec_abcdefghijklmnop',
      },
      [],
    );
    expect(w.some((x) => x.includes('only accepts'))).toBe(false);
  });

  /*
   * The wording follows the ROUTE, which answers "The completions URL must be
   * a public https URL" for anything `new URL()` refuses as well as for a URL
   * on a good host with the wrong scheme. This asserted its own earlier
   * phrasing ("is not a URL") until 2026-11-06; a warning that words a refusal
   * differently from the server sends the reader looking for a second rule.
   */
  it('warns when the URL is not a URL at all, in the route`s words', () => {
    const w = warnings({
      provider: 'cookiemunch',
      cbid: 'c',
      completionsUrl: 'not-a-url',
      completionSecret: 'whsec_abcdefghijklmnop',
    });
    expect(w.some((x) => x.includes('public https URL'))).toBe(true);
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
      completionSecret: 'whsec_abcdefghijklmnop',
    });
    expect(w).toEqual([]);
  });

  /** `sectionWarnings` is exported and used directly elsewhere; keep it callable. */
  it('sectionWarnings is the single aggregation point', () => {
    expect(typeof sectionWarnings).toBe('function');
  });
});

/* ── ForgeDeck's FIFTH report, 2026-11-06 items 3 and 4 ────────────────── */

/** Warnings for one document against an explicit live list. */
function against(
  body: Record<string, unknown>,
  liveRows: ReadonlyArray<Record<string, unknown>>,
): string[] {
  const parsed = parseDocument(doc({ privacyPartners: [body] }));
  return [...buildPlan(parsed, live({ privacyPartners: liveRows })).warnings];
}

describe('the host rule on a FIRST create', () => {
  /*
   * The regression that mattered, and the reason it survived its own test.
   *
   * `extraWarnings` was handed `live.rows`, which the fetch has already run
   * `existsWhen` over — and `existsWhen` here is `enabled === true`. On a
   * first opt-in the ONLY row carrying `completionHostSuffixes` is the unbound
   * one, so the list arrived empty, and an empty list is deliberately treated
   * as no evidence. Every rule keyed on the server's host list therefore did
   * nothing on exactly the call that needed it most.
   *
   * It passed anyway because `live()` in the fixtures returned `{ rows: v }`
   * with no filter at all, so the test fed the unbound row through a door
   * production closes. The fixture mirrors `fetchLive` now; this test fails
   * against the old `live.rows` read.
   */
  it('warns about a bad host when no binding exists yet', () => {
    const w = against(
      {
        provider: 'cookiemunch',
        cbid: 'c',
        completionsUrl: 'https://evil.example.com/x',
        completionSecret: 'whsec_abcdefghijklmnop',
      },
      [unbound()],
    );
    expect(w.some((x) => x.includes('evil.example.com') && x.includes('cookiemunch.net'))).toBe(
      true,
    );
  });

  it('still warns when a binding DOES exist', () => {
    const w = against(
      {
        provider: 'cookiemunch',
        cbid: 'c',
        completionsUrl: 'https://evil.example.com/x',
        completionSecret: 'whsec_abcdefghijklmnop',
      },
      [bound()],
    );
    expect(w.some((x) => x.includes('only accepts'))).toBe(true);
  });
});

describe('the rules mirror the route, in the route`s own order', () => {
  it('warns that a plain http URL is not a public https URL', () => {
    const w = against(
      {
        provider: 'cookiemunch',
        cbid: 'c',
        // A GOOD host, so this can only be the scheme.
        completionsUrl: 'http://api.cookiemunch.net/x',
        completionSecret: 'whsec_abcdefghijklmnop',
      },
      [unbound()],
    );
    expect(w.some((x) => x.includes('public https URL'))).toBe(true);
    /*
     * And NOT as a host complaint. `checkCompletionsUrl` tests the scheme
     * before the host, so a warning naming the host would send the reader to
     * the wrong line of their document.
     */
    expect(w.some((x) => x.includes('only accepts'))).toBe(false);
  });

  it('warns on a completionSecret that is not a whsec_ secret', () => {
    const w = against(
      { provider: 'cookiemunch', cbid: 'c', completionsUrl: URL_OK, completionSecret: 'hunter2' },
      [unbound()],
    );
    expect(w.some((x) => x.includes('whsec_'))).toBe(true);
  });

  /*
   * The RIGHT PREFIX and too short, which is the case a `startsWith` check
   * would pass. `whsec_abc` is what every test in this file used before
   * 2026-11-06 and the route has always refused it — three of those tests
   * failed the moment this rule existed, which is the rule earning its place
   * on fixtures nobody had checked against the route's own regex.
   */
  it('warns on a whsec_ secret that is too short for the route`s pattern', () => {
    const w = against(
      { provider: 'cookiemunch', cbid: 'c', completionsUrl: URL_OK, completionSecret: 'whsec_abc' },
      [unbound()],
    );
    expect(w.some((x) => x.includes('whsec_'))).toBe(true);
  });

  it('is silent on a secret that matches the route`s pattern', () => {
    const w = against(
      {
        provider: 'cookiemunch',
        cbid: 'c',
        completionsUrl: URL_OK,
        completionSecret: 'whsec_abcdefghijklmnop',
      },
      [unbound()],
    );
    expect(w).toEqual([]);
  });

  /*
   * A secret with nowhere to report. `requiredFields` cannot catch this — the
   * field is present and non-empty — and nor can the URL rules, which only run
   * when there IS a URL.
   */
  it('warns on a secret with no URL and none stored', () => {
    const w = against(
      { provider: 'cookiemunch', cbid: 'c', completionSecret: 'whsec_abcdefghijklmnop' },
      [unbound()],
    );
    expect(w.some((x) => x.includes('nowhere to report'))).toBe(true);
  });

  it('is silent on a secret with no URL when one IS stored — that is a rotation', () => {
    const w = against(
      { provider: 'cookiemunch', cbid: 'c', completionSecret: 'whsec_abcdefghijklmnop' },
      [bound()],
    );
    expect(w.some((x) => x.includes('nowhere to report'))).toBe(false);
  });

  /*
   * A NUMBER passes every `requiredFields` test — present, not null, not a
   * blank string — and is `Expected string, received number` at the route.
   */
  it('warns on a cbid that is a number', () => {
    const w = against({ provider: 'cookiemunch', cbid: 5 }, [unbound()]);
    expect(w.some((x) => x.includes('cbid') && x.includes('number'))).toBe(true);
  });

  it('is silent on a quoted cbid', () => {
    expect(against({ provider: 'cookiemunch', cbid: '5' }, [unbound()])).toEqual([]);
  });
});

describe('the secret warning on a live pair', () => {
  /*
   * ForgeDeck item 4, reproduced twice: a document setting only
   * `completionsUrl` on a partner that already has a secret stored was warned
   * that the server "refuses a URL with nothing to sign with". The server
   * accepts it — `enable` resolves each half as "what the caller sent, else
   * what is stored" — and `apply` exits 0. A warning that a working document
   * will fail teaches the reader to ignore warnings.
   */
  it('is silent when the live row reports completionSecretSet', () => {
    const w = against({ provider: 'cookiemunch', cbid: 'cb_live_1', completionsUrl: URL_OK }, [
      bound(),
    ]);
    expect(w.some((x) => x.includes('nothing to sign with'))).toBe(false);
  });

  it('still warns when no secret is stored', () => {
    const w = against({ provider: 'cookiemunch', cbid: 'cb_live_1', completionsUrl: URL_OK }, [
      bound({ completionSecretSet: false }),
    ]);
    expect(w.some((x) => x.includes('nothing to sign with'))).toBe(true);
  });
});

describe('what `plan` says a write will REPLACE', () => {
  /*
   * ForgeDeck item 4's second half. The generic sentence is "every field the
   * document omits reverts to its default", and for this resource that is
   * false: `PrivacyPartnerService.enable` keeps what the caller omitted. The
   * consequence is the expensive kind — somebody deleting `completionsUrl` to
   * stop reports would believe it was off while it was still reporting.
   */
  it('does not claim omitted fields revert, and names the real off switch', () => {
    const parsed = parseDocument(
      doc({ privacyPartners: [{ provider: 'cookiemunch', cbid: 'x' }] }),
    );
    const plan = buildPlan(parsed, live({ privacyPartners: [bound()] }));
    const extra = plan.items[0]?.notes.join(' ') ?? '';
    expect(plan.items[0]?.action).toBe('update');
    expect(extra).not.toContain('reverts to its default');
    expect(extra).toContain('completionsUrl: null');
  });

  /* The flag itself must stay: `cbid` is required on every PUT. */
  it('keeps sending every declared field', () => {
    expect(def('privacyPartners').fullReplace).toBe(true);
  });
});

describe('an empty completionsUrl is a value, not an absence', () => {
  const SEC = 'whsec_abcdefghijklmnop';
  /*
   * ForgeDeck's sixth report, item 2, reproduced twice: `completionsUrl: ''`
   * planned with NO warning and exited 2, then `apply` failed with
   * `completionsUrl: Invalid url`. The guard was `typeof url !== 'string' ||
   * url === ''`, so an empty string skipped every URL rule below it.
   */
  it('warns and refuses an empty string', () => {
    const w = against(
      { provider: 'cookiemunch', cbid: 'x', completionsUrl: '', completionSecret: SEC },
      [unbound()],
    );
    expect(w.some((x) => x.includes('public https URL'))).toBe(true);
  });

  it('counts it as refused so --exit-code answers 3', () => {
    const plan = buildPlan(
      parseDocument(
        doc({
          privacyPartners: [
            { provider: 'cookiemunch', cbid: 'x', completionsUrl: '', completionSecret: SEC },
          ],
        }),
      ),
      live({ privacyPartners: [unbound()] }),
    );
    expect(plan.refused).toEqual(['cookiemunch']);
  });

  /*
   * `null` is the DOCUMENTED off switch and must stay silent. A presence test
   * written as truthiness is what broke the empty string; written as `!= null`
   * it would break this, so both directions are pinned.
   */
  it('stays silent on null, which is the off switch', () => {
    const w = against({ provider: 'cookiemunch', cbid: 'cb_live_1', completionsUrl: null }, [
      bound(),
    ]);
    expect(w.some((x) => x.includes('public https URL'))).toBe(false);
    expect(w).toEqual([]);
  });

  it('plans null as an applyable update', () => {
    const plan = buildPlan(
      parseDocument(
        doc({
          privacyPartners: [{ provider: 'cookiemunch', cbid: 'cb_live_1', completionsUrl: null }],
        }),
      ),
      live({ privacyPartners: [bound()] }),
    );
    expect(plan.items[0]?.action).toBe('update');
    expect(plan.refused).toEqual([]);
  });
});
