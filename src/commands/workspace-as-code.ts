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
import { bool, str, type ParsedArgs } from '../args.js';
import { printJson } from '../output.js';
import { unverified } from './platform-as-code.js';
import { renderOutcomes, type ApplyOptions } from '../wac/apply.js';
import { buildPlan, tally, type LiveSection } from '../wac/diff.js';
import { WORKSPACE_SCHEMA, type WacDocument } from '../wac/document.js';
import { execute } from '../wac/execute.js';
import { loadFrom } from '../wac/load.js';
import { planFooter, planForJson, renderPlan } from '../wac/render.js';
import { naturalKeys, resourceDef } from '../wac/resources.js';
import { missingScopes, scopesFor, SCOPED_COMMANDS, type ScopedCommand } from '../wac/scopes.js';

import type { ResourceDef } from '../wac/resource-def.js';
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
 * Types this document REFERENCES without declaring a section for them.
 *
 * ForgeDeck 2026-11-07 item 4, reproduced twice: a document carrying only
 * `botRoutes`, each naming a bot that exists on the server, planned every row
 * as `BLOCKED — names bots/fd-bot, which is neither on the server nor created
 * by this plan`. The bot WAS on the server; nothing had looked.
 *
 * `known` in `buildPlan` is built from the declared sections, so an
 * undeclared type has no entry and every reference into it fails. The
 * platform document already had the answer for exactly this shape
 * (`PlanOptions.referenced`, CHT-F04: an `apiKeys` row naming a tenant
 * somebody else created) and the workspace command simply never passed it —
 * its own doc comment said "Empty for the workspace document."
 *
 * The alternative the message itself suggests — declare `resources.bots` —
 * is worse than it sounds: a document that declares a section owns it, so
 * every bot the file does not list becomes an orphan line, and `--prune`
 * would offer to delete them.
 *
 * Reading them costs one GET per referenced type, and only for a document
 * that does not declare it.
 */
export function referencedDefs(doc: WacDocument): ReadonlyArray<ResourceDef> {
  const declared = new Set(doc.sections.map((sec) => sec.def.type));
  const out = new Map<string, ResourceDef>();
  for (const section of doc.sections) {
    for (const ref of Object.values(section.def.references ?? {})) {
      if (declared.has(ref.type) || out.has(ref.type)) {
        continue;
      }
      const def = resourceDef(ref.type);
      if (def !== undefined) {
        out.set(ref.type, def);
      }
    }
  }
  return [...out.values()];
}

/**
 * Those types as `buildPlan` wants them: resolvable by a reference, never
 * planned, never an orphan. Built from the same list the reader used, so a
 * type that was fetched is a type that can be resolved.
 */
function referencedSections(
  doc: WacDocument,
  live: ReadonlyMap<string, LiveSection>,
): ReadonlyArray<{ def: ResourceDef; section: LiveSection }> {
  return referencedDefs(doc).map((def) => ({ def, section: live.get(def.type) ?? { rows: [] } }));
}

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
  for (const def of [...doc.sections.map((sec) => sec.def), ...referencedDefs(doc)]) {
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
      out.set(def.type, {
        rows:
          def.existsWhen === undefined ? rows : rows.filter((r) => def.existsWhen?.(r) === true),
        ...(def.existsWhen === undefined ? {} : { allKeys: naturalKeys(def, rows), allRows: rows }),
      });
      continue;
    }
    const answer = await chatly.request<unknown>('GET', def.list.path);
    /*
     * `rowsFrom` first: a SINGLETON route answers one object, not a list.
     * `/v1/workspace/business-hours` and `/v1/ai/tone` are the two (CH-24),
     * and `Array.isArray` alone reads both as "no rows", which plans a create
     * for a resource that has no create route at all.
     */
    const all =
      def.rowsFrom !== undefined
        ? [...def.rowsFrom(answer)]
        : Array.isArray(answer)
          ? (answer as Array<Record<string, unknown>>)
          : [];
    /*
     * `possiblyTruncated` is judged on what the SERVER returned, before
     * `existsWhen` — the question it answers is whether the route hit its
     * cap, which a local filter cannot change.
     */
    const rows =
      def.existsWhen === undefined ? all : all.filter((r) => def.existsWhen?.(r) === true);
    out.set(def.type, {
      rows,
      possiblyTruncated: all.length >= EXEMPT_LIST_CAP,
      ...(def.existsWhen === undefined ? {} : { allKeys: naturalKeys(def, all), allRows: all }),
    });
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
  const built = buildPlan(doc, live, {
    writeOnly: bool(args.flags, 'write-only'),
    // `--rotate-secret`: the credentials inside a merge-written field and
    // nothing else unreadable. See `PlanOptions.rotateSecrets`.
    rotateSecrets: bool(args.flags, 'rotate-secret'),
    referenced: referencedSections(doc, live),
  });
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
  /*
   * 3 for a resource that matches the file and is BROKEN (CH-05), and 3 for a
   * document the server will REFUSE (CH-16) — both answered whether or not
   * `--exit-code` was passed.
   *
   * Every other non-zero code here is opt-in because `chatly plan` has to be
   * safe to run under `set -e` just to look at a diff. Neither of these is
   * drift. One is the server reporting that a documentation source has failed
   * its last sync; the other is a value this file states that the route's own
   * schema does not admit — `tokenProvider: "atlsa"`, which planned as a clean
   * change and exited 0 while `apply` answered 400. FormFlow runs `plan` as a
   * deploy gate precisely so that neither reaches production, and a gate that
   * has to be opted into is a gate that was off on the day it mattered.
   *
   * A BLOCKED row is deliberately NOT here: `--exit-code` answers 3 for it and
   * the default answers 1, which is what it has always done.
   */
  if (built.unhealthy.length > 0 || built.refused.length > 0) {
    return 3;
  }

  if (bool(args.flags, 'exit-code')) {
    /*
     * 3 before 2, because a pipeline wants to tell them apart: 2 is "production
     * has drifted from this file", which is the thing `--exit-code` is FOR, and
     * 3 is "this file will not apply at all". ForgeDeck's fifth report
     * (2026-11-06 item 3) had seven unapplyable documents exit 2, the same code
     * a good change exits, so nothing downstream could distinguish them.
     */
    const counts = tally(built);
    /*
     * A BLOCKED row answers 3 as well, because this CLI will not send it: the
     * document will not apply, which is what 3 means here and what `--help`
     * says. It answered 2 — the code a good change exits — so a pipeline
     * gating on 3 passed an unapplyable file and failed at `apply` instead.
     * Reported 2026-11-06, and it is the fifth report's item 3 surviving in
     * the one case that report did not cover.
     */
    if (counts.blocked > 0) {
      return 3;
    }
    return counts.create + counts.update > 0 ? 2 : 0;
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
  const rotateSecrets = bool(args.flags, 'rotate-secret');
  const built = buildPlan(doc, live, {
    writeOnly,
    rotateSecrets,
    referenced: referencedSections(doc, live),
  });
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
  const after = buildPlan(doc, liveAfter, {
    writeOnly: false,
    referenced: referencedSections(doc, liveAfter),
  });
  const mismatches = unverified(after, opts.prune);
  const publicIds = channelPublicIds(doc, liveAfter);
  /*
   * A failed row cannot be confirmed by a read-back, and saying "everything
   * matches" beside "nothing was written for these" is a straight
   * contradiction — ForgeDeck's seventh report, 2026-11-06 item 2, reproduced
   * twice. The read-back re-plans WITHOUT `--write-only` (anything else
   * reports every opaque field as a change for ever), so a write-only value
   * that failed to be written is not compared at all and the plan comes back
   * clean. The exit code was already 1; only the sentence lied.
   *
   * `verified` in `--json` carried the same claim and is corrected with it: a
   * script reading `verified: true` off a run that failed is this defect in
   * the form that gets acted on automatically.
   */
  const failed = outcomes.some((o) => o.state === 'failed' || o.state === 'skipped');
  /*
   * A resource that matches the document and is FAILING on the server
   * (CH-05). The read-back compares the file against the live row and they
   * agree, so `mismatches` is empty and every write succeeded — and
   * "everything matches the document" is then a true sentence that reads as
   * an all-clear over a knowledge source that has not synced in a week. Same
   * defect as the two notes below, arriving from the other side: there the
   * summary over-claimed about writes, here about health.
   */
  const unhealthy = after.unhealthy;
  /*
   * ForgeDeck's eighth report item 1: "the rows that were written match the
   * document" was printed on a run where NO row was written — every row
   * failed. The sentence was written for the mixed case and is the only one
   * that fires once `failed` is true.
   */
  const wrote = outcomes.some((o) => o.state === 'applied');
  if (bool(args.flags, 'json')) {
    printJson({
      outcomes,
      warnings: built.warnings,
      verified: mismatches.length === 0 && !failed,
      mismatches,
      unhealthy,
      publicIds,
    });
  } else {
    process.stdout.write(renderOutcomes(outcomes));
    for (const [key, publicId] of Object.entries(publicIds)) {
      process.stdout.write(`channels/${key}: publicId ${publicId}\n`);
    }
    process.stdout.write(
      mismatches.length > 0
        ? `\nRead back: ${String(mismatches.length)} item(s) still differ from the document:\n` +
            mismatches.map((m) => `  ${m}\n`).join('')
        : !failed
          ? unhealthy.length > 0
            ? `\nRead back: every field matches the document, but ${String(unhealthy.length)} ` +
              `resource(s) are FAILING on the server (${unhealthy.join(', ')}). The plan above ` +
              'says why. Nothing here can fix that — it is not a configuration difference.\n'
            : '\nRead back: everything matches the document.\n'
          : wrote
            ? '\nRead back: the rows that were written match the document. The failed row(s) ' +
              'above are NOT confirmed — a write-only value cannot be read back.\n'
            : '\nRead back: nothing was written, so there is nothing to confirm. The failed ' +
              'row(s) above are listed with their reasons.\n',
    );
  }
  /*
   * An unhealthy resource does NOT make `apply` exit non-zero: `apply`
   * reports what it wrote, and it wrote everything the document asked for.
   * `plan` is the command that answers 3 for this, and the sentence above is
   * what stops the run reading as an all-clear.
   */
  return failed || mismatches.length > 0 ? 1 : 0;
}

/** Re-exported: it moved to `wac/execute.ts` so `chatly platform apply` shares it. */
export { execute } from '../wac/execute.js';

/* ── whoami --for ─────────────────────────────────────────────────────── */

/**
 * `chatly whoami --for plan|apply|doctor|all` — does this key hold enough
 * (CH-17)?
 *
 * Here rather than in `commands/auth.ts` because the answer is derived from
 * the resource table these two commands drive, and a command module must not
 * depend on another command module. `run.ts` routes `--for` to this and
 * everything else to `auth.whoami`.
 *
 * It reads `GET /v1/api-keys/whoami` ONCE and answers from the scopes the
 * server says the credential carries. It issues no other request: probing a
 * write to find out whether it is allowed is not a thing a readiness check
 * may do.
 *
 * Exits 1 when a scope is missing, so this is a CI step — a key that cannot
 * run the deploy should fail the job that is about to use it, not the deploy.
 */
export async function whoamiFor(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const asked = str(args.flags, 'for') ?? 'all';
  if (!(SCOPED_COMMANDS as ReadonlyArray<string>).includes(asked)) {
    process.stderr.write(`--for takes one of ${SCOPED_COMMANDS.join(', ')} (got "${asked}").\n`);
    return 2;
  }
  const wanted: ReadonlyArray<ScopedCommand> =
    asked === 'all' ? ['plan', 'apply', 'doctor'] : [asked as ScopedCommand];

  /*
   * The document, when there is one. `plan` and `apply` read and write only
   * the types their file declares, so answering for all thirteen resources
   * would report `macros:read` missing for a document with no macros —
   * a false alarm on the one command whose whole job is to prevent them.
   *
   * A document that is absent or will not parse is not an error here: the
   * answer widens to every resource type and says so, because somebody
   * asking what a key needs may not have written the file yet.
   */
  let doc: WacDocument | undefined;
  let why: string | undefined;
  try {
    doc = loadDocument(args);
  } catch (err) {
    why = err instanceof Error ? err.message.split('\n')[0] : String(err);
  }

  const me = await chatly.request<{
    workspaceId?: unknown;
    scopes?: unknown;
    expiresAt?: unknown;
  }>('GET', '/v1/api-keys/whoami');
  const held = Array.isArray(me.scopes)
    ? me.scopes.filter((s): s is string => typeof s === 'string')
    : [];

  const report = wanted.map((command) => {
    const needed = scopesFor(command, command === 'doctor' ? undefined : doc);
    return { command, needed, missing: missingScopes(held, needed) };
  });
  const short = report.flatMap((r) => r.missing);

  if (bool(args.flags, 'json')) {
    printJson({
      workspaceId: me.workspaceId ?? null,
      scopes: held,
      expiresAt: me.expiresAt ?? null,
      expiryWarning: expiryWarning(me.expiresAt),
      document: doc === undefined ? null : doc.sections.map((sec) => sec.def.type),
      commands: report,
      ok: short.length === 0,
    });
    return short.length === 0 ? 0 : 1;
  }

  process.stdout.write(`workspace  ${String(me.workspaceId ?? '(unknown)')}\n`);
  process.stdout.write(`scopes     ${held.length === 0 ? '(none)' : held.join(', ')}\n`);
  for (const { command, needed, missing } of report) {
    process.stdout.write(
      missing.length === 0
        ? `${command.padEnd(10)} ok — holds all ${String(needed.length)} scope(s) it needs\n`
        : `${command.padEnd(10)} MISSING ${missing.join(', ')}\n`,
    );
  }
  if (doc === undefined) {
    process.stdout.write(
      `\nNo workspace document was read (${why ?? 'none found'}), so plan and apply are ` +
        'answered for EVERY resource type. Point --file at your chatly.yaml for the narrow ' +
        'answer.\n',
    );
  }
  const expiry = expiryWarning(me.expiresAt);
  if (expiry !== null) {
    process.stdout.write(`\n${expiry}\n`);
  }
  if (short.length > 0) {
    process.stdout.write(
      '\nAdd them in the dashboard under Workspace → Integrations → Developer → API keys, ' +
        'or mint a replacement with ' +
        '`chatly api-keys create`. `chatly workspace key-scopes` lists every scope there is.\n',
    );
  }
  return short.length === 0 ? 0 : 1;
}

/**
 * The 60-day expiry warning (CH-17).
 *
 * `readiness.key_expiry` already exists and `chatly doctor` already prints
 * it — but the SERVER computes it, at 30 days, and that threshold is not
 * this CLI's to move (`apps/api/src/modules/workspaces/workspace-readiness.ts`).
 * 60 days is the number FormFlow asked for, and the CLI has the date in hand
 * from the same read it is already making, so it says so here. The server's
 * 30-day verdict still arrives through `doctor`; this is earlier, not
 * instead.
 */
function expiryWarning(expiresAt: unknown): string | null {
  if (typeof expiresAt !== 'string' || expiresAt === '') {
    return null;
  }
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) {
    return null;
  }
  const days = Math.floor((at - Date.now()) / 86_400_000);
  if (days < 0) {
    return `This key EXPIRED on ${expiresAt}. Rotate it: see Rotating a CI key in https://chatlychat.com/docs/sdk-cli.`;
  }
  if (days > 60) {
    return null;
  }
  return (
    `This key expires in ${String(days)} day(s), on ${expiresAt}. Rotating needs ` +
    '`api_keys:write` — see Rotating a CI key in https://chatlychat.com/docs/sdk-cli.'
  );
}
