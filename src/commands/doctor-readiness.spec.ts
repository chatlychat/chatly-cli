import { describe, expect, it } from 'vitest';

import { identityContractChecks, readinessChecks } from './doctor-readiness.js';

import type { ChannelView, DoctorDeps, DoctorOptions } from './doctor-checks.js';

describe('readinessChecks', () => {
  it.each([
    ['ok', 'pass'],
    ['warn', 'warn'],
    ['fail', 'fail'],
    ['surprise', 'warn'],
  ])('maps status %s to %s', (status, verdict) => {
    const [c] = readinessChecks({ checks: [{ id: 'x', status, detail: 'd', fix: null }] });
    expect(c).toEqual({ name: 'readiness.x', verdict, detail: 'd', fix: null });
  });

  /*
   * SKIP, not warn (CH-05). Nothing was checked, and a verdict that cannot
   * say whether something is true must not be summarised beside the ones
   * that passed — which is what `doctor`'s "N ok" line used to do.
   */
  it('turns a malformed body into one SKIPPED row, not a crash and not a warning', () => {
    const out = readinessChecks({});
    expect(out).toHaveLength(1);
    expect(out[0]?.verdict).toBe('skip');
  });
});

/**
 * The CLI half of EmojiDex CH-1 / CH-9 (2026-11-16).
 *
 * The server stopped grading the three token checks on a channel that
 * verifies a `userHash` and answers `ok: null` — NOT DETERMINED — instead.
 * **Shipping only the server half fixes nothing an integrator can see**:
 * 0.15.0 graded anything that was not `true` as a failure, so the new verdict
 * printed the same unclearable FAIL it was meant to replace, and they
 * re-probed a live install to tell us so.
 *
 * Which makes these four assertions the ones that keep the two halves
 * together. Control-tested by restoring `const ok = e['ok'] === true` and its
 * ternary: the first two fail, the last two still pass.
 */
describe('the identity contract’s verdicts, as `doctor` renders them', () => {
  const channel = (): ChannelView => ({
    label: 'Website',
    id: 'ch_web_01a1e55685117000aa61f795',
    embed: {},
    config: { identityVerification: { enabled: true, mode: 'hmac' } },
    originsRestricted: true,
  });

  const run = async (
    checks: ReadonlyArray<Record<string, unknown>>,
  ): Promise<ReadonlyArray<{ name: string; verdict: string; fix: string | null }>> =>
    identityContractChecks(
      channel(),
      { identityContract: async () => ({ checks }) } as unknown as DoctorDeps,
      {} as DoctorOptions,
    );

  it('renders `ok: null` as SKIP, not as a failure', async () => {
    const out = await run([
      { id: 'issuer_resolved', ok: null, detail: 'does not apply to that setup' },
    ]);
    expect(out[0]?.verdict).toBe('skip');
    // And no `fix`: there is nothing to do, so advice here is noise that
    // reads like an instruction.
    expect(out[0]?.fix).toBeNull();
  });

  it('renders a MISSING `ok` as SKIP too, so an older server does not read as broken', async () => {
    const out = await run([{ id: 'issuer_resolved', detail: 'no verdict' }]);
    expect(out[0]?.verdict).toBe('skip');
  });

  it('still fails a real `ok: false`, which is what the SKIP arm must not swallow', async () => {
    const out = await run([{ id: 'issuer_resolved', ok: false, detail: 'no issuer' }]);
    expect(out[0]?.verdict).toBe('fail');
    expect(out[0]?.fix).toMatch(/identity-contract/);
  });

  it('keeps the two advice rows warn-only, so neither can stop a deploy', async () => {
    const out = await run([
      { id: 'audience_derived', ok: false, detail: 'advice' },
      { id: 'token_fields_ignored', ok: false, detail: 'a leftover tokenProvider' },
    ]);
    expect(out.map((c) => c.verdict)).toEqual(['warn', 'warn']);
  });
});
