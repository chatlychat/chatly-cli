/**
 * `chatly plan` and `chatly apply` — the workspace as a file.
 *
 * ═══ THE ASK ══════════════════════════════════════════════════════════════
 *
 * From the integrator who prompted it: "We wrote ~600 lines to idempotently
 * upsert tools, bots, routes, cards and channel config. Offer a declarative
 * `chatly.yaml` with `chatly plan` / `chatly apply` (diff, then apply; never
 * deletes unless told). This is the single biggest DX win for teams that run
 * more than one environment."
 *
 * A CLI rather than a Terraform provider, deliberately. A provider is a
 * second artifact to version, publish, document and keep in step with 142
 * routes, and this CLI is already on npm as `@chatlychat/cli` with a release
 * pipeline. The provider is the better answer for somebody whose whole
 * platform is Terraform; it is not the better answer for the next six months.
 *
 * ═══ THE CONTRACT ═════════════════════════════════════════════════════════
 *
 *   plan    reads the live workspace, prints a diff, WRITES NOTHING. Not one
 *           POST, not one PATCH. `wac.spec.ts` drives the whole path through
 *           a recording transport and fails if a single non-GET is issued —
 *           and asserts the GETs it did make, so a plan that silently stopped
 *           reading cannot pass the same test.
 *   apply   makes the plan's changes. A resource on the server and absent
 *           from the document is REPORTED AND LEFT ALONE; `--prune` is the
 *           only thing that deletes, and there is no way to set it in the
 *           file. Default safe, as asked.
 *
 * ═══ YAML ═════════════════════════════════════════════════════════════════
 *
 * The document may be YAML or JSON; `wac/load.ts` owns the choice and the
 * strictness, and both commands share it.
 *
 * ═══ THE PLATFORM DOCUMENT ════════════════════════════════════════════════
 *
 * `chatly platform plan` / `apply` (CHT-F04) is the same engine over the
 * `/v1/platform/*` surface and a `cp_` credential — `commands/platform-as-code.ts`
 * and `pac/`. Everything in `wac/` is shared: this file is the workspace's
 * reader and command wiring, and nothing more.
 */
import { bool, type ParsedArgs } from '../args.js';
import { printJson } from '../output.js';
import { unverified } from './platform-as-code.js';
import { renderOutcomes, type ApplyOptions } from '../wac/apply.js';
import { buildPlan, tally, type LiveSection } from '../wac/diff.js';
import { WORKSPACE_SCHEMA, type WacDocument } from '../wac/document.js';
import { execute } from '../wac/execute.js';
import { loadFrom } from '../wac/load.js';
import { planFooter, planForJson, renderPlan } from '../wac/render.js';
import { resourceDef } from '../wac/resources.js';

import type { ChatlyClient, Page } from '@chatlychat/sdk-node';

/** Looked for in order when `--file` is absent. */
const DEFAULT_FILES = ['chatly.json', 'chatly.yaml', 'chatly.yml'];

/**
 * The row cap on `/v1/macros`, used to decide whether `--prune` is safe.
 *
 * `@PaginationExempt` routes answer a bare array with no cursor, so a list
 * that comes back at exactly the cap may be truncated — and a row past the
 * cap is INVISIBLE, not absent, which would make it an orphan and then a
 * deletion. `diff.ts` refuses prune for a type in that state. The number is
 * the handler's, and if it ever rises this becomes conservative rather than
 * wrong, which is the right direction for a flag that deletes.
 */
const EXEMPT_LIST_CAP = 200;

/* ── Loading ──────────────────────────────────────────────────────────── */

/**
 * The document, read and validated. The loader itself is `wac/load.ts`.
 *
 * Re-exported from here because this is where it has always lived and
 * `chatly platform plan` needs the same loader with a different default
 * filename — see that file's header for why it is not imported across command
 * modules.
 */
export function loadDocument(args: ParsedArgs, env: NodeJS.ProcessEnv = process.env): WacDocument {
  return loadFrom(args, env, {
    defaultFiles: DEFAULT_FILES,
    schema: WORKSPACE_SCHEMA,
    docsUrl: 'https://chatlychat.com/docs/sdk-cli#workspace-as-code',
    command: 'plan',
  });
}

/* ── Reading the live workspace ───────────────────────────────────────── */

/**
 * The live rows for every type the document mentions, and nothing else.
 *
 * All through `chatly.request` — the escape hatch CONTRACT.md defines — so
 * auth, retries and the typed errors are the same ones every other command
 * gets, and `apps/cli` still adds no HTTP of its own. Every call here is a
 * GET; that is the property `wac.spec.ts` pins.
 */
export async function readLive(
  chatly: ChatlyClient,
  doc: WacDocument,
): Promise<Map<string, LiveSection>> {
  const out = new Map<string, LiveSection>();
  for (const section of doc.sections) {
    const { def } = section;
    if (def.list.paged) {
      const rows: Array<Record<string, unknown>> = [];
      let cursor: string | undefined;
      /*
       * Walked by hand rather than through `autoPaginate` because the loop
       * needs the raw envelope: `@PaginationExempt` neighbours answer a bare
       * array and this one answers `{ items, nextCursor }`, and conflating
       * the two is the bug that shipped in two SDKs.
       */
      for (let guard = 0; guard < 200; guard += 1) {
        const page = await chatly.request<Page<Record<string, unknown>>>('GET', def.list.path, {
          query: cursor === undefined ? {} : { cursor },
        });
        rows.push(...(page.items ?? []));
        const next = page.nextCursor;
        if (typeof next !== 'string' || next.length === 0 || next === cursor) {
          break;
        }
        cursor = next;
      }
      out.set(def.type, { rows });
      continue;
    }
    const answer = await chatly.request<unknown>('GET', def.list.path);
    const rows = Array.isArray(answer) ? (answer as Array<Record<string, unknown>>) : [];
    out.set(def.type, { rows, possiblyTruncated: rows.length >= EXEMPT_LIST_CAP });
  }
  return out;
}

/* ── plan ─────────────────────────────────────────────────────────────── */

export async function plan(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const doc = loadDocument(args);
  /*
   * The guard first, before a single read.
   *
   * It was second for one revision, which meant a staging document aimed at
   * production issued nine GETs and computed a whole diff before refusing.
   * Harmless here because they are reads — and exactly the ordering mistake
   * that is not harmless in `apply`, where the same code shape would have
   * written before checking.
   */
  const guard = await workspaceGuard(chatly, doc);
  if (guard !== undefined) {
    process.stderr.write(`${guard}\n`);
    return 1;
  }

  const live = await readLive(chatly, doc);
  const built = buildPlan(doc, live, { writeOnly: bool(args.flags, 'write-only') });
  const opts = { prune: bool(args.flags, 'prune'), pruneUnsafe: built.pruneUnsafe };

  if (bool(args.flags, 'json')) {
    printJson(planForJson(built));
  } else {
    process.stdout.write(renderPlan(built, opts));
    process.stdout.write(planFooter(built, opts));
  }

  /*
   * `--exit-code`, off by default.
   *
   * CI wants "is production still what the repo says" as an exit status, and
   * a plan that exits 1 by default would make `chatly plan` unusable in a
   * shell with `set -e` for the ordinary case of looking. So the behaviour is
   * opt-in and the code is 2 — distinct from 1, which on this CLI means the
   * request failed, and conflating "there is drift" with "the call errored"
   * is how a drift alarm becomes a flake alarm.
   */
  if (bool(args.flags, 'exit-code')) {
    const counts = tally(built);
    return counts.create + counts.update + counts.blocked > 0 ? 2 : 0;
  }
  return built.items.some((i) => i.action === 'blocked') ? 1 : 0;
}

/**
 * `workspace:` in the document, against the key's actual workspace.
 *
 * The guard that stops a staging document reaching production. It is checked
 * on `plan` as well as `apply` — a plan is what somebody reads before they
 * approve, so a plan computed against the wrong workspace is a worse failure
 * than an apply that is refused.
 *
 * `whoami` is a GET, so this does not spend the no-writes property.
 */
async function workspaceGuard(chatly: ChatlyClient, doc: WacDocument): Promise<string | undefined> {
  if (doc.guard === undefined) {
    return undefined;
  }
  const me = await chatly.whoami();
  if (me.workspaceId === doc.guard) {
    return undefined;
  }
  return (
    `Refusing to run: the document says \`"workspace": "${doc.guard}"\` and this key ` +
    `belongs to ${me.workspaceId}.\n` +
    'Either point --key / CHATLY_API_KEY at the right workspace, or remove the `workspace` ' +
    'line if this document is meant to be portable.'
  );
}

/** `publicId` is an OUTPUT: read back for each channel the document names, by its `key`. */
function channelPublicIds(
  doc: WacDocument,
  live: ReadonlyMap<string, LiveSection>,
): Record<string, string> {
  const wanted = new Set(
    doc.sections.filter((s) => s.def.type === 'channels').flatMap((s) => s.rows.map((r) => r.key)),
  );
  const out: Record<string, string> = {};
  for (const row of live.get('channels')?.rows ?? []) {
    const key = row['key'];
    if (typeof key === 'string' && wanted.has(key) && typeof row['publicId'] === 'string') {
      out[key] = row['publicId'];
    }
  }
  return out;
}

/* ── apply ────────────────────────────────────────────────────────────── */

export async function apply(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const doc = loadDocument(args);
  const guard = await workspaceGuard(chatly, doc);
  if (guard !== undefined) {
    process.stderr.write(`${guard}\n`);
    return 1;
  }

  const live = await readLive(chatly, doc);
  const writeOnly = bool(args.flags, 'write-only');
  const built = buildPlan(doc, live, { writeOnly });
  const opts: ApplyOptions = {
    prune: bool(args.flags, 'prune'),
    pruneUnsafe: built.pruneUnsafe,
    writeOnly,
  };

  if (!bool(args.flags, 'json')) {
    // The plan, then the result. An apply that printed only its result would
    // make the reader diff two commands' output to find out what it did.
    process.stdout.write(renderPlan(built, opts));
    process.stdout.write('\nApplying…\n\n');
  }

  const outcomes = await execute(chatly, built, opts, resourceDef);
  /*
   * Read-back verification, as `chatly platform apply` does: re-read, re-plan
   * and require every row to be a noop. Planned WITHOUT `--write-only`, which
   * would report every opaque field as a change forever.
   */
  const liveAfter = await readLive(chatly, doc);
  const after = buildPlan(doc, liveAfter, { writeOnly: false });
  const mismatches = unverified(after, opts.prune);
  const publicIds = channelPublicIds(doc, liveAfter);
  if (bool(args.flags, 'json')) {
    printJson({
      outcomes,
      warnings: built.warnings,
      verified: mismatches.length === 0,
      mismatches,
      publicIds,
    });
  } else {
    process.stdout.write(renderOutcomes(outcomes));
    for (const [key, publicId] of Object.entries(publicIds)) {
      process.stdout.write(`channels/${key}: publicId ${publicId}\n`);
    }
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

/** Re-exported: it moved to `wac/execute.ts` so `chatly platform apply` shares it. */
export { execute } from '../wac/execute.js';
