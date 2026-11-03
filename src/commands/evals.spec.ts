/**
 * `chatly evals` — asserted on what it SENDS and on the exit code it returns.
 *
 * The exit code IS the feature: `chatly evals run --suite <id>` is meant to be
 * a CI step, so a command that printed "FAIL" and exited 0 would be worse than
 * one that did nothing. Every test below reads the code, and the ones that
 * matter also read the recorded `request()` arguments — a fake client that
 * answered a canned run would agree with a command that polled the wrong path
 * or never polled at all.
 */
import { describe, expect, it, vi } from 'vitest';

import { evals } from './evals.js';
import { parseArgs } from '../args.js';

import type { ChatlyClient } from '@chatlychat/sdk-node';

const SUITE = 's_1';
const RUN = 'r_1';

interface Call {
  method: string;
  path: string;
  options: Record<string, unknown>;
}

/** Answers each call from a queue, so a poll sequence can be scripted. */
function client(answers: ReadonlyArray<unknown>) {
  const calls: Call[] = [];
  let i = 0;
  const request = vi.fn((method: string, path: string, options: Record<string, unknown> = {}) => {
    calls.push({ method, path, options });
    const answer = answers[Math.min(i, answers.length - 1)];
    i += 1;
    return Promise.resolve(answer);
  });
  return { calls, chatly: { request } as unknown as ChatlyClient };
}

const run = (c: ChatlyClient, line: string) => evals(c, parseArgs(line.split(' ')));

const runRow = (over: Record<string, unknown> = {}) => ({
  id: RUN,
  suiteId: SUITE,
  status: 'succeeded',
  casesTotal: 1,
  casesPassed: 1,
  casesFailed: 0,
  regressionsFailed: 0,
  error: null,
  results: [
    {
      caseName: 'refunds',
      regression: false,
      passed: true,
      latencyMs: 120,
      assertionResults: [{ kind: 'response', passed: true, detail: '' }],
      error: null,
    },
  ],
  ...over,
});

describe('chatly evals run', () => {
  it('starts the run, then reads it back from the nested run path', async () => {
    const h = client([runRow(), runRow()]);
    const code = await run(h.chatly, 'evals run --suite s_1');
    expect(code).toBe(0);
    expect(h.calls[0]).toMatchObject({ method: 'POST', path: '/v1/bot-eval-suites/s_1/runs' });
    // The POST already answered a TERMINAL status, so no poll was needed and
    // the second call is the detail read.
    expect(h.calls[1]).toMatchObject({
      method: 'GET',
      path: '/v1/bot-eval-suites/s_1/runs/r_1',
    });
  });

  it('exits 1 when a case failed', async () => {
    const failed = runRow({
      status: 'failed',
      casesPassed: 0,
      casesFailed: 1,
      results: [
        {
          caseName: 'refunds',
          regression: true,
          passed: false,
          latencyMs: 90,
          assertionResults: [
            { kind: 'response', passed: false, detail: 'reply does not contain "refund"' },
          ],
          error: null,
        },
      ],
      regressionsFailed: 1,
    });
    const h = client([failed, failed]);
    expect(await run(h.chatly, 'evals run --suite s_1')).toBe(1);
  });

  it('exits 1 on `errored`, because a suite that could not run has not passed', async () => {
    const errored = runRow({
      status: 'errored',
      casesPassed: 0,
      casesFailed: 1,
      error: 'No AI provider is configured',
      results: [],
    });
    const h = client([errored, errored]);
    expect(await run(h.chatly, 'evals run --suite s_1')).toBe(1);
  });

  it('gives up waiting without claiming a pass', async () => {
    // `--timeout 0` makes the deadline already past on the first loop check.
    const h = client([runRow({ status: 'running', casesPassed: 0 })]);
    const code = await run(h.chatly, 'evals run --suite s_1 --timeout 0');
    expect(code).toBe(1);
    // It did NOT fetch the detail: the run is still going.
    expect(h.calls).toHaveLength(1);
  });

  it('carries the verdict in the exit code even with --json', async () => {
    const failed = runRow({ status: 'failed', casesPassed: 0, casesFailed: 1 });
    const h = client([failed, failed]);
    expect(await run(h.chatly, 'evals run --suite s_1 --json')).toBe(1);
  });

  it('refuses without --suite instead of running something else', async () => {
    const h = client([runRow()]);
    expect(await run(h.chatly, 'evals run')).toBe(2);
    expect(h.calls).toHaveLength(0);
  });
});

describe('chatly evals push', () => {
  it('POSTs the file for a new suite and PATCHes it with --suite', async () => {
    const { writeFile, mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'chatly-evals-'));
    const file = join(dir, 'suite.json');
    const doc = {
      botId: '00000000-0000-7000-8000-000000000001',
      name: 'refunds',
      cases: [
        {
          name: 'c1',
          messages: [{ role: 'user', content: 'hi' }],
          assertions: [{ kind: 'response', match: 'contains', value: 'hello' }],
        },
      ],
    };
    await writeFile(file, JSON.stringify(doc), 'utf8');

    const created = { id: SUITE, name: 'refunds', caseCount: 1 };
    const fresh = client([created]);
    expect(await run(fresh.chatly, `evals push --file ${file}`)).toBe(0);
    expect(fresh.calls[0]).toMatchObject({ method: 'POST', path: '/v1/bot-eval-suites' });
    // The document reaches the server unchanged — the API's zod schema is the
    // one definition of the vocabulary, so the CLI must not reshape it.
    expect(fresh.calls[0]?.options.body).toEqual(doc);

    const existing = client([created]);
    await run(existing.chatly, `evals push --file ${file} --suite ${SUITE}`);
    expect(existing.calls[0]).toMatchObject({
      method: 'PATCH',
      path: `/v1/bot-eval-suites/${SUITE}`,
    });
  });

  it('is a local usage error, not a 400, when the file is unreadable', async () => {
    const h = client([{}]);
    expect(await run(h.chatly, 'evals push --file /nope/missing.json')).toBe(2);
    expect(h.calls).toHaveLength(0);
  });

  it('refuses without --file', async () => {
    const h = client([{}]);
    expect(await run(h.chatly, 'evals push')).toBe(2);
    expect(h.calls).toHaveLength(0);
  });
});

describe('chatly evals list / show / delete', () => {
  it('lists suites', async () => {
    const h = client([{ items: [{ id: SUITE, name: 'refunds', caseCount: 3 }], nextCursor: null }]);
    expect(await run(h.chatly, 'evals list')).toBe(0);
    expect(h.calls[0]).toMatchObject({ method: 'GET', path: '/v1/bot-eval-suites' });
  });

  it('shows one run and returns its verdict', async () => {
    const h = client([runRow({ status: 'failed', casesPassed: 0, casesFailed: 1 })]);
    expect(await run(h.chatly, 'evals show --suite s_1 --run r_1')).toBe(1);
    expect(h.calls[0]).toMatchObject({
      method: 'GET',
      path: '/v1/bot-eval-suites/s_1/runs/r_1',
    });
  });

  it('shows the suite and its runs when --run is omitted', async () => {
    const h = client([
      { id: SUITE, name: 'refunds', botId: 'b_1', cases: [] },
      { items: [], nextCursor: null },
    ]);
    expect(await run(h.chatly, 'evals show --suite s_1')).toBe(0);
    expect(h.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /v1/bot-eval-suites/s_1',
      'GET /v1/bot-eval-suites/s_1/runs',
    ]);
  });

  it('refuses show without --suite', async () => {
    const h = client([{}]);
    expect(await run(h.chatly, 'evals show --run r_1')).toBe(2);
    expect(h.calls).toHaveLength(0);
  });

  it('deletes a suite', async () => {
    const h = client([undefined]);
    expect(await run(h.chatly, 'evals delete --suite s_1')).toBe(0);
    expect(h.calls[0]).toMatchObject({ method: 'DELETE', path: '/v1/bot-eval-suites/s_1' });
  });

  it('a bare `evals` is help (0) and an unknown subcommand is a usage error (2)', async () => {
    const h = client([{}]);
    expect(await run(h.chatly, 'evals')).toBe(0);
    expect(await run(h.chatly, 'evals frobnicate')).toBe(2);
    expect(h.calls).toHaveLength(0);
  });
});
