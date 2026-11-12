/**
 * The ONE thing `chatly doctor` adds about the Atlas event receiver that the
 * server does not grade for itself (CH-26): how OLD the last verified event
 * is, and whether the numbers were published at all.
 *
 * ═══ WHY THIS FILE IS SMALL ═══════════════════════════════════════════════
 *
 * FormFlow read `12 ok, 0 failed` off a workspace whose Atlas deliveries to
 * `POST /v1/atlas/events` had answered 401 one hundred and twenty-six times
 * running. The fix for that is server-side and is CH-25's: `GET
 * /v1/integration-health` now carries a graded `atlas.receiver` check that is
 * `ok: false` when the last delivery was REFUSED, and `healthChecks` already
 * turns any `ok: false` into a doctor `fail` and a non-zero exit. So the
 * customer's "doctor must fail when the receiver's last event was rejected"
 * is answered by reading the server's verdict, not by re-deriving it — the
 * same contract as every other row in `doctor-readiness.ts`, and the reason
 * an earlier draft of this file (which graded the secret, the rejection and
 * the recovery itself) was deleted rather than shipped: every one of those
 * arms was unreachable beside the server's own row.
 *
 * What the server deliberately does NOT grade is AGE. `atlasReceiverCheck`
 * answers `ok: true` on "the last Atlas event was accepted" however long ago
 * that was, which is right for it — a quiet workspace receives nothing for
 * weeks and that is not a defect. The integrator asked for the window
 * anyway, and a warning is the honest shape for it: something to look at
 * before a cutover, never something that stops a deploy.
 *
 * ═══ WHAT IT PRINTS, AND WHEN IT PRINTS NOTHING ═══════════════════════════
 *
 *   object absent    → SKIP. A deployment older than CH-25 publishes no
 *                      `atlasReceiver`, and "we did not look" must not be
 *                      counted beside the checks that passed (CH-05).
 *   stale            → warn, with the age.
 *   anything else    → NO ROW. Not a pass row: the server's `atlas.receiver`
 *                      already carries the last-accepted instant in its own
 *                      detail, and a second line saying the same fact is the
 *                      noise that teaches people to skim a report. Same
 *                      judgement as `csp.site` printing nothing without
 *                      `--origin`.
 *
 * A receiver whose last delivery was REFUSED gets no row here either: the
 * server graded that `fail`, doctor prints it, and an age warning stacked
 * under a failure would be two lines about one broken thing.
 */
import type { DoctorCheck } from './doctor-checks.js';

/**
 * The fields of `GET /v1/integration-health`'s `atlasReceiver` that this
 * check reads — not the whole published object, which
 * `IntegrationHealthAtlasReceiver` (server-side) defines and which carries
 * `lastReceivedAt`, `lastRejectedReason` and `rejectedCount24h` besides.
 * Nothing here grades those, so nothing here reads them.
 *
 * Every field nullable and optional: this is a wire shape from a server that
 * may be older or newer than this CLI, and a `null` means "this credential
 * could not look" with the `atlas.receiver` row saying why.
 */
export interface AtlasReceiverFacts {
  /** A channel holds an Atlas `eventsSecret`. */
  readonly configured?: boolean | null;
  /** A channel expects Atlas identity events at all. */
  readonly connected?: boolean | null;
  readonly lastVerifiedAt?: string | null;
  readonly lastRejectedAt?: string | null;
}

/**
 * How long a connected receiver may go without a verified event before this
 * says so. A warning, never a failure — see the header.
 *
 * Seven days rather than a flag: a number nobody can tune is a number nobody
 * has to explain, and the only consequence of getting it wrong is one
 * advisory line. `docs/outstanding-work.md` records that a flag was declined.
 */
export const ATLAS_RECEIVER_MAX_AGE_DAYS = 7;

const rec = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

/** An ISO instant as epoch ms, or null. An unparseable date is not a date. */
const at = (value: unknown): number | null => {
  const raw = text(value);
  if (raw === null) {
    return null;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * The receiver numbers off the whole `GET /v1/integration-health` body.
 *
 * `null` when the deployment publishes no such key, which is a different
 * answer from "a receiver with nothing in it" and is graded differently.
 */
export function atlasReceiverFacts(body: unknown): AtlasReceiverFacts | null {
  const found = rec(body)['atlasReceiver'];
  if (typeof found !== 'object' || found === null || Array.isArray(found)) {
    return null;
  }
  const bag = found as Record<string, unknown>;
  return {
    configured: bag['configured'] === true,
    connected: bag['connected'] === true,
    lastVerifiedAt: text(bag['lastVerifiedAt']),
    lastRejectedAt: text(bag['lastRejectedAt']),
  };
}

const FIX_VERIFY =
  'Nothing here can tell a quiet workspace from a broken secret, so confirm the match directly: ' +
  '`chatly channels verify-events-secret <channel> --secret $ATLAS_CHATLY_EVENTS_SECRET` signs a ' +
  'test event and asks the receiver whether it verifies against the stored one. It applies ' +
  'nothing. On `mismatch`, re-paste Atlas’s secret and `chatly apply --rotate-secret`.';

/** The age of the last verified Atlas event, as doctor rows. Never throws. */
export function atlasReceiverChecks(body: unknown, now: Date): DoctorCheck[] {
  const facts = atlasReceiverFacts(body);
  if (facts === null) {
    return [
      {
        name: 'atlas.receiver.age',
        // SKIP, not pass: nothing was read. The defect this whole feature
        // exists for was a pass that meant exactly this.
        verdict: 'skip',
        detail:
          'GET /v1/integration-health published no `atlasReceiver`, so how long ago Atlas’s ' +
          'last accepted event arrived is UNCHECKED on this run.',
        fix: 'Upgrade the Chatly deployment — these numbers predate it.',
      },
    ];
  }
  const verified = at(facts.lastVerifiedAt);
  const rejected = at(facts.lastRejectedAt);
  if (facts.connected !== true || facts.configured !== true || verified === null) {
    // No receiver to be stale, or nothing has ever verified — which the
    // server's own `atlas.receiver` row grades and explains.
    return [];
  }
  if (rejected !== null && rejected > verified) {
    // Already a `fail` from the server. One broken thing, one line.
    return [];
  }
  const days = (now.getTime() - verified) / 86_400_000;
  if (days <= ATLAS_RECEIVER_MAX_AGE_DAYS) {
    return [];
  }
  return [
    {
      name: 'atlas.receiver.age',
      // Warn, never fail: a workspace where nobody signed out this week is
      // working correctly, and a gate that fails on it gets switched off.
      verdict: 'warn',
      detail:
        `The last Atlas event this receiver accepted was ${facts.lastVerifiedAt ?? '?'} ` +
        `(${days.toFixed(1)} day(s) ago), outside the ` +
        `${String(ATLAS_RECEIVER_MAX_AGE_DAYS)}-day window. Expected on a quiet workspace — ` +
        'Atlas only sends on a session or user event — so this is not a failure.',
      fix: FIX_VERIFY,
    },
  ];
}
