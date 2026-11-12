/**
 * The Atlas receiver's AGE row in `chatly doctor` (CH-26).
 *
 * ═══ WHAT IS PINNED HERE, AND WHAT IS PINNED ELSEWHERE ════════════════════
 *
 * The reported defect — `12 ok, 0 failed` over a receiver answering 401 — is
 * fixed by CH-25's graded `atlas.receiver` check plus `healthChecks`' ok:false
 * → `fail` mapping, and `doctor-health.spec.ts` owns that. These assertions
 * are only about the half the server does not grade: the age of the last
 * accepted event, and an older deployment that publishes no numbers at all.
 *
 * The thing most worth pinning is what this file does NOT print. An earlier
 * draft graded the secret, the rejection and the recovery here too, and every
 * one of those rows would have appeared beside the server's own verdict about
 * the same receiver — two gradings of one fact, which is the drift this CLI
 * refuses everywhere else.
 *
 * CONTROL for each is in its comment. Run 2026-11-11; each break reverted.
 */
import { describe, expect, it, vi } from 'vitest';

import { parseArgs } from '../args.js';
import {
  ATLAS_RECEIVER_MAX_AGE_DAYS,
  atlasReceiverChecks,
  atlasReceiverFacts,
} from './doctor-atlas-receiver.js';
import { doctor } from './doctor.js';

import type { ChatlyClient } from '@chatlychat/sdk-node';

const NOW = new Date('2026-11-11T20:00:00.000Z');
const ago = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();

/** The body as `GET /v1/integration-health` publishes it. */
const body = (receiver: Record<string, unknown> | undefined): unknown => ({
  checks: [{ id: 'atlas.receiver', ok: true, detail: 'accepted', fix: null, docs: '' }],
  generatedAt: NOW.toISOString(),
  ...(receiver === undefined ? {} : { atlasReceiver: receiver }),
});

const live = (extra: Record<string, unknown>): unknown =>
  body({
    configured: true,
    connected: true,
    lastReceivedAt: null,
    lastVerifiedAt: null,
    lastRejectedAt: null,
    lastRejectedReason: null,
    rejectedCount24h: 0,
    ...extra,
  });

describe('atlasReceiverChecks', () => {
  /*
   * CONTROL: grading this arm `'fail'` fails the test on the verdict, and a
   * deploy would then stop because nobody signed out of Atlas this week.
   * Grading it `'pass'` fails on the verdict too — the age would be reported
   * as fine while being outside the window.
   */
  it('warns, never fails, when the last accepted event is outside the window', () => {
    const rows = atlasReceiverChecks(
      live({ lastVerifiedAt: ago(ATLAS_RECEIVER_MAX_AGE_DAYS + 2) }),
      NOW,
    );
    expect(rows.map((r) => [r.name, r.verdict])).toEqual([['atlas.receiver.age', 'warn']]);
    expect(rows[0]?.detail).toContain('not a failure');
    expect(rows[0]?.fix).toContain('verify-events-secret');
  });

  /*
   * CONTROL: returning a `pass` row inside the window makes this fail on
   * length. The server's `atlas.receiver` row already prints the
   * last-accepted instant, so a row here saying the same thing is the noise
   * that teaches people to skim the report.
   */
  it('prints NOTHING when the last accepted event is inside the window', () => {
    expect(atlasReceiverChecks(live({ lastVerifiedAt: ago(1) }), NOW)).toEqual([]);
  });

  /*
   * CONTROL: dropping the `rejected > verified` arm makes this fail on
   * length, stacking an age warning under the server's own `fail` about the
   * same receiver — two lines about one broken thing, and the second one
   * would send the reader to the age rather than to the rejection.
   */
  it('says nothing when the last delivery was REFUSED — the server graded that', () => {
    expect(
      atlasReceiverChecks(live({ lastVerifiedAt: ago(30), lastRejectedAt: ago(0.01) }), NOW),
    ).toEqual([]);
  });

  /*
   * CONTROL: dropping the `verified === null` arm makes this report an age of
   * `NaN` day(s) — the server grades "no Atlas event has reached this
   * workspace" as `ok: null`, which doctor prints as SKIP with the reason.
   */
  it('says nothing when nothing has ever verified', () => {
    expect(atlasReceiverChecks(live({ lastVerifiedAt: null }), NOW)).toEqual([]);
  });

  /* CONTROL: dropping the `connected`/`configured` gate makes both of these
   * fail on length. Every workspace that does not use Atlas identity would
   * otherwise carry a row about a receiver it does not have. */
  it('says nothing about a workspace with no Atlas receiver', () => {
    expect(atlasReceiverChecks(live({ connected: false, configured: false }), NOW)).toEqual([]);
    expect(
      atlasReceiverChecks(live({ connected: true, configured: false, lastVerifiedAt: ago(30) }), NOW),
    ).toEqual([]);
  });

  /*
   * CONTROL: returning `[]` instead of the skip row makes this fail on
   * length, and a `'pass'` here is the whole class of defect CH-05 named: a
   * fact that was never read, counted among the ones that passed.
   */
  it('SKIPS, never passes, when the deployment publishes no numbers', () => {
    const rows = atlasReceiverChecks(body(undefined), NOW);
    expect(rows.map((r) => r.verdict)).toEqual(['skip']);
    expect(rows[0]?.detail).toContain('UNCHECKED');
  });
});

describe('atlasReceiverFacts', () => {
  /*
   * The field names are CH-25's, read from the wire shape in
   * `integration-health-checks.ts`. An earlier draft of this reader guessed
   * `lastRejectReason` and `rejected24h`, which do not exist — it no longer
   * reads either, because nothing here grades them.
   *
   * CONTROL: renaming the key read for `lastVerifiedAt` fails this test, and
   * in `atlasReceiverChecks` it would make every receiver read as "nothing
   * has ever verified" and silently print no age row at all.
   */
  it('reads the four fields it grades, by their published names', () => {
    expect(
      atlasReceiverFacts({
        atlasReceiver: {
          configured: true,
          connected: true,
          lastReceivedAt: '2026-11-11T19:00:00.000Z',
          lastVerifiedAt: '2026-11-11T19:53:00.000Z',
          lastRejectedAt: null,
          lastRejectedReason: null,
          rejectedCount24h: 0,
        },
      }),
    ).toEqual({
      configured: true,
      connected: true,
      lastVerifiedAt: '2026-11-11T19:53:00.000Z',
      lastRejectedAt: null,
    });
  });

  /*
   * CONTROL: returning `{}` rather than `null` for a body with no receiver
   * makes this fail, and `atlasReceiverChecks` would then grade an ABSENCE of
   * numbers as a configured-but-quiet receiver — silence where a SKIP belongs.
   */
  it('answers null when the body carries no receiver object', () => {
    expect(atlasReceiverFacts({ checks: [] })).toBeNull();
    expect(atlasReceiverFacts(null)).toBeNull();
    expect(atlasReceiverFacts({ atlasReceiver: [] })).toBeNull();
  });

  /*
   * CONTROL: dropping the finite guard in `at()` makes `Date.parse` hand back
   * NaN, every comparison against it reads false, and the age row silently
   * disappears for that workspace. This test fails on the verdict.
   */
  it('treats an unparseable timestamp as no timestamp', () => {
    expect(atlasReceiverChecks(live({ lastVerifiedAt: 'never' }), NOW)).toEqual([]);
  });
});

/**
 * The WIRING, which is the part a unit test of the grader cannot see.
 *
 * `doctor` reads `GET /v1/integration-health` ONCE and hands the same body to
 * two consumers: `healthChecks`, which wants `.checks`, and the age row,
 * which wants `.atlasReceiver`. Changing that dep from "the checks array" to
 * "the whole body" is the sort of edit that silently drops every
 * server-computed verdict — which is CH-05's defect exactly, arriving a
 * second time — so it is pinned here rather than trusted.
 */
describe('doctor wiring', () => {
  const clientFor = (health: unknown, paths: string[]): ChatlyClient =>
    ({
      channels: { list: async () => [] },
      request: vi.fn(async (_method: string, path: string) => {
        paths.push(path);
        if (path === '/v1/integration-health') {
          return health;
        }
        if (path === '/v1/workspace/readiness') {
          return { checks: [] };
        }
        throw new Error(`unexpected ${path}`);
      }),
    }) as unknown as ChatlyClient;

  const rowsFrom = async (health: unknown): Promise<{ out: string; paths: string[] }> => {
    const paths: string[] = [];
    const chunks: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
      chunks.push(String(c));
      return true;
    });
    try {
      await doctor(clientFor(health, paths), parseArgs(['doctor']));
    } finally {
      write.mockRestore();
    }
    return { out: chunks.join(''), paths };
  };

  /*
   * CONTROL: changing the `health` dep back to reading `res.checks` off a
   * `{ checks }`-only request (so the body it now receives has no `checks` to
   * find) makes this fail on `kb.sync` — every server-computed verdict gone,
   * silently, which is the whole of CH-05.
   */
  it('feeds BOTH consumers from one read of integration-health', async () => {
    const { out, paths } = await rowsFrom({
      checks: [{ id: 'kb.sync', ok: false, detail: 'two sources are dead', fix: 'reconnect' }],
      generatedAt: NOW.toISOString(),
      atlasReceiver: {
        configured: true,
        connected: true,
        lastReceivedAt: null,
        lastVerifiedAt: ago(ATLAS_RECEIVER_MAX_AGE_DAYS + 3),
        lastRejectedAt: null,
        lastRejectedReason: null,
        rejectedCount24h: 0,
      },
    });
    expect(out).toContain('kb.sync');
    expect(out).toContain('atlas.receiver.age');
    // ONE request, not two: the second consumer must not re-fetch.
    expect(paths.filter((p) => p === '/v1/integration-health')).toHaveLength(1);
  });

  /*
   * CONTROL: dropping the `try`/`catch` around the age row makes this reject
   * instead of returning a code — a failed health read would crash `doctor`
   * rather than reporting a SKIP, which is worse than the defect it replaced.
   */
  it('survives a health read that fails, with the SKIP healthChecks already prints', async () => {
    const paths: string[] = [];
    const chunks: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
      chunks.push(String(c));
      return true;
    });
    const chatly = {
      channels: { list: async () => [] },
      request: async (_m: string, path: string) => {
        paths.push(path);
        if (path === '/v1/integration-health') {
          throw new Error('403 missing workspace:read');
        }
        return { checks: [] };
      },
    } as unknown as ChatlyClient;
    try {
      await expect(doctor(chatly, parseArgs(['doctor']))).resolves.toBeTypeOf('number');
    } finally {
      write.mockRestore();
    }
    expect(chunks.join('')).toContain('integration-health');
  });
});
