import { describe, expect, it } from 'vitest';

import { readinessChecks } from './doctor-readiness.js';

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
