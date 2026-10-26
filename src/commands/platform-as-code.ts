/**
 * `chatly platform plan` / `chatly platform apply` — the Platform API as a
 * file (CHT-F04).
 *
 * The same engine as `chatly plan` / `chatly apply` over a different surface:
 * `/v1/platform/*`, authenticated with a `cp_` platform credential, describing
 * SEVERAL tenants at once. Everything that is not specific to that surface is
 * shared and lives in `wac/` — the loader, the parser, the differ, the
 * renderer and the executor. What is here is the wiring, and the three things
 * that are different:
 *
 *  - **The table.** `pac/platform-resources.ts`: six resource types, every
 *    path read off a handler. Channel config, IDV mode, business hours and
 *    routing are the `settings` row (one per workspace, merge-compared);
 *    login links are refused by name with the reason. Read that file's
 *    header before adding a row.
 *  - **The reader.** `pac/platform-live.ts`: it reads only the tenants the
 *    document names, because a platform document is a SUBSET of what a
 *    credential owns and an unmentioned tenant is not drift.
 *  - **The guard.** `platform.prefix` against `GET /v1/platform/whoami`, and
 *    it runs before any other read on `plan` as well as `apply`.
 *
 * ═══ READ-BACK VERIFICATION ═══════════════════════════════════════════════
 *
 * CHT-F04 asked for `--dry-run` and "read-back verification", in the shape
 * Forumulate's `publish` prints "everything matches". `plan` IS the dry run —
 * it issues GETs only — so there is no separate flag for it. `apply` does the
 * verification: after its writes it re-reads the live surface and re-plans,
 * and it exits non-zero unless every item the document describes is `noop`.
 * That is the check a pipeline can trust, because it is computed from what
 * the server SAYS after the write rather than from the status codes the
 * writes returned — a 201 from a route that stripped half the body is
 * exactly what it catches.
 */
import { bool, type ParsedArgs } from '../args.js';
import { printJson } from '../output.js';
import { PLATFORM_DEFAULT_FILES, PLATFORM_SCHEMA } from '../pac/platform-document.js';
import { readPlatformLive } from '../pac/platform-live.js';
import { platformResourceDef } from '../pac/platform-resources.js';
import { renderOutcomes, type ApplyOptions } from '../wac/apply.js';
import { buildPlan, tally, type Plan } from '../wac/diff.js';
import { execute } from '../wac/execute.js';
import { loadFrom } from '../wac/load.js';
import { planFooter, planForJson, renderPlan } from '../wac/render.js';

import type { WacDocument } from '../wac/document.js';
import type { ChatlyClient } from '@chatlychat/sdk-node';

const DOCS_URL = 'https://chatlychat.com/docs/sdk-cli#platform-as-code';

const USAGE =
  'Usage: chatly platform plan|apply [--file chatly.platform.json] [--prune] [--json]\n' +
  'Authenticate with a cp_ platform credential (--key or CHATLY_API_KEY), not a ck_ key.\n' +
  `A worked example: ${DOCS_URL}\n`;

export function loadPlatformDocument(
  args: ParsedArgs,
  env: NodeJS.ProcessEnv = process.env,
): WacDocument {
  return loadFrom(args, env, {
    defaultFiles: PLATFORM_DEFAULT_FILES,
    schema: PLATFORM_SCHEMA,
    docsUrl: DOCS_URL,
    command: 'platform plan',
  });
}

/**
 * `platform.prefix` in the document, against the credential's own prefix.
 *
 * A GET, so it does not spend `plan`'s no-writes property. It runs before
 * the live read for the reason `workspace-as-code.ts` records: a guard placed
 * second lets a staging document compute a whole plan against production
 * before refusing, and on `apply` the same ordering would write first.
 */
async function prefixGuard(chatly: ChatlyClient, doc: WacDocument): Promise<string | undefined> {
  if (doc.guard === undefined) {
    return undefined;
  }
  const me = await chatly.request<{ prefix?: unknown }>('GET', '/v1/platform/whoami');
  if (me.prefix === doc.guard) {
    return undefined;
  }
  return (
    `Refusing to run: the document says \`"platform": { "prefix": "${doc.guard}" }\` and this ` +
    `credential's prefix is ${typeof me.prefix === 'string' ? me.prefix : '(none reported)'}.\n` +
    'Point --key / CHATLY_API_KEY at the right platform credential, or remove the `platform` ' +
    'block if this document is meant to be portable.'
  );
}

/** Read the live surface and plan against it, with the reader's warnings. */
async function planAgainstLive(
  chatly: ChatlyClient,
  doc: WacDocument,
  writeOnly: boolean,
): Promise<Plan> {
  const { live, warnings } = await readPlatformLive(chatly, doc);
  /*
   * The adoption shape: children naming a tenant the document does not
   * declare. Its live row is resolvable but not planned — see
   * `PlanOptions.referenced`.
   */
  const workspacesDef = platformResourceDef('workspaces');
  const declaresWorkspaces = doc.sections.some((s) => s.def.type === 'workspaces');
  const referenced =
    declaresWorkspaces || workspacesDef === undefined
      ? []
      : [{ def: workspacesDef, section: live.get('workspaces') ?? { rows: [] } }];
  const built = buildPlan(doc, live, { writeOnly, referenced });
  return { ...built, warnings: [...warnings, ...built.warnings] };
}

export async function plan(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const doc = loadPlatformDocument(args);
  const guard = await prefixGuard(chatly, doc);
  if (guard !== undefined) {
    process.stderr.write(`${guard}\n`);
    return 1;
  }
  const built = await planAgainstLive(chatly, doc, bool(args.flags, 'write-only'));
  const opts = { prune: bool(args.flags, 'prune'), pruneUnsafe: built.pruneUnsafe };
  if (bool(args.flags, 'json')) {
    printJson(planForJson(built));
  } else {
    process.stdout.write(renderPlan(built, opts));
    process.stdout.write(planFooter(built, opts));
  }
  // `--exit-code` means what it means on `chatly plan`: 2 for drift, so CI
  // can tell "the platform no longer matches the repo" from "the call failed".
  if (bool(args.flags, 'exit-code')) {
    const counts = tally(built);
    return counts.create + counts.update + counts.blocked > 0 ? 2 : 0;
  }
  return built.items.some((i) => i.action === 'blocked') ? 1 : 0;
}

/**
 * What the re-read found that does not match the document.
 *
 * `orphan` is excluded: an orphan is a live row the document does not
 * mention, which `apply` without `--prune` deliberately keeps, and failing
 * verification for it would make the default `apply` fail every time. Under
 * `--prune` a surviving orphan IS a mismatch, because the run was asked to
 * remove it.
 */
export function unverified(after: Plan, prune: boolean): ReadonlyArray<string> {
  return after.items
    .filter((i) => i.action !== 'noop' && (i.action !== 'orphan' || prune))
    .map((i) => `${i.type}/${i.key}: ${i.action}${i.reason === undefined ? '' : ` — ${i.reason}`}`);
}

export async function apply(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const doc = loadPlatformDocument(args);
  const guard = await prefixGuard(chatly, doc);
  if (guard !== undefined) {
    process.stderr.write(`${guard}\n`);
    return 1;
  }
  const writeOnly = bool(args.flags, 'write-only');
  const json = bool(args.flags, 'json');
  const built = await planAgainstLive(chatly, doc, writeOnly);
  const opts: ApplyOptions = {
    prune: bool(args.flags, 'prune'),
    pruneUnsafe: built.pruneUnsafe,
    writeOnly,
  };

  if (!json) {
    process.stdout.write(renderPlan(built, opts));
    process.stdout.write('\nApplying…\n\n');
  }
  const outcomes = await execute(chatly, built, opts, platformResourceDef);

  /* Read-back verification: re-read, re-plan, and require every row to match. */
  const after = await planAgainstLive(chatly, doc, writeOnly);
  const mismatches = unverified(after, opts.prune);

  if (json) {
    printJson({
      outcomes,
      warnings: built.warnings,
      verified: mismatches.length === 0,
      mismatches,
    });
  } else {
    process.stdout.write(renderOutcomes(outcomes));
    process.stdout.write(
      mismatches.length === 0
        ? '\nRead back: everything matches the document.\n'
        : `\nRead back: ${String(mismatches.length)} item(s) still differ from the document:\n` +
            mismatches.map((m) => `  ${m}\n`).join(''),
    );
  }
  const failed = outcomes.some((o) => o.state === 'failed' || o.state === 'skipped');
  return failed || mismatches.length > 0 ? 1 : 0;
}

/** `chatly platform <plan|apply>`. */
export async function platform(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const sub = args.path[1];
  if (sub === 'plan') {
    return plan(chatly, args);
  }
  if (sub === 'apply') {
    return apply(chatly, args);
  }
  process.stderr.write(
    sub === undefined ? USAGE : `Unknown subcommand "platform ${sub}".\n${USAGE}`,
  );
  return 2;
}
