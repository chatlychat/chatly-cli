/**
 * The verdicts `chatly doctor` READS rather than computes: the workspace-wide
 * ones from `GET /v1/integration-health`, the per-channel ones from
 * `GET /v1/channels/{id}/identity-contract`, the summary line that counts
 * them, and what happens when the credential can see no web channel.
 *
 * ═══ THE DEFECT THIS FILE EXISTS FOR (CH-05) ══════════════════════════════
 *
 * FormFlow's deploy gate printed `12 check(s): 12 ok` against a workspace
 * where `kb.sync` and `kb.semantic_index` were both `ok: false`. `doctor`
 * asked for `/v1/integration-health` only when a channel verified visitors,
 * and then read ONE of its eight checks. Every assertion here is about a
 * verdict reaching the operator, or about a verdict that could not be made
 * reporting as SKIP rather than joining the "ok" count.
 *
 * Split from `doctor.spec.ts`, which keeps the browser-shaped probes; they
 * share `__tests__/doctor-fixtures.ts` so there is one definition of a
 * healthy world.
 */
import { describe, expect, it } from 'vitest';

import {
  HEALTHY,
  channelRow,
  check,
  depsFor,
  pick,
  stubFetch,
  type Sent,
} from './__tests__/doctor-fixtures.js';
import { exitCodeFor, runChecks, selectChannels, type DoctorCheck } from './doctor-checks.js';
import { summaryLine } from './doctor.js';

describe('the checks the server computes (integration-health)', () => {
  const idv = (enabled: boolean): Record<string, unknown> =>
    channelRow({
      config: { allowedOrigins: ['https://example.com'], identityVerification: { enabled } },
    });

  /*
   * CH-05, and the defect this whole block exists for. `doctor` asked for
   * `GET /v1/integration-health` only when a channel verified visitors, and
   * then read ONE of its eight checks. FormFlow's deploy gate printed
   * `12 check(s): 12 ok` over `kb.sync ok=false` and
   * `kb.semantic_index ok=false`, because nothing had asked.
   */
  it('asks for every integration-health check, on a channel with no identity verification', async () => {
    const sent: Sent[] = [];
    const deps = depsFor(stubFetch(HEALTHY, sent), {
      health: async () => [
        {
          id: 'kb.sync',
          ok: false,
          detail: '2 of 3 knowledge source(s) failed',
          fix: 'Reconnect.',
        },
        {
          id: 'kb.semantic_index',
          ok: false,
          detail: '32 published article(s)',
          fix: 'Set a key.',
        },
      ],
    });
    const all = await runChecks(selectChannels([idv(false)], undefined), {}, deps);
    expect(all.map((c) => c.name)).toEqual(
      expect.arrayContaining(['kb.sync', 'kb.semantic_index']),
    );
    expect(pick(all, 'kb.sync').verdict).toBe('fail');
    expect(pick(all, 'kb.semantic_index').verdict).toBe('fail');
    // The acceptance criterion, in one line: a workspace in this state fails.
    expect(exitCodeFor(all)).toBe(1);
  });

  it('warns rather than failing on business hours, which is a supported configuration', async () => {
    const { check: c, all } = await check(
      'business_hours.set',
      [channelRow()],
      HEALTHY,
      {},
      {
        health: async () => [
          {
            id: 'business_hours.set',
            ok: false,
            detail: 'No business hours are set.',
            fix: 'Set them.',
          },
        ],
      },
    );
    expect(c.verdict).toBe('warn');
    // A warning alone must not stop a deploy, or the gate gets switched off.
    expect(exitCodeFor(all)).toBe(0);
  });

  it('reports the server’s own verdict, because the key set is resolved there', async () => {
    /*
     * `resolveOidcIssuers` is the ONE resolution and lives in a PRIVATE
     * package, so this command cannot run it — see `DoctorDeps.health`. The
     * verdict therefore comes from `GET /v1/integration-health`, which does.
     */
    const { check: c } = await check(
      'identity.jwks_reachable',
      [idv(true)],
      HEALTHY,
      {},
      {
        health: async () => [
          { id: 'channel.origins', ok: true, detail: 'not this one', fix: null },
          {
            id: 'identity.jwks_reachable',
            ok: false,
            detail: '1 of 1 key set(s) could not be fetched: dns',
            fix: 'Check the issuer host resolves.',
          },
        ],
      },
    );
    expect(c.verdict).toBe('fail');
    expect(c.detail).toContain('could not be fetched');
    expect(c.fix).toBe('Check the issuer host resolves.');
  });

  it('marks ok:null SKIPPED, carrying the server’s reason, and never ok', async () => {
    const { check: c, all } = await check(
      'identity.jwks_reachable',
      [idv(true)],
      HEALTHY,
      {},
      {
        health: async () => [
          { id: 'identity.jwks_reachable', ok: null, detail: 'not probed yet', fix: null },
        ],
      },
    );
    expect(c.verdict).toBe('skip');
    expect(c.detail).toBe('not probed yet');
    expect(exitCodeFor(all)).toBe(0);
  });

  it('marks an unreadable ok SKIPPED too — an absent verdict is not a pass', async () => {
    const { check: c } = await check(
      'kb.sync',
      [channelRow()],
      HEALTHY,
      {},
      {
        health: async () => [{ id: 'kb.sync', detail: 'who knows', fix: null }],
      },
    );
    expect(c.verdict).toBe('skip');
  });

  it('SKIPS the whole block when integration-health cannot be read, naming what went unchecked', async () => {
    const { check: c, all } = await check(
      'integration-health',
      [idv(true)],
      HEALTHY,
      {},
      {
        health: () => Promise.reject(new Error('Missing permission: workspace:read')),
      },
    );
    expect(c.verdict).toBe('skip');
    expect(c.detail).toContain('UNCHECKED');
    expect(c.fix).toContain('workspace:read');
    expect(exitCodeFor(all)).toBe(0);
  });
});

describe('channel selection and the exit code', () => {
  it('ignores a non-web channel, which has no embed and so no install', async () => {
    expect(selectChannels([{ id: 'ch_2', type: 'whatsapp', embed: null }], undefined)).toEqual([]);
  });

  it('matches --channel on the publicId or the id', () => {
    const rows = [channelRow(), channelRow({ id: 'ch_2', publicId: 'web_live_2' })];
    expect(selectChannels(rows, 'web_live_2').map((c) => c.id)).toEqual(['ch_2']);
    expect(selectChannels(rows, 'ch_1').map((c) => c.id)).toEqual(['ch_1']);
    expect(selectChannels(rows, 'nope')).toEqual([]);
  });

  it('warns, and does not pass, when the credential sees no web channel', async () => {
    const all = await runChecks([], {}, depsFor(stubFetch({}, [])));
    expect(all[0]?.name).toBe('channels');
    expect(all[0]?.verdict).toBe('warn');
    expect(exitCodeFor(all)).toBe(0);
  });

  /*
   * CH-05: it used to return the `channels` warning and STOP. A knowledge
   * base, a semantic index and business hours are workspace-level facts with
   * nothing to do with whether a widget is installed, so a key that cannot
   * see a web channel was getting no verdict on any of them.
   */
  it('still reports the server’s checks when there is no web channel to check', async () => {
    const all = await runChecks(
      [],
      {},
      depsFor(stubFetch({}, []), {
        health: async () => [{ id: 'kb.sync', ok: false, detail: 'two failed', fix: 'Reconnect.' }],
      }),
    );
    expect(all.map((c) => c.name)).toEqual(['channels', 'kb.sync']);
    expect(exitCodeFor(all)).toBe(1);
  });

  it('exits non-zero on a failure and zero on warnings alone', () => {
    const w = { name: 'a', verdict: 'warn', detail: '', fix: null } as const;
    const f = { name: 'b', verdict: 'fail', detail: '', fix: null } as const;
    expect(exitCodeFor([w, w])).toBe(0);
    expect(exitCodeFor([w, f])).toBe(1);
  });
});

describe('the summary line, which is the number people act on', () => {
  const row = (verdict: DoctorCheck['verdict']): DoctorCheck => ({
    name: 'x',
    verdict,
    detail: '',
    fix: null,
  });

  /*
   * The reported defect, exactly. `12 check(s): 12 ok, 0 warning(s), 0
   * failed` was printed over a workspace with two dead knowledge sources,
   * because "ok" was computed as everything that was not a fail or a warn —
   * which includes every check that never ran.
   */
  it('does not count a SKIPPED check as an ok', () => {
    expect(summaryLine([row('pass'), row('skip'), row('skip')])).toBe(
      '3 check(s): 1 ok, 0 warning(s), 2 skipped, 0 failed',
    );
  });

  it('counts each verdict exactly once', () => {
    expect(summaryLine([row('pass'), row('warn'), row('skip'), row('fail')])).toBe(
      '4 check(s): 1 ok, 1 warning(s), 1 skipped, 1 failed',
    );
  });
});

describe('the identity contract (CH-09)', () => {
  const idvOn = (over: Record<string, unknown> = {}): Record<string, unknown> =>
    channelRow({
      config: {
        allowedOrigins: ['https://example.com'],
        identityVerification: { enabled: true, ...over },
      },
    });

  /*
   * The whole reason that route exists. A channel re-created after its token
   * template was written keeps the OLD `aud` in the template, every token is
   * refused, and the visitor stays anonymous — with nothing server-side to
   * see, because a refused token looks like a visitor who never signed in.
   */
  it('FAILS on audience_matches_channel, which is the re-created-channel trap', async () => {
    const { check: c, all } = await check(
      'identity.audience_matches_channel',
      [idvOn()],
      HEALTHY,
      {},
      {
        identityContract: async () => ({
          checks: [
            { id: 'audience_derived', ok: true, detail: 'derived.' },
            {
              id: 'audience_matches_channel',
              ok: false,
              detail:
                'The channel\'s `audience` is ["chatly:web_live_old"] and names no `chatly:web_live_1`.',
            },
          ],
        }),
      },
    );
    expect(c.verdict).toBe('fail');
    expect(c.detail).toContain('web_live_old');
    expect(exitCodeFor(all)).toBe(1);
  });

  /*
   * `audience_derived` is `ok: false` on every channel that writes its issuer
   * and audience by hand, which is supported. Failing on it would make this
   * check unusable for every non-Atlas identity provider, and a check people
   * have to switch off is a check that is off on the day it mattered.
   */
  it('only WARNS on audience_derived, because a hand-written issuer is supported', async () => {
    const { check: c, all } = await check(
      'identity.audience_derived',
      [idvOn()],
      HEALTHY,
      {},
      {
        identityContract: async () => ({
          checks: [{ id: 'audience_derived', ok: false, detail: '`audience` is written by hand.' }],
        }),
      },
    );
    expect(c.verdict).toBe('warn');
    expect(exitCodeFor(all)).toBe(0);
  });

  /*
   * A channel with identity verification OFF resolves no issuer and no
   * audience — correct for it, and two failures if asked. The route is not
   * called at all, which is also what keeps `doctor` to one request per
   * channel that needs one.
   */
  it('does not ask at all for a channel that does not verify visitors', async () => {
    let asked = 0;
    const all = await runChecks(
      selectChannels([channelRow()], undefined),
      {},
      depsFor(stubFetch(HEALTHY, []), {
        identityContract: async () => {
          asked += 1;
          return {};
        },
      }),
    );
    expect(asked).toBe(0);
    expect(all.some((c) => c.name.startsWith('identity.'))).toBe(false);
  });

  it('SKIPS when the contract cannot be read, and never reports it as ok', async () => {
    const { check: c, all } = await check(
      'identity.contract',
      [idvOn()],
      HEALTHY,
      {},
      {
        identityContract: () => Promise.reject(new Error('Missing permission: channels:read')),
      },
    );
    expect(c.verdict).toBe('skip');
    expect(c.fix).toContain('channels:read');
    expect(exitCodeFor(all)).toBe(0);
  });
});
