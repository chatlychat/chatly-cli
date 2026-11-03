/**
 * `chatly evals` — run a bot's test suite from a terminal or from CI.
 *
 * ═══ WHY A FILE AND NOT FLAGS ═════════════════════════════════════════════
 *
 * A suite is a list of conversations and what each one must satisfy. There is
 * no flag spelling of that which is not worse than JSON, and the thing people
 * actually want is for the suite to live in their repository next to the
 * prompt it tests — so `evals push --file suite.json` is the whole write
 * surface and the API edits cases through their suite for the same reason.
 *
 * ═══ EXIT CODES ARE THE POINT ═════════════════════════════════════════════
 *
 * `evals run` exits 1 when a case failed, so `chatly evals run --suite <id>`
 * is a CI step. It exits 2 on a usage error and 1 on a run that could not be
 * evaluated at all (`errored` — no provider key, AI service down), which is
 * deliberately NOT 0: a suite that could not run has not passed.
 *
 * ═══ IT POLLS, BECAUSE THE RUN IS ASYNCHRONOUS ════════════════════════════
 *
 * `POST …/runs` answers immediately with a `queued` run; the API executes it
 * case by case and writes progress after each one. So this polls, prints the
 * count as it moves, and stops at a terminal status or at `--timeout`
 * seconds. A timeout leaves the run going — it is the WAIT that gave up, and
 * the message says so and names the command that shows the result.
 */
import { bool, num, str, type ParsedArgs } from '../args.js';
import { itemsOf, printJson, printTable } from '../output.js';

import type { ChatlyClient } from '@chatlychat/sdk-node';

/*
 * The paths are written out as LITERALS rather than assembled from a `BASE`
 * constant, and that is not a style preference.
 * `scripts/check-api-route-callers.mjs` indexes the path strings it can find
 * in source; `${BASE}/${id}/runs` is invisible to it, so six of these eight
 * routes were reported as having no caller at all while this file called
 * every one of them. A gate that cannot see the caller is the same as no
 * caller, since the next person reading the gate's output will delete the
 * route or add it to an allow-list.
 */
const SUITES = '/v1/bot-eval-suites';
const suitePath = (id: string) => `/v1/bot-eval-suites/${encodeURIComponent(id)}`;
const runsPath = (id: string) => `/v1/bot-eval-suites/${encodeURIComponent(id)}/runs`;
const runPath = (id: string, runId: string) =>
  `/v1/bot-eval-suites/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`;

const POLL_MS = 2_000;
const DEFAULT_TIMEOUT_S = 600;

interface AssertionResult {
  readonly kind: string;
  readonly passed: boolean;
  readonly detail: string;
  readonly degraded?: boolean;
}

interface CaseResult {
  readonly caseName: string;
  readonly regression: boolean;
  readonly passed: boolean;
  readonly latencyMs: number;
  readonly assertionResults: ReadonlyArray<AssertionResult>;
  readonly error: string | null;
}

interface SuiteDetail {
  readonly id: string;
  readonly name: string;
  readonly botId: string;
  readonly cases: ReadonlyArray<{ name: string; regression: boolean; position: number }>;
}

interface Run {
  readonly id: string;
  readonly suiteId: string;
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'errored';
  readonly casesTotal: number;
  readonly casesPassed: number;
  readonly casesFailed: number;
  readonly regressionsFailed: number;
  readonly error: string | null;
}

interface RunDetail extends Run {
  readonly results: ReadonlyArray<CaseResult>;
}

const USAGE = `chatly evals <list|push|run|show|delete>

  evals list                       Suites in this workspace, with case counts
  evals push --file <path>         Create or replace a suite from a JSON file
             [--suite <id>]        With --suite, PATCH that suite instead
  evals run --suite <id>           Run it, wait, print each case. Exits 1 on a
             [--timeout <seconds>] failure (default 600) so CI can gate on it
  evals show --suite <id>          The suite's cases and its recent runs
             [--run <id>]          With --run: that run, case by case
  evals delete --suite <id>        Delete a suite, its cases and its runs

  --json                           The raw API response, for jq

THE SUITE FILE
  {
    "botId": "<uuid>",
    "name": "refunds",
    "cases": [
      {
        "name": "does not invent a refund window",
        "messages": [{ "role": "user", "content": "how long do refunds take?" }],
        "assertions": [
          { "kind": "response", "match": "not_contains", "value": "30 days" },
          { "kind": "tools", "tool": "kb.search" },
          { "kind": "state", "escalated": false },
          { "kind": "timing", "maxLatencyMs": 8000 },
          { "kind": "judge", "minScore": 70 }
        ],
        "regression": true,
        "regressionNote": "CHT-991 — the bot invented a policy"
      }
    ]
  }

  A case marked \`regression\` pins a defect that was fixed. It runs like any
  other; it is COUNTED separately, because a regression failing means
  something that was broken, was fixed, and is broken again.
`;

const isTerminal = (s: Run['status']): boolean =>
  s === 'succeeded' || s === 'failed' || s === 'errored';

/** A run's one-line verdict, and the exit code that goes with it. */
function verdict(run: Run): { line: string; code: number } {
  const counts = `${String(run.casesPassed)} passed, ${String(run.casesFailed)} failed of ${String(run.casesTotal)}`;
  const regressions =
    run.regressionsFailed > 0 ? ` — ${String(run.regressionsFailed)} REGRESSION(S)` : '';
  if (run.status === 'succeeded') {
    return { line: `PASS  ${counts}`, code: 0 };
  }
  if (run.status === 'failed') {
    return { line: `FAIL  ${counts}${regressions}`, code: 1 };
  }
  // `errored`: the suite was not evaluated. Not a pass.
  return { line: `ERROR ${run.error ?? 'the run could not be completed'}  (${counts})`, code: 1 };
}

function printResults(results: ReadonlyArray<CaseResult>): void {
  for (const r of results) {
    const mark = r.passed ? 'ok  ' : 'FAIL';
    const tag = r.regression ? ' [regression]' : '';
    process.stdout.write(`${mark} ${r.caseName}${tag}  ${String(r.latencyMs)}ms\n`);
    if (r.error !== null) {
      process.stdout.write(`       turn failed: ${r.error}\n`);
    }
    for (const a of r.assertionResults) {
      if (!a.passed) {
        const why = a.degraded === true ? `${a.detail} (not checked)` : a.detail;
        process.stdout.write(`       ${a.kind}: ${why}\n`);
      }
    }
  }
}

export async function evals(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const sub = args.path[1];
  const json = bool(args.flags, 'json');
  const suite = str(args.flags, 'suite');

  if (sub === 'list') {
    const page = await chatly.request<unknown>('GET', SUITES);
    if (json) {
      printJson(page);
      return 0;
    }
    printTable(itemsOf(page), ['id', 'name', 'botId', 'caseCount', 'createdAt']);
    return 0;
  }

  if (sub === 'push') {
    const file = str(args.flags, 'file');
    if (file === undefined) {
      process.stderr.write('--file is required.\n\n');
      process.stderr.write(USAGE);
      return 2;
    }
    const { readFile } = await import('node:fs/promises');
    /*
     * Read and parsed here rather than streamed to the API, so a typo'd JSON
     * file is a local error with a line number instead of a 400. The CONTENT
     * is not validated locally on purpose: the API's zod schema is the one
     * definition of the vocabulary, and a second copy here would drift and
     * start refusing suites the server accepts.
     */
    let body: unknown;
    try {
      body = JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      process.stderr.write(`Could not read ${file}: ${err instanceof Error ? err.message : ''}\n`);
      return 2;
    }
    const created = await chatly.request<{ id: string; name: string; caseCount: number }>(
      suite === undefined ? 'POST' : 'PATCH',
      suite === undefined ? SUITES : suitePath(suite),
      { body },
    );
    if (json) {
      printJson(created);
      return 0;
    }
    process.stdout.write(
      `${created.id}  ${created.name}  ${String(created.caseCount)} case(s)\n` +
        `\nRun it:\n  chatly evals run --suite ${created.id}\n`,
    );
    return 0;
  }

  if (sub === 'delete') {
    if (suite === undefined) {
      process.stderr.write('--suite is required.\n\n');
      process.stderr.write(USAGE);
      return 2;
    }
    await chatly.request<unknown>('DELETE', suitePath(suite));
    process.stdout.write(`Deleted ${suite}.\n`);
    return 0;
  }

  if (sub === 'show') {
    if (suite === undefined) {
      process.stderr.write('--suite is required.\n\n');
      process.stderr.write(USAGE);
      return 2;
    }
    const runId = str(args.flags, 'run');
    if (runId === undefined) {
      // No --run: the suite itself, and how its recent runs went.
      const detail = await chatly.request<SuiteDetail>('GET', suitePath(suite));
      const runs = await chatly.request<unknown>('GET', runsPath(suite));
      if (json) {
        printJson({ suite: detail, runs });
        return 0;
      }
      process.stdout.write(`${detail.name}  bot ${detail.botId}\n\n`);
      printTable(detail.cases, ['name', 'regression', 'position']);
      process.stdout.write('\nRUNS\n');
      printTable(itemsOf(runs), ['id', 'status', 'casesPassed', 'casesFailed', 'createdAt']);
      return 0;
    }
    const detail = await chatly.request<RunDetail>('GET', runPath(suite, runId));
    if (json) {
      printJson(detail);
      return 0;
    }
    printResults(detail.results);
    const { line, code } = verdict(detail);
    process.stdout.write(`\n${line}\n`);
    return code;
  }

  if (sub === 'run') {
    if (suite === undefined) {
      process.stderr.write('--suite is required.\n\n');
      process.stderr.write(USAGE);
      return 2;
    }
    return runSuite(chatly, suite, {
      json,
      timeoutS: num(args.flags, 'timeout') ?? DEFAULT_TIMEOUT_S,
    });
  }

  process.stdout.write(USAGE);
  // A bare `evals` is help; an unrecognised subcommand is a usage error.
  return sub === undefined ? 0 : 2;
}

async function runSuite(
  chatly: ChatlyClient,
  suite: string,
  opts: { json: boolean; timeoutS: number },
): Promise<number> {
  const started = await chatly.request<Run>('POST', runsPath(suite), { body: {} });
  if (!opts.json) {
    process.stdout.write(`run ${started.id} — ${String(started.casesTotal)} case(s)\n`);
  }

  const deadline = Date.now() + opts.timeoutS * 1_000;
  let run = started;
  let lastDone = -1;
  while (!isTerminal(run.status)) {
    // `>=`, not `>`: `--timeout 0` then means "do not wait at all" rather
    // than "wait exactly one poll interval", which is what the strict
    // comparison did on a millisecond-granular clock.
    if (Date.now() >= deadline) {
      process.stderr.write(
        `\nStopped waiting after ${String(opts.timeoutS)}s. The run is still going —\n` +
          `  chatly evals show --suite ${suite} --run ${run.id}\n`,
      );
      // The WAIT gave up; the run did not fail. Still not a pass.
      return 1;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    run = await chatly.request<Run>('GET', runPath(suite, run.id));
    const done = run.casesPassed + run.casesFailed;
    if (!opts.json && done !== lastDone) {
      process.stdout.write(`  ${String(done)}/${String(run.casesTotal)}\n`);
      lastDone = done;
    }
  }

  const detail = await chatly.request<RunDetail>('GET', runPath(suite, run.id));
  if (opts.json) {
    printJson(detail);
    // Even in --json the exit code carries the verdict, so a CI step can gate
    // on it while piping the body to a report.
    return verdict(detail).code;
  }
  process.stdout.write('\n');
  printResults(detail.results);
  const { line, code } = verdict(detail);
  process.stdout.write(`\n${line}\n`);
  return code;
}
