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

  it('turns a malformed body into one warning, not a crash', () => {
    const out = readinessChecks({});
    expect(out).toHaveLength(1);
    expect(out[0]?.verdict).toBe('warn');
  });
});
