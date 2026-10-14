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

  const summary =
    `${String(counts.create)} to create, ${String(counts.update)} to change, ` +
    `${String(counts.noop)} unchanged, ${String(counts.orphan)} on the server only, ` +
    `${String(counts.blocked)} that cannot be applied`;

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
  if (counts.create + counts.update === 0 && (counts.orphan === 0 || !opts.prune)) {
    lines.push('There is nothing to apply.');
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
  };
}
