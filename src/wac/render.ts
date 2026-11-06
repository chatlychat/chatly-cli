/**
 * Printing a plan, and one rule behind every choice here: a diff nobody reads
 * is worse than no diff, because it gets approved.
 *
 * So the shape is terraform's, because that is the shape people already know
 * how to read — a sigil per action, the resource addressed as `type/key`, and
 * the changed fields indented under it with old on the left. What is NOT
 * terraform's: unchanged resources are one line each rather than a collapsed
 * count, because on this surface a workspace has tens of resources and not
 * thousands, and "the thing I expected to be unchanged is listed as
 * unchanged" is the second most useful sentence a plan can say.
 *
 * Values are JSON, truncated. A macro body is 20,000 characters and a
 * trigger's `actions` array is a nested object; neither belongs on a terminal
 * line in full, and `--json` exists for the whole thing.
 */
import { tally, type FieldChange, type Plan, type PlanItem } from './diff.js';

const SIGIL: Record<PlanItem['action'], string> = {
  create: '+',
  update: '~',
  noop: '=',
  orphan: '-',
  blocked: '!',
};

const MAX_VALUE = 72;

/** One value, as JSON, clipped. `undefined` is `(unset)`, not `undefined`. */
export function show(value: unknown): string {
  if (value === undefined) {
    return '(unset)';
  }
  const text = JSON.stringify(value) ?? String(value);
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE - 1)}…` : text;
}

function changeLine(item: PlanItem, change: FieldChange): string {
  const masked = item.row?.fromEnv.includes(change.name) === true;
  const to = masked ? '(from the environment)' : show(change.to);
  if (item.action === 'create') {
    return `      ${change.name} = ${to}`;
  }
  return `      ${change.name}: ${masked ? '(unreadable)' : show(change.from)} -> ${to}`;
}

export interface RenderOptions {
  /** `--prune` was passed, so orphan lines say "delete" rather than "kept". */
  readonly prune: boolean;
  /** Types whose live list may be short, where prune is refused regardless. */
  readonly pruneUnsafe: ReadonlyArray<string>;
}

/** The whole plan, as `chatly plan` prints it. */
export function renderPlan(plan: Plan, opts: RenderOptions): string {
  const counts = tally(plan);
  const out: string[] = [];

  for (const item of plan.items) {
    const head = `  ${SIGIL[item.action]} ${item.type}/${item.key}`;
    if (item.action === 'noop') {
      out.push(`${head}   unchanged`);
      for (const note of item.notes) {
        out.push(`      · ${note}`);
      }
      continue;
    }
    if (item.action === 'orphan') {
      const fate =
        item.notes.length > 0
          ? 'kept'
          : opts.pruneUnsafe.includes(item.type)
            ? 'kept — this type cannot be pruned safely on this run'
            : opts.prune
              ? 'DELETE'
              : 'kept — `--prune` would delete it';
      out.push(`${head}   on the server, not in this document; ${fate}`);
      for (const note of item.notes) {
        out.push(`      · ${note}`);
      }
      continue;
    }
    if (item.action === 'blocked') {
      out.push(`${head}   CANNOT APPLY`);
      out.push(`      ${item.reason ?? 'no reason recorded, which is itself a bug.'}`);
      for (const change of item.changes) {
        out.push(changeLine(item, change));
      }
      continue;
    }
    out.push(`${head}   ${item.action === 'create' ? 'create' : 'change'}`);
    for (const change of item.changes) {
      out.push(changeLine(item, change));
    }
    for (const note of item.notes) {
      out.push(`      · ${note}`);
    }
  }

  if (out.length === 0) {
    out.push('  (the document declares no resources)');
  }

  /*
   * `blocked` and `refused` are added, and the two footer lines keep them
   * apart. ForgeDeck's sixth report, 2026-11-06 item 3: a refused document
   * read `1 to create … 0 that cannot be applied`, and someone reading the
   * first line runs `apply`. From the reader's seat both are "cannot be
   * applied" — this CLI will not send one, the server will not accept the
   * other — so the SUMMARY is the wrong place to make that distinction and
   * the footer is the right one. Safe to add because `blocked` is an action
   * and `refusedRowKeys` only counts `create`/`update`, so nothing is in both.
   */
  const summary =
    `${String(counts.create)} to create, ${String(counts.update)} to change, ` +
    `${String(counts.noop)} unchanged, ${String(counts.orphan)} on the server only, ` +
    `${String(counts.blocked + plan.refused.length)} that cannot be applied`;

  const parts = [`Plan: ${summary}`, '', ...out];

  if (plan.warnings.length > 0) {
    parts.push('', 'Warnings');
    for (const warning of plan.warnings) {
      parts.push(`  ! ${warning}`);
    }
  }

  return `${parts.join('\n')}\n`;
}

/**
 * The line that follows a plan, and it is load-bearing.
 *
 * `plan` is the half of this feature that is safe, and saying so explicitly
 * is what makes somebody willing to run it against production. "Nothing was
 * written" is a claim the spec holds this CLI to: a recording transport
 * asserts zero non-GET requests over the whole plan path.
 */
export function planFooter(plan: Plan, opts: RenderOptions): string {
  const counts = tally(plan);
  const lines = ['', 'Nothing was written — `plan` issues reads only.'];
  /*
   * Telling someone to run `apply` when every change in the plan will be
   * refused is the line they act on before reading the warning underneath it
   * (ForgeDeck's sixth report, item 3). `>=` rather than `===` because a
   * section-level refusal can name a key twice.
   */
  const changing = counts.create + counts.update;
  const allRefused = changing > 0 && plan.refused.length >= changing;
  if ((changing === 0 || allRefused) && (counts.orphan === 0 || !opts.prune)) {
    lines.push(
      allRefused
        ? 'There is nothing to apply that the server would accept — fix the documents below.'
        : 'There is nothing to apply.',
    );
  } else {
    lines.push(
      `Run \`chatly apply\`${opts.prune ? ' --prune' : ''} to make ` +
        `${String(counts.create + counts.update + (opts.prune ? counts.orphan : 0))} change(s).`,
    );
  }
  if (counts.blocked > 0) {
    lines.push(
      `${String(counts.blocked)} resource(s) cannot be applied and \`apply\` will skip them ` +
        'rather than half-write them. The reason is on each line.',
    );
  }
  /*
   * Rows the SERVER will refuse, which is a different thing from `blocked`.
   * `apply` still sends these — the server, not this CLI, is the authority on
   * what it accepts — so the honest summary is "these will fail", not "these
   * will be skipped". ForgeDeck's fifth report, 2026-11-06 item 3: seven
   * documents planned as `0 that cannot be applied` and `apply` refused all
   * seven, so the plan read identically whether the change was ready or
   * doomed. `--exit-code` returns 3 for this, distinct from 2 for drift.
   */
  if (plan.refused.length > 0) {
    lines.push(
      `${String(plan.refused.length)} document(s) will be REFUSED by the server as written ` +
        `(${plan.refused.join(', ')}). The warnings above say why. \`apply\` will still try ` +
        'them — the server decides, not this CLI — so expect it to fail until they are fixed. ' +
        '`--exit-code` answers 3 for this.',
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The plan, for `--json`, with every env-sourced value taken back out.
 *
 * `plan --json | tee plan.json` is a thing somebody does on the first day,
 * and a plan item carries `row.body` — which holds the RESOLVED value of
 * every `${env:…}` reference, including a docs source's provider token. The
 * human renderer already masks those (`fromEnv` on each row); the JSON
 * renderer printed them, which would have written a live credential into a
 * file somebody then commits.
 *
 * So `row` does not go out at all — a consumer wants the diff, not a copy of
 * its own input — and any change whose field came from the environment is
 * reported as having come from the environment rather than by value.
 */
export function planForJson(plan: Plan): unknown {
  return {
    plan: plan.items.map((item) => ({
      type: item.type,
      key: item.key,
      action: item.action,
      liveId: item.liveId ?? null,
      reason: item.reason ?? null,
      notes: item.notes,
      dependsOn: item.dependsOn,
      changes: item.changes.map((change) =>
        item.row?.fromEnv.includes(change.name) === true
          ? { name: change.name, from: '(unreadable)', to: '(from the environment)' }
          : { name: change.name, from: change.from ?? null, to: change.to },
      ),
    })),
    warnings: plan.warnings,
    pruneUnsafe: plan.pruneUnsafe,
    // Top level, because the reason is prose inside `warnings` and a script
    // had only the exit code to go on (ForgeDeck's sixth report, item 3).
    refused: plan.refused,
  };
}
