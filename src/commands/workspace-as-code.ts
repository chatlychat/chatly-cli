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
 * This reads JSON. `yaml` is in the lockfile only as a transitive
 * devDependency of `lint-staged`, which is not reachable from `apps/cli` and
 * would not ship with the published package either way, and CLAUDE.md §2
 * forbids adding a dependency without explicit approval. A hand-rolled YAML
 * subset was considered and rejected: indentation, quoting, anchors and
 * multi-line scalars are exactly the surface where a parser that is 95%
 * right produces a document that means something other than it says, which
 * is worse than one that will not load.
 *
 * So a `.yaml` path is refused with the one-line conversion rather than
 * half-parsed, and `--file -` reads stdin, which makes any converter a pipe.
 * The documented filename stays `chatly.yaml` in the integrator's words and
 * `chatly.json` in this implementation; when YAML is approved, `loadDocument`
 * is the only function that changes.
 */
import { readFileSync } from 'node:fs';

import { bool, str, type ParsedArgs } from '../args.js';
import { printJson } from '../output.js';
import {
  harvestSecrets,
  renderOutcomes,
  writesFor,
  type ApplyOptions,
  type ApplyOutcome,
  type FoundSecret,
} from '../wac/apply.js';
import { buildPlan, tally, type LiveSection, type Plan } from '../wac/diff.js';
import { parseDocument, type WacDocument } from '../wac/document.js';
import { planFooter, planForJson, renderPlan } from '../wac/render.js';
import { resourceDef, type ResourceDef } from '../wac/resources.js';

import type { ChatlyClient, Page } from '@chatlychat/sdk-node';

/** Looked for in order when `--file` is absent. */
const DEFAULT_FILES = ['chatly.json', 'chatly.yaml', 'chatly.yml'] as const;

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

function readFile(path: string): string {
  try {
    // `0` is stdin, so `converter | chatly plan --file -` works.
    return path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function findDefault(): string {
  for (const candidate of DEFAULT_FILES) {
    try {
      readFileSync(candidate, 'utf8');
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(
    'No document found. Looked for chatly.json, chatly.yaml and chatly.yml in this ' +
      'directory.\nPass one with --file, or --file - to read stdin.\n' +
      'There is a worked example at https://chatlychat.com/docs/sdk-cli#workspace-as-code',
  );
}

export function loadDocument(args: ParsedArgs, env: NodeJS.ProcessEnv = process.env): WacDocument {
  const path = str(args.flags, 'file') ?? findDefault();
  const raw = readFile(path);
  if (/\.ya?ml$/i.test(path) || /^\s*(?:version|resources)\s*:/m.test(raw)) {
    /*
     * Refused, not half-parsed.
     *
     * The second half of that test catches a YAML document passed under a
     * `.json` name or through stdin, which is the shape of the mistake
     * somebody makes once. A YAML file handed to `JSON.parse` fails with
     * "Unexpected token v", which sends the reader looking for a syntax error
     * in their own file rather than at the one sentence they need.
     */
    throw new Error(
      `${path} looks like YAML, and this CLI reads JSON.\n\n` +
        'YAML needs a parser, and adding a dependency to a published CLI is a decision this\n' +
        'repo does not make casually (CLAUDE.md §2) — `yaml` is in the monorepo lockfile only\n' +
        'as a transitive devDependency of lint-staged, so it is not something we already ship.\n' +
        'A 95%-right hand-rolled YAML subset is worse than no YAML: it loads a document that\n' +
        'means something other than what it says.\n\n' +
        'Convert it and pipe it:\n' +
        `  npx js-yaml ${path} | chatly plan --file -\n` +
        '  python3 -c "import sys,yaml,json;json.dump(yaml.safe_load(sys.stdin),sys.stdout)" \\\n' +
        `    < ${path} | chatly plan --file -`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err instanceof Error ? err.message : '?'}`);
  }
  return parseDocument(parsed, env);
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
  if (doc.workspace === undefined) {
    return undefined;
  }
  const me = await chatly.whoami();
  if (me.workspaceId === doc.workspace) {
    return undefined;
  }
  return (
    `Refusing to run: the document says \`"workspace": "${doc.workspace}"\` and this key ` +
    `belongs to ${me.workspaceId}.\n` +
    'Either point --key / CHATLY_API_KEY at the right workspace, or remove the `workspace` ' +
    'line if this document is meant to be portable.'
  );
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

  const outcomes = await execute(chatly, built, opts);
  if (bool(args.flags, 'json')) {
    printJson({ outcomes, warnings: built.warnings });
  } else {
    process.stdout.write(renderOutcomes(outcomes));
  }
  return outcomes.some((o) => o.state === 'failed' || o.state === 'skipped') ? 1 : 0;
}

/**
 * Walk the plan and do it. Continue on failure; never cascade.
 *
 * Exported so `wac.spec.ts` can drive it with a scripted transport and assert
 * on the requests that went over the wire — the shape CLAUDE.md insists on
 * ("assert on the request, not the canned response"), since a fake transport
 * that echoes whatever the caller sent agrees with the bug.
 */
export async function execute(
  chatly: ChatlyClient,
  built: Plan,
  opts: ApplyOptions,
): Promise<ReadonlyArray<ApplyOutcome>> {
  const outcomes: ApplyOutcome[] = [];
  /** `type/key` → the id a create in THIS run returned. */
  const refIds = new Map<string, string>();
  /** `type/key` that failed, so its dependents are skipped not attempted. */
  const failed = new Set<string>();

  for (const item of built.items) {
    const def = resourceDef(item.type);
    if (def === undefined) {
      continue;
    }
    const address = `${item.type}/${item.key}`;

    if (item.action === 'noop') {
      continue;
    }
    if (item.action === 'blocked') {
      outcomes.push({ ...base(item), state: 'skipped', detail: item.reason, secrets: [] });
      continue;
    }

    const blocker = item.dependsOn.find((d) => failed.has(d));
    if (blocker !== undefined) {
      outcomes.push({
        ...base(item),
        state: 'skipped',
        detail:
          `${blocker} failed above, and this names it. Attempting it anyway would produce a ` +
          'second error about a missing id that points at the wrong thing.',
        secrets: [],
      });
      failed.add(address);
      continue;
    }

    const ops = writesFor(def, item, refIds, opts);
    if (ops.length === 0) {
      outcomes.push({
        ...base(item),
        state: 'kept',
        detail:
          item.action === 'orphan'
            ? opts.prune
              ? def.remove === null
                ? (def.removeBlocked ?? 'no DELETE route.')
                : 'this type cannot be pruned safely on this run (see the warnings)'
              : '`--prune` would delete it'
            : undefined,
        secrets: [],
      });
      continue;
    }

    const secrets: FoundSecret[] = [];
    let ok = true;
    for (const op of ops) {
      try {
        const response = await chatly.request<unknown>(
          op.method,
          op.path,
          op.body === undefined ? {} : { body: op.body },
        );
        secrets.push(...harvestSecrets(def, item, response));
        const id = idOf(response, def);
        if (id !== undefined) {
          refIds.set(address, id);
        }
      } catch (err) {
        ok = false;
        failed.add(address);
        outcomes.push({
          ...base(item),
          state: 'failed',
          detail: `${op.method} ${op.path} — ${err instanceof Error ? err.message : String(err)}`,
          secrets,
        });
        break;
      }
    }
    if (ok) {
      outcomes.push({ ...base(item), state: 'applied', detail: undefined, secrets });
    }
  }
  return outcomes;
}

function base(item: Plan['items'][number]): Omit<ApplyOutcome, 'state' | 'detail' | 'secrets'> {
  return { type: item.type, key: item.key, action: item.action };
}

/**
 * The id out of a write response, for a reference a later section needs.
 *
 * Two levels, because `POST /v1/customer-cards` answers
 * `{ card: { id }, secret }` rather than the card itself — the same envelope
 * quirk that makes the secret sweep two levels deep.
 */
function idOf(response: unknown, def: ResourceDef): string | undefined {
  if (typeof response !== 'object' || response === null) {
    return undefined;
  }
  const top = response as Record<string, unknown>;
  const direct = top[def.idField];
  if (typeof direct === 'string' && direct.length > 0) {
    return direct;
  }
  for (const value of Object.values(top)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const nested = (value as Record<string, unknown>)[def.idField];
      if (typeof nested === 'string' && nested.length > 0) {
        return nested;
      }
    }
  }
  return undefined;
}
