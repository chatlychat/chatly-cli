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
  it('still warns about the stray secret', () => {
    expect(straySecret().warnings.some((w) => w.includes('nowhere to report'))).toBe(true);
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
