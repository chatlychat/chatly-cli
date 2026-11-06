/**
 * What `plan` COUNTS and PRINTS about a document the server will refuse.
 *
 * The sibling file, `wac-privacy-field-rules.spec.ts`, asserts what each rule
 * SAYS. This one asserts what happens to that sentence afterwards: whether it
 * reaches `plan.refused`, the summary line, the footer and `--json`. They were
 * one file until 2026-11-06, when it reached 683 lines — 33 over the ceiling.
 *
 * The distinction the whole file turns on: `blocked` is a plan ACTION (this
 * CLI will not send the row) and `refused` is a prediction about the SERVER
 * (it will send it and be told no). A row is never both, which is what lets
 * the summary add the two counts.
 */
import { describe, expect, it } from 'vitest';

import { bound, unbound, URL_OK } from './__tests__/privacy-fixtures.js';
import { doc, live } from './__tests__/wac-fixtures.js';
import { buildPlan } from './diff.js';
import { parseDocument } from './document.js';
import { planFooter, planForJson, renderPlan } from './render.js';

describe('refused rows are counted, not just described', () => {
  /*
   * ForgeDeck item 3: seven unapplyable documents each planned as `0 that
   * cannot be applied` and exited 2 — the code a GOOD change exits — so
   * nothing downstream could tell a ready change from a doomed one.
   */
  it('counts a row the server will refuse', () => {
    const parsed = parseDocument(doc({ privacyPartners: [{ provider: 'cookiemunch' }] }));
    const plan = buildPlan(parsed, live({ privacyPartners: [unbound()] }));
    expect(plan.refused).toEqual(['cookiemunch']);
  });

  it('counts a row ONCE even when it breaks several rules', () => {
    const parsed = parseDocument(
      doc({
        privacyPartners: [
          { provider: 'cookiemunch', completionsUrl: 'nope', completionSecret: 'x' },
        ],
      }),
    );
    const plan = buildPlan(parsed, live({ privacyPartners: [unbound()] }));
    expect(plan.refused).toEqual(['cookiemunch']);
  });

  /* An unlisted provider is a 404 at the PUT, and its warning is section-level. */
  it('counts a provider the server does not list', () => {
    const parsed = parseDocument(doc({ privacyPartners: [{ provider: 'nope', cbid: 'x' }] }));
    const plan = buildPlan(parsed, live({ privacyPartners: [unbound()] }));
    expect(plan.refused).toEqual(['nope']);
  });

  it('is empty for a document the server will accept', () => {
    const parsed = parseDocument(
      doc({
        privacyPartners: [
          {
            provider: 'cookiemunch',
            cbid: 'c',
            completionsUrl: URL_OK,
            completionSecret: 'whsec_abcdefghijklmnop',
          },
        ],
      }),
    );
    expect(buildPlan(parsed, live({ privacyPartners: [unbound()] })).refused).toEqual([]);
  });
});
describe('a refusal is only a refusal if `apply` would send it', () => {
  const SEC = 'whsec_abcdefghijklmnop';
  /* Completions switched off earlier with `completionsUrl: null`. */
  const offRow = () => bound({ cbid: 'z', completionsUrl: null });
  const straySecret = () =>
    buildPlan(
      parseDocument(
        doc({ privacyPartners: [{ provider: 'cookiemunch', cbid: 'z', completionSecret: SEC }] }),
      ),
      live({ privacyPartners: [offRow()] }),
    );

  /*
   * ForgeDeck's SIXTH report, 2026-11-06 item 1, reproduced twice.
   *
   * The row plans as `unchanged` — `cbid` matches and a secret is a credential
   * that `looksLikeCredential` keeps out of the diff — so `apply` sends
   * nothing and exits 0, while `plan` printed `REFUSED` and exited 3. A
   * pipeline gating on 3 stopped for a document that applies cleanly.
   *
   * This is the test that fails against the old code, where `refusedRowKeys`
   * was handed `section.rows` before any item existed and so could not know
   * what would be sent.
   */
  it('does not count a row that plans as unchanged', () => {
    const plan = straySecret();
    expect(plan.items[0]?.action).toBe('noop');
    expect(plan.refused).toEqual([]);
  });

  /*
   * And the warning STAYS. A secret sitting in a document with nowhere to
   * report is worth saying; what was wrong was calling it a refusal. Pinning
   * both halves, because "stop exiting 3" is also satisfied by deleting the
   * rule, which would lose the only notice the reader gets.
   */
  /*
   * The warning is KEPT — deleting the rule would also stop the exit 3 on a
   * first create, and would lose the only notice a stray secret gets. Its
   * WORDING changed in the seventh report: on this unchanged row nothing is
   * sent, so "nowhere to report ... the server refuses it" described an
   * exchange that never happened. Asserted here as "a warning still names the
   * field", which is the part ForgeDeck asked to keep, with the sentence
   * itself pinned in `a stray secret is described by what this run will do`.
   */
  it('still warns about the stray secret', () => {
    const warnings = straySecret().warnings;
    expect(warnings.some((w) => w.includes('completionSecret') || w.includes('this secret'))).toBe(
      true,
    );
    expect(warnings.some((w) => w.includes('this secret is not sent'))).toBe(true);
  });

  /* Their verify line: a FIRST create with the same shape must still exit 3. */
  it('still counts a secret with no URL on a first create', () => {
    const plan = buildPlan(
      parseDocument(
        doc({ privacyPartners: [{ provider: 'cookiemunch', cbid: 'c', completionSecret: SEC }] }),
      ),
      live({ privacyPartners: [unbound()] }),
    );
    expect(plan.items[0]?.action).toBe('create');
    expect(plan.refused).toEqual(['cookiemunch']);
  });

  /* An UPDATE that the server will refuse is still a refusal — it is sent. */
  it('counts a bad host on a row it would update', () => {
    const plan = buildPlan(
      parseDocument(
        doc({
          privacyPartners: [
            {
              provider: 'cookiemunch',
              cbid: 'cb_live_1',
              completionsUrl: 'https://evil.example.com/x',
            },
          ],
        }),
      ),
      live({ privacyPartners: [bound()] }),
    );
    expect(plan.items[0]?.action).toBe('update');
    expect(plan.refused).toEqual(['cookiemunch']);
  });
});
describe('the summary and the JSON report a refusal', () => {
  const SEC = 'whsec_abcdefghijklmnop';
  const RENDER = { prune: false, pruneUnsafe: [] };
  const badHost = () =>
    buildPlan(
      parseDocument(
        doc({
          privacyPartners: [
            {
              provider: 'cookiemunch',
              cbid: 'x',
              completionsUrl: 'https://evil.example.com/x',
              completionSecret: SEC,
            },
          ],
        }),
      ),
      live({ privacyPartners: [unbound()] }),
    );

  /*
   * ForgeDeck's sixth report, item 3: the same output said `1 to create` and
   * `0 that cannot be applied`, and someone reading the first line runs
   * `apply`. The footer keeps `blocked` and `refused` apart in prose; the
   * summary is the wrong place for that distinction.
   */
  it('counts the refused row in `that cannot be applied`', () => {
    expect(renderPlan(badHost(), RENDER)).toContain('1 that cannot be applied');
  });

  it('does not tell the reader to run apply when every change is refused', () => {
    const footer = planFooter(badHost(), RENDER);
    expect(footer).not.toContain('Run `chatly apply`');
    expect(footer).toContain('nothing to apply that the server would accept');
  });

  /* And it DOES, when only some of them are — the rest are real work. */
  it('still tells the reader to run apply when one of two is fine', () => {
    const other = {
      ...unbound(['otherco.net']),
      provider: 'otherco',
      label: 'otherco',
    };
    const plan = buildPlan(
      parseDocument(
        doc({
          privacyPartners: [
            {
              provider: 'cookiemunch',
              cbid: 'x',
              completionsUrl: 'https://evil.example.com/x',
              completionSecret: SEC,
            },
            {
              provider: 'otherco',
              cbid: 'y',
              completionsUrl: 'https://api.otherco.net/x',
              completionSecret: SEC,
            },
          ],
        }),
      ),
      live({ privacyPartners: [unbound(), other] }),
    );
    expect(plan.refused).toEqual(['cookiemunch']);
    expect(planFooter(plan, RENDER)).toContain('Run `chatly apply`');
  });

  /*
   * Top level. The reason is prose inside `warnings`, so a script had only the
   * exit code to go on and could not say WHICH document was refused.
   */
  it('lists refused keys at the top level of --json', () => {
    const json = planForJson(badHost()) as { refused: readonly string[] };
    expect(json.refused).toEqual(['cookiemunch']);
  });
});

/*
 * ForgeDeck's SEVENTH report, 2026-11-06 item 1: every one of these planned
 * clean, printed `0 that cannot be applied` and `Run chatly apply`, exited 2,
 * and then `apply` exited 1 with `Expected string, received <type>`. Only
 * `cbid` was type-checked; the other two guarded with `typeof x === 'string'`,
 * which skips a wrong type rather than reporting it.
 */
describe('a wrong JSON type is caught before apply', () => {
  const planWith = (over: Record<string, unknown>) =>
    buildPlan(
      parseDocument(doc({ privacyPartners: [{ provider: 'cookiemunch', cbid: 'x', ...over }] })),
      live({ privacyPartners: [unbound()] }),
    );

  it.each([
    ['completionsUrl', 5, 'a number', ' Quote it.'],
    ['completionsUrl', true, 'a boolean', ' Quote it.'],
    ['completionsUrl', [], 'an array', ''],
    ['completionsUrl', {}, 'an object', ''],
    ['completionSecret', 5, 'a number', ' Quote it.'],
    ['completionSecret', false, 'a boolean', ' Quote it.'],
    ['cbid', 5, 'a number', ' Quote it.'],
  ] as const)('refuses %s = %j as %s', (field, value, named, advice) => {
    const plan = planWith(field === 'cbid' ? { cbid: value } : { [field]: value });
    expect(plan.refused).toEqual(['cookiemunch']);
    expect(plan.warnings.join('\n')).toContain(
      `\`${field}\` is ${named} and the route requires a string, so the write will be ` +
        `refused.${advice}`,
    );
  });

  /*
   * The type name has to match the route's own refusal. zod says `array` for
   * `[]`, where `typeof` says `object` — a warning naming a different type
   * than the error sends the reader to the wrong line of their document.
   */
  it('names an array `array`, not `object`', () => {
    const text = planWith({ completionsUrl: [] }).warnings.join('\n');
    expect(text).toContain('`completionsUrl` is an array');
    expect(text).not.toContain('`completionsUrl` is an object');
  });

  /* `null` is the documented off switch and must stay silent. */
  it('leaves `completionsUrl: null` alone', () => {
    const plan = buildPlan(
      parseDocument(
        doc({
          privacyPartners: [{ provider: 'cookiemunch', cbid: 'cb_live_1', completionsUrl: null }],
        }),
      ),
      live({ privacyPartners: [bound()] }),
    );
    expect(plan.refused).toEqual([]);
    expect(plan.warnings.join('\n')).not.toContain('completionsUrl` is');
  });

  /* Absent is not a type error either — `requiredFields` owns that message. */
  it('does not invent a type warning for an absent field', () => {
    const plan = planWith({});
    expect(plan.warnings.join('\n')).not.toContain('requires a string');
  });
});

/*
 * ForgeDeck's SEVENTH report item 2: the refusal COUNT was fixed in the sixth
 * report and the sentence beside it still said the server refuses a row that
 * is never sent.
 */
describe('a stray secret is described by what this run will do', () => {
  const strayOnLivePair = (writeOnly: boolean) =>
    buildPlan(
      parseDocument(
        doc({
          privacyPartners: [
            {
              provider: 'cookiemunch',
              cbid: 'cb_live_1',
              completionSecret: 'whsec_abcdefghijklmnop',
            },
          ],
        }),
      ),
      live({ privacyPartners: [bound({ completionsUrl: null, completionSecretSet: false })] }),
      { writeOnly },
    );

  it('says the secret is not sent when the row is unchanged', () => {
    const plan = strayOnLivePair(false);
    const text = plan.warnings.join('\n');
    expect(text).toContain('this secret is not sent');
    expect(text).not.toContain('the server refuses it');
    expect(plan.refused).toEqual([]);
  });

  /*
   * `--write-only` SENDS credentials, so the row does change and the server
   * does refuse it. The original wording is right here, which is why this
   * asks the plan action rather than comparing the row to live.
   */
  it('keeps the refusal wording under --write-only, where the row is sent', () => {
    const plan = strayOnLivePair(true);
    expect(plan.warnings.join('\n')).toContain('the server refuses it');
    expect(plan.refused).toEqual(['cookiemunch']);
  });

  /* A first create sends the row, so it is a real refusal. */
  it('keeps the refusal wording on a first create', () => {
    const plan = buildPlan(
      parseDocument(
        doc({
          privacyPartners: [
            { provider: 'cookiemunch', cbid: 'x', completionSecret: 'whsec_abcdefghijklmnop' },
          ],
        }),
      ),
      live({ privacyPartners: [unbound()] }),
    );
    expect(plan.warnings.join('\n')).toContain('the server refuses it');
    expect(plan.refused).toEqual(['cookiemunch']);
  });
});
