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
import { exitCodeFor, runChecks, selectChannels, type DoctorCheck } from './doctor-checks.js';

import type { ChatlyClient } from '@chatlychat/sdk-node';

/**
 * Not a `Record` read by index: `noUncheckedIndexedAccess` makes that
 * `string | undefined`, which is not a thing a template literal may carry.
 */
const symbolFor = (verdict: DoctorCheck['verdict']): string =>
  verdict === 'pass' ? 'ok  ' : verdict === 'warn' ? 'warn' : 'FAIL';

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

  const checks = await runChecks(channels, { origin }, {
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
      const res = await chatly.request<{ checks?: unknown }>('GET', '/v1/integration-health');
      return Array.isArray(res.checks) ? (res.checks as readonly unknown[]) : [];
    },
  });

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
  const failed = checks.filter((c) => c.verdict === 'fail').length;
  const warned = checks.filter((c) => c.verdict === 'warn').length;
  process.stdout.write(
    `\n${String(checks.length)} check(s): ${String(checks.length - failed - warned)} ok, ` +
      `${String(warned)} warning(s), ${String(failed)} failed\n`,
  );
  return exitCodeFor(checks);
}
