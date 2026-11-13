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
import type { ChannelView, DoctorCheck, DoctorDeps, Verdict } from './doctor-checks.js';

/** A JSON object, or an empty one. Local, so this file still imports nothing. */
const rec = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** A non-blank string, or null. */
const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

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

/**
 * The route is missing (older deployment) or the key lacks `workspace:read`.
 *
 * `skip`, not `warn` (CH-05): no readiness check ran, and a report that
 * cannot say whether something is true must not be summarised beside the ones
 * that passed.
 */
export const unavailable = (why: string): DoctorCheck => ({
  name: 'readiness',
  verdict: 'skip',
  detail: `Could not read GET /v1/workspace/readiness: ${why}.`,
  fix: 'Check the key holds workspace:read and the API is current.',
});

/**
 * Every check `GET /v1/integration-health` computes, as doctor rows (CH-05).
 *
 * ── Why these are not re-derived here ─────────────────────────────────────
 *
 * They already exist, server-side, with a `detail` and a `fix` apiece:
 * `kb.sync`, `kb.semantic_index`, `kb.orphans`, `business_hours.set`,
 * `channel.origins`, `identity.mode`, `webhooks.healthy`,
 * `attachments.hosts_current`, `identity.jwks_reachable` and
 * `atlas.receiver`. The list is prose and the mapping below is not — a check
 * the server adds flows through without an edit here. `doctor` read exactly ONE of them — the JWKS
 * verdict, and only when a channel had identity verification on — so FormFlow
 * ran it as a deploy gate, got `12 check(s): 12 ok, 0 warning(s), 0 failed`,
 * and shipped with two of three knowledge sources dead and the bot answering
 * by keyword alone. The facts were one GET away and nothing asked.
 *
 * Re-deriving any of them locally is the drift this CLI refuses elsewhere
 * (see `DoctorDeps.health`): the resolution lives in a private package this
 * published one cannot import.
 *
 * ── The three-way mapping, and the one exception ──────────────────────────
 *
 *   ok: true   → pass
 *   ok: false  → fail, so the gate stops the deploy
 *   ok: null   → SKIP, never pass. `null` means NOT DETERMINED — nothing to
 *                check, or a scope this credential lacks — and `detail` says
 *                which. Grading it `pass` is the exact failure this command
 *                was reported for; grading it `fail` would turn "we did not
 *                look" into "it is broken".
 *
 * The exception is `business_hours.set`, which is a warning even when false:
 * a workspace that deliberately runs without published hours is a supported
 * configuration, and failing a deploy on it would make this gate something
 * people switch off. That is the one judgement this file adds to the
 * server's; everything else is reported as the server graded it.
 *
 * An `ok` the server did not send at all lands in the `skip` arm too, for the
 * same reason: an unreadable verdict is not a pass.
 *
 * `read` is the function rather than the whole `DoctorDeps`, which keeps this
 * file's only import type-only — the property `doctor-checks.ts`'s header
 * depends on for its own isolation.
 */
const HEALTH_WARN_ONLY: ReadonlySet<string> = new Set(['business_hours.set']);

export async function healthChecks(
  read: () => Promise<readonly unknown[]>,
): Promise<DoctorCheck[]> {
  let checks: readonly unknown[];
  try {
    checks = await read();
  } catch (err) {
    return [
      {
        name: 'integration-health',
        verdict: 'skip',
        detail:
          'Could not read GET /v1/integration-health, so none of its checks ran — the ' +
          'knowledge base, the semantic index, business hours, webhook health and the ' +
          'identity key set are all UNCHECKED on this run: ' +
          `${err instanceof Error ? err.message : String(err)}`,
        fix:
          'That route needs the `workspace:read` scope. `chatly whoami` lists what the key ' +
          'has, and `chatly whoami --for doctor` says what it is missing.',
      },
    ];
  }
  if (checks.length === 0) {
    return [
      {
        name: 'integration-health',
        verdict: 'skip',
        detail:
          'GET /v1/integration-health answered with no checks at all, so nothing it covers ' +
          'was verified on this run.',
        fix: 'Upgrade the Chatly deployment — this route predates it.',
      },
    ];
  }
  return checks.map(rec).map((c): DoctorCheck => {
    const id = text(c['id']) ?? 'integration-health.unknown';
    const ok = c['ok'];
    return {
      name: id,
      verdict:
        ok === true ? 'pass' : ok === false ? (HEALTH_WARN_ONLY.has(id) ? 'warn' : 'fail') : 'skip',
      detail:
        text(c['detail']) ??
        (ok === true ? 'No detail.' : 'The server reported no verdict and no reason.'),
      fix: text(c['fix']),
    };
  });
}

/**
 * `audience_derived` is advice, not a failure (CH-09).
 *
 * It is `ok: false` on every channel whose issuer and audience are written by
 * hand, which is a supported configuration — `atlasInstance` is the way that
 * cannot drift, not the only way that works. Failing a deploy on it would
 * make this check unusable for every non-Atlas identity provider, and a check
 * people have to pass `--ignore` to is a check they turn off entirely.
 *
 * `audience_matches_channel` is the opposite case and is the whole reason
 * this route exists: a re-created channel whose old `aud` was copied by hand
 * refuses every token and leaves the visitor anonymous, with nothing
 * server-side to see.
 */
const CONTRACT_WARN_ONLY = new Set(['audience_derived']);

/**
 * The identity contract's own verdicts, for a channel that verifies visitors.
 *
 * Gated on `identityVerification.enabled`, unlike the workspace-wide checks
 * in `healthChecks`: a channel with identity verification OFF resolves no
 * issuer and no audience, which is correct for it and would report as two
 * failures here. That gate is why the old `identity.jwks_reachable`-only
 * check was gated too; what was wrong with that one was that it gated the
 * WORKSPACE checks as well.
 */
export async function identityContractChecks(
  ch: ChannelView,
  deps: DoctorDeps,
): Promise<DoctorCheck[]> {
  const channelId = ch.id;
  if (rec(ch.config['identityVerification'])['enabled'] !== true || channelId === null) {
    return [];
  }
  const name = `identity.contract (${ch.label})`;
  let entries: readonly unknown[];
  try {
    entries = await deps.identityContract(channelId);
  } catch (err) {
    return [
      {
        name,
        // SKIP: nothing was read, so this says nothing about the channel.
        verdict: 'skip',
        detail: `Could not read this channel's identity contract: ${err instanceof Error ? err.message : String(err)}`,
        fix:
          'It needs the `channels:read` scope (`chatly whoami`), and the route is ' +
          '`GET /v1/channels/{id}/identity-contract` — a deployment older than it answers 404.',
      },
    ];
  }
  if (entries.length === 0) {
    return [
      {
        name,
        verdict: 'skip',
        detail: 'The identity contract carried no checks, so there is nothing to report.',
        fix: null,
      },
    ];
  }
  return entries.map((entry): DoctorCheck => {
    const e = rec(entry);
    const id = text(e['id']) ?? 'unknown';
    const ok = e['ok'] === true;
    return {
      name: `identity.${id} (${ch.label})`,
      verdict: ok ? 'pass' : CONTRACT_WARN_ONLY.has(id) ? 'warn' : 'fail',
      // The server's own sentence: a second wording here is a second source
      // of truth about a verdict this CLI did not compute.
      detail: text(e['detail']) ?? (ok ? 'ok' : 'failed'),
      fix: ok
        ? null
        : `Read the whole contract with \`chatly api GET /v1/channels/${channelId}/identity-contract\` — it carries the exact \`aud\`, issuer and claim names your token template must stamp.`,
    };
  });
}
