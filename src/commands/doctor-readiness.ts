/**
 * `GET /v1/workspace/readiness` as `chatly doctor` rows.
 *
 * Unlike the checks in `doctor-checks.ts`, which are things a server cannot
 * answer about itself (CORS, CSP), these are things the server answers
 * perfectly well. They are printed here anyway because `doctor` is the one
 * command people run before a cutover, and an integrator who found a missing
 * privacy-partner connection from the partner's own health check should have
 * found it from this. Kept out of `doctor-checks.ts`, which is near the file
 * size cap; type-only imports, like it.
 */
import type { DoctorCheck, Verdict } from './doctor-checks.js';

const VERDICTS: Readonly<Record<string, Verdict>> = { ok: 'pass', warn: 'warn', fail: 'fail' };

/**
 * Tolerant of an older or newer server: a row it cannot read becomes a
 * warning rather than a crash, because the report is advisory.
 */
export function readinessChecks(raw: unknown): DoctorCheck[] {
  const rows = (raw as { checks?: unknown } | null)?.checks;
  if (!Array.isArray(rows)) {
    return [unavailable('the response carried no `checks` array')];
  }
  return rows.map((row: unknown): DoctorCheck => {
    const r = (row ?? {}) as Record<string, unknown>;
    const verdict = typeof r['status'] === 'string' ? VERDICTS[r['status']] : undefined;
    return {
      name: `readiness.${typeof r['id'] === 'string' ? r['id'] : 'unknown'}`,
      // An unknown status must not read as a pass.
      verdict: verdict ?? 'warn',
      detail: typeof r['detail'] === 'string' ? r['detail'] : 'unreadable readiness row',
      fix: typeof r['fix'] === 'string' ? r['fix'] : null,
    };
  });
}

/** The route is missing (older deployment) or the key lacks `workspace:read`. */
export const unavailable = (why: string): DoctorCheck => ({
  name: 'readiness',
  verdict: 'warn',
  detail: `Could not read GET /v1/workspace/readiness: ${why}.`,
  fix: 'Check the key holds workspace:read and the API is current.',
});
