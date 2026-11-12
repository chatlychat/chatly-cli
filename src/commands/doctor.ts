/**
 * `chatly doctor` — does a DEPLOYED widget install actually work?
 *
 * The judgement is all in `doctor-checks.ts`, which has no runtime imports so
 * it can be exercised on its own; this file is the three API reads it needs,
 * the two flags and the printing. Read that file's header for what each check
 * catches and why these are the checks.
 *
 * Read-only against the workspace. The one non-GET is `POST
 * /v1/uploads/presign`, which signs a URL and writes no object and no row —
 * see `DoctorDeps.presign` for why a guessed probe path would not do.
 */
import { bool, str, type ParsedArgs } from '../args.js';
import { itemsOf, printJson } from '../output.js';
import { atlasReceiverChecks } from './doctor-atlas-receiver.js';
import { exitCodeFor, runChecks, selectChannels, type DoctorCheck } from './doctor-checks.js';
import { readinessChecks, unavailable } from './doctor-readiness.js';

import type { ChatlyClient } from '@chatlychat/sdk-node';

/**
 * Not a `Record` read by index: `noUncheckedIndexedAccess` makes that
 * `string | undefined`, which is not a thing a template literal may carry.
 */
const symbolFor = (verdict: DoctorCheck['verdict']): string =>
  verdict === 'pass' ? 'ok  ' : verdict === 'warn' ? 'warn' : verdict === 'skip' ? 'SKIP' : 'FAIL';

/**
 * The headline, and the one number FormFlow read before shipping.
 *
 * Exported so a spec can drive it: `doctor` itself probes the network
 * through the global `fetch`, and the arithmetic here is the whole of the
 * reported defect — the old line computed "ok" as `length - failed - warned`,
 * so every check that could not be MADE was counted among the ones that
 * passed. `12 check(s): 12 ok, 0 warning(s), 0 failed` over two dead
 * knowledge sources. SKIP is its own number now, and that is the point of
 * the word. See `Verdict` in `doctor-checks.ts`.
 */
export function summaryLine(checks: readonly DoctorCheck[]): string {
  const count = (v: DoctorCheck['verdict']): number =>
    checks.filter((c) => c.verdict === v).length;
  const [failed, warned, skipped] = [count('fail'), count('warn'), count('skip')];
  return (
    `${String(checks.length)} check(s): ${String(checks.length - failed - warned - skipped)} ok, ` +
    `${String(warned)} warning(s), ${String(skipped)} skipped, ${String(failed)} failed`
  );
}

export async function doctor(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const only = str(args.flags, 'channel');
  const origin = str(args.flags, 'origin');

  /*
   * No `?limit=`, so this answers a bare array — but `itemsOf` accepts the
   * `{ items, nextCursor, hasMore }` envelope too, because that is what the
   * route returns the moment a limit or cursor is sent and a reader that
   * handles only one shape is the drift this repo keeps finding.
   */
  const rows = itemsOf(await chatly.channels.list());
  const channels = selectChannels(rows, only);
  if (only !== undefined && channels.length === 0) {
    process.stderr.write(
      `No web channel matches "${only}". \`chatly channels list\` shows the ids and publicIds.\n`,
    );
    return 2;
  }

  /*
   * ONE read of `GET /v1/integration-health`, shared by the verdicts it
   * already grades and the Atlas receiver rows derived from the same body
   * (CH-26). Memoised rather than requested twice; a rejected promise is
   * awaited by both callers and each reports its own absence.
   */
  let healthBody: Promise<Record<string, unknown>> | undefined;
  const readHealth = (): Promise<Record<string, unknown>> => {
    healthBody ??= chatly.request<Record<string, unknown>>('GET', '/v1/integration-health');
    return healthBody;
  };

  const checks = await runChecks(
    channels,
    { origin },
    {
      fetchFn: fetch,
      presign: async () => {
        const res = await chatly.request<{ url?: unknown }>('POST', '/v1/uploads/presign', {
          body: {
            filename: 'chatly-doctor-probe.png',
            contentType: 'image/png',
            sizeBytes: 1,
          },
        });
        const { url } = res;
        if (typeof url !== 'string') {
          throw new Error('the presign response carried no `url`');
        }
        return url;
      },
      health: async () => {
        const res = await readHealth();
        const graded = res['checks'];
        return Array.isArray(graded) ? (graded as readonly unknown[]) : [];
      },
      identityContract: async (channelId: string) => {
        const res = await chatly.request<{ checks?: unknown }>(
          'GET',
          `/v1/channels/${encodeURIComponent(channelId)}/identity-contract`,
        );
        return Array.isArray(res.checks) ? (res.checks as readonly unknown[]) : [];
      },
    },
  );

  // Advisory: an older deployment without the route must not break the rest of doctor.
  try {
    checks.push(...readinessChecks(await chatly.request('GET', '/v1/workspace/readiness')));
  } catch (err) {
    checks.push(unavailable(err instanceof Error ? err.message : 'request failed'));
  }

  /*
   * The Atlas event receiver (CH-26). Derived from the body already read
   * above, so this costs no second request. A read that FAILED is reported by
   * `healthChecks` as one SKIP row naming the request; a second row here
   * would be the same absence twice.
   */
  try {
    checks.push(...atlasReceiverChecks(await readHealth(), new Date()));
  } catch {
    /* reported by `healthChecks` — see above. */
  }

  if (bool(args.flags, 'json')) {
    printJson({ checks, ok: exitCodeFor(checks) === 0 });
    return exitCodeFor(checks);
  }

  /*
   * Not `printTable`: a `fix` is a sentence or two and the table truncates
   * every cell to 48 characters, which would clip the one part of the output
   * somebody is going to act on.
   */
  for (const check of checks) {
    process.stdout.write(`${symbolFor(check.verdict)}  ${check.name}\n      ${check.detail}\n`);
    if (check.fix !== null && check.verdict !== 'pass') {
      process.stdout.write(`      → ${check.fix}\n`);
    }
  }
  process.stdout.write(`\n${summaryLine(checks)}\n`);
  return exitCodeFor(checks);
}
