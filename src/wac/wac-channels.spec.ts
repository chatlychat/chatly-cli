/**
 * `channels` in `chatly plan` / `chatly apply`, matched on the user-chosen
 * `key` (migration 0680). A stateful fake of `/v1/channels` that behaves like
 * the real route where it matters: credentials read back as `__redacted__`,
 * `config` PATCH merges, `publicId` is minted when absent. Assertions are on
 * what was SENT.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatlyClient } from '@chatlychat/sdk-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { run } from '../run.js';

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown> | undefined;
}
type Row = Record<string, unknown> & { id: string; config: Record<string, unknown> };

const redact = (config: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(config).map(([k, v]) => [
      k,
      typeof v === 'object' && v !== null
        ? redact(v as Record<string, unknown>)
        : /secret/i.test(k)
          ? '__redacted__'
          : v,
    ]),
  );
const merge = (a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    out[k] =
      typeof v === 'object' && v !== null && typeof cur === 'object' && cur !== null
        ? merge(cur as Record<string, unknown>, v as Record<string, unknown>)
        : v;
  }
  return out;
};

function server(
  rows: Row[],
  seen: Seen[],
  opts: { ignorePatch?: boolean; failPatch?: boolean } = {},
) {
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = new URL(String(url)).pathname;
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    seen.push({ method, path, body });
    const json = (status: number, b: unknown): Response =>
      new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (method === 'GET' && path === '/v1/channels') {
      return json(
        200,
        rows.map((r) => ({ ...r, config: redact(r.config) })),
      );
    }
    if (method === 'POST' && path === '/v1/channels' && body !== undefined) {
      const row = {
        publicId: 'ch_web_minted',
        enabled: true,
        ...body,
        id: `c${String(rows.length + 1)}`,
        config: (body['config'] ?? {}) as Record<string, unknown>,
      } as Row;
      rows.push(row);
      return json(201, { ...row, config: redact(row.config) });
    }
    const m = /^\/v1\/channels\/([^/]+)$/.exec(path);
    const row = rows.find((r) => r.id === m?.[1]);
    if (method === 'PATCH' && row !== undefined && body !== undefined) {
      if (opts.failPatch === true) {
        return json(400, { code: 'validation_failed', message: 'nope' });
      }
      if (opts.ignorePatch !== true) {
        const { config, ...rest } = body;
        Object.assign(row, rest);
        if (config !== undefined) {
          row.config = merge(row.config, config as Record<string, unknown>);
        }
      }
      return json(200, { ...row, config: redact(row.config) });
    }
    return json(500, { code: 'unexpected', message: `${method} ${path}` });
  }) as unknown as typeof fetch;
  return (o: { apiKey: string; apiUrl?: string }): ChatlyClient =>
    new ChatlyClient({ ...o, fetchFn, sleepFn: async () => undefined, retry: { attempts: 1 } });
}

const LIVE_ROW = (): Row => ({
  id: 'c1',
  key: 'site',
  type: 'web',
  name: 'Site',
  publicId: 'ch_web_old',
  enabled: true,
  config: { displayName: 'Acme', identityVerification: { secret: 'live-secret' } },
});

// Module scope, not inside the first `describe`: the second one
// ('a failed write is not reported as verified') uses both, and a helper
// defined inside a sibling describe is invisible to it — 9 x TS2304 and
// 5 failing tests, which is what this file shipped with. They close over
// nothing block-local; `run`, `server`, `Row` and `Seen` are all module scope.
const go = (args: string[], rows: Row[], seen: Seen[] = [], o = {}) =>
  run([...args, '--key', 'ck_t'], server(rows, seen, o));
const writes = (seen: Seen[]) => seen.filter((s) => s.method !== 'GET');

describe('channels in a workspace document', () => {
  let out: string[];
  let dir: string;
  beforeEach(() => {
    out = [];
    dir = mkdtempSync(join(tmpdir(), 'chatly-wac-ch-'));
    process.env['IDV_SECRET'] = 'doc-secret';
    vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['IDV_SECRET'];
  });

  const doc = (channels: unknown[]): string => {
    const p = join(dir, 'chatly.json');
    writeFileSync(p, JSON.stringify({ version: 1, resources: { channels } }));
    return p;
  };
  const SITE = {
    key: 'site',
    type: 'web',
    name: 'Site',
    config: { displayName: 'Acme', identityVerification: { secret: '${env:IDV_SECRET}' } },
  };

  it('creates when absent, sends no publicId, prints the minted one, and reads back clean', async () => {
    const rows: Row[] = [];
    const seen: Seen[] = [];
    expect(await go(['apply', '--file', doc([SITE])], rows, seen)).toBe(0);
    const post = seen.find((s) => s.method === 'POST');
    expect(post?.body).toMatchObject({ key: 'site', type: 'web', name: 'Site' });
    expect(post?.body).not.toHaveProperty('publicId');
    expect(post?.body?.['config']).toMatchObject({
      identityVerification: { secret: 'doc-secret' },
    });
    expect(out.join('')).toContain('channels/site: publicId ch_web_minted');
    expect(out.join('')).toContain('Read back: everything matches');
  });

  it('is unchanged when only the redacted secret differs from the document', async () => {
    const seen: Seen[] = [];
    expect(await go(['plan', '--file', doc([SITE]), '--exit-code'], [LIVE_ROW()], seen)).toBe(0);
    expect(writes(seen)).toEqual([]);
  });

  it('updates a changed field, shows config drift beside a secret, and never re-sends the secret', async () => {
    const rows = [LIVE_ROW()];
    const seen: Seen[] = [];
    const changed = {
      ...SITE,
      name: 'Main site',
      config: { ...SITE.config, displayName: 'Acme 2' },
    };
    expect(await go(['apply', '--file', doc([changed])], rows, seen)).toBe(0);
    const patch = writes(seen);
    expect(patch).toHaveLength(1);
    expect(patch[0]?.path).toBe('/v1/channels/c1');
    expect(patch[0]?.body).toEqual({
      name: 'Main site',
      config: { displayName: 'Acme 2', identityVerification: {} },
    });
    expect(rows[0]?.config).toMatchObject({ identityVerification: { secret: 'live-secret' } });
  });

  it('re-sends the secret only under --write-only', async () => {
    const rows = [LIVE_ROW()];
    const seen: Seen[] = [];
    expect(await go(['apply', '--write-only', '--file', doc([SITE])], rows, seen)).toBe(0);
    expect(writes(seen)[0]?.body).toEqual({
      config: SITE.config && {
        displayName: 'Acme',
        identityVerification: { secret: 'doc-secret' },
      },
    });
    expect(rows[0]?.config).toMatchObject({ identityVerification: { secret: 'doc-secret' } });
  });

  it('adopts an existing channel with set-key', async () => {
    const seen: Seen[] = [];
    const rows = [{ ...LIVE_ROW(), key: null }];
    expect(await go(['channels', 'set-key', 'c1', 'site'], rows, seen)).toBe(0);
    expect(seen[0]).toMatchObject({
      method: 'PATCH',
      path: '/v1/channels/c1',
      body: { key: 'site' },
    });
    expect(rows[0]?.key).toBe('site');
  });

  it('warns about an unkeyed channel and names set-key', async () => {
    await go(['plan', '--file', doc([SITE])], [{ ...LIVE_ROW(), key: null }]);
    expect(out.join('')).toContain('chatly channels set-key <id> <key>');
  });

  it('refuses --prune: a keyed channel absent from the document is kept and never DELETEd', async () => {
    const seen: Seen[] = [];
    const rows = [LIVE_ROW(), { ...LIVE_ROW(), id: 'c2', key: 'other', publicId: 'ch_web_2' }];
    await go(['apply', '--prune', '--file', doc([SITE])], rows, seen);
    expect(seen.some((s) => s.method === 'DELETE')).toBe(false);
    expect(out.join('')).toContain('cannot be deleted with an API key');
  });

  it('exits 1 when the server answers 200 and stores nothing (read-back mismatch)', async () => {
    const code = await go(
      ['apply', '--file', doc([{ ...SITE, name: 'Renamed' }])],
      [LIVE_ROW()],
      [],
      {
        ignorePatch: true,
      },
    );
    expect(code).toBe(1);
    expect(out.join('')).toContain('still differ from the document');
  });

  it('control: a changed type is blocked and nothing is written', async () => {
    const seen: Seen[] = [];
    expect(
      await go(['apply', '--file', doc([{ ...SITE, type: 'email' }])], [LIVE_ROW()], seen),
    ).toBe(1);
    expect(writes(seen)).toEqual([]);
    expect(out.join('')).toContain('`type` is fixed at create');
  });

  it('control: publicId as an input and a malformed key are refused at parse time', async () => {
    await expect(go(['plan', '--file', doc([{ ...SITE, publicId: 'web' }])], [])).rejects.toThrow(
      /publicId/,
    );
    await expect(go(['plan', '--file', doc([{ ...SITE, key: 'Bad_Key' }])], [])).rejects.toThrow(
      /must match/,
    );
  });
});

/*
 * ForgeDeck's SEVENTH report, 2026-11-06 item 2, reproduced twice: `apply`
 * printed `Failed (1) — nothing was written for these` and then `Read back:
 * everything matches the document.`, which cannot both be true.
 *
 * Why the read-back agrees with the failure: it re-plans WITHOUT
 * `--write-only` on purpose (anything else reports every opaque field as a
 * change for ever), so a credential that failed to be written is not compared
 * at all and the plan comes back clean. The exit code was already 1 — only the
 * sentence lied, which is the kind of defect a green suite keeps.
 */
describe('a failed write is not reported as verified', () => {
  let out: string[];
  let dir: string;
  beforeEach(() => {
    out = [];
    dir = mkdtempSync(join(tmpdir(), 'chatly-wac-fail-'));
    // Three cases here resolve `${env:IDV_SECRET}`, and the block that
    // exports it is the SIBLING describe — so without this they failed on a
    // refusal about an unset variable, which is correct behaviour for a
    // document nobody exported the variable for and says nothing about the
    // secret handling they exist to test. Same scope mistake as `go` and
    // `writes`, in the setup rather than the helpers.
    process.env['IDV_SECRET'] = 'doc-secret';
    vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['IDV_SECRET'];
  });

  const secretDoc = (): string => {
    const p = join(dir, 'chatly.json');
    writeFileSync(
      p,
      JSON.stringify({
        version: 1,
        resources: {
          channels: [
            {
              key: 'site',
              type: 'web',
              name: 'Site',
              config: { displayName: 'Acme', identityVerification: { secret: 'rotated' } },
            },
          ],
        },
      }),
    );
    return p;
  };

  /*
   * The seventh report's fix, corrected by the eighth. This run's ONLY row
   * fails, so nothing is written — and the sentence added in round seven,
   * "the rows that were written match the document", was then itself a claim
   * about rows that do not exist (eighth report, item 1). Three outcomes, not
   * two: everything matched, some rows written and some failed, or nothing
   * written at all.
   */
  it('says nothing was written when every row failed', async () => {
    const seen: Seen[] = [];
    const code = await run(
      ['apply', '--file', secretDoc(), '--write-only', '--key', 'ck_t'],
      server([LIVE_ROW()], seen, { failPatch: true }),
    );
    const text = out.join('');
    expect(code).toBe(1);
    expect(text).toContain('nothing was written for these');
    expect(text).not.toContain('Read back: everything matches');
    // Neither of the two wrong sentences: not the all-clear, and not a claim
    // about written rows on a run that wrote none.
    expect(text).not.toContain('the rows that were written');
    expect(text).toContain('nothing was written, so there is nothing to confirm');
  });

  it('still says everything matches when nothing failed', async () => {
    const seen: Seen[] = [];
    const code = await run(
      ['apply', '--file', secretDoc(), '--write-only', '--key', 'ck_t'],
      server([LIVE_ROW()], seen),
    );
    expect(code).toBe(0);
    expect(out.join('')).toContain('Read back: everything matches');
  });

  it('reports verified: false in --json on a failed run', async () => {
    const seen: Seen[] = [];
    await run(
      ['apply', '--file', secretDoc(), '--write-only', '--json', '--key', 'ck_t'],
      server([LIVE_ROW()], seen, { failPatch: true }),
    );
    const parsed = JSON.parse(out.join('')) as { verified: boolean; mismatches: unknown[] };
    // `mismatches` is empty — the failed field is write-only and unreadable —
    // so `verified` is the only thing a script could have gone on.
    expect(parsed.mismatches).toEqual([]);
    expect(parsed.verified).toBe(false);
  });
  /* ══ The Atlas events secret: write-only, named, and rotatable (CH-26) ═══
   *
   * FormFlow's report: `chatly.yaml` "cannot declare
   * identityVerification.eventsSecret, even as a reference to an env value",
   * and `plan` "shows unchanged whatever the secret is". The first half was
   * true only of the form they wrote (`${NAME}` rather than `${env:NAME}`,
   * which was stored LITERALLY); the second was true and is what these pin.
   *
   * CONTROL for each is in its comment.
   */
  const eventsDoc = (value: string): string => {
    const p = join(dir, 'chatly.json');
    writeFileSync(
      p,
      JSON.stringify({
        version: 1,
        resources: {
          channels: [
            {
              key: 'site',
              type: 'web',
              name: 'Site',
              config: { identityVerification: { eventsSecret: value } },
            },
          ],
        },
      }),
    );
    return p;
  };
  const EVENTS_ROW = (): Row => ({
    ...LIVE_ROW(),
    config: { displayName: 'Acme', identityVerification: { eventsSecret: 'whatever-is-stored' } },
  });

  /*
   * CONTROL: reverting `plan-row.ts` to the old wording ("config holds
   * redacted credentials") fails this on the leaf name — which is the whole
   * of the reported defect: the operator could not tell whether the field
   * they had just written was the one being skipped, or set at all.
   */
  it('plan NAMES the write-only leaf and says it is set, instead of just "unchanged"', async () => {
    const seen: Seen[] = [];
    expect(await go(['plan', '--file', eventsDoc('${env:IDV_SECRET}')], [EVENTS_ROW()], seen)).toBe(
      0,
    );
    const printed = out.join('');
    expect(printed).toContain('identityVerification.eventsSecret is SET on the server');
    expect(printed).toContain('--rotate-secret');
    // Still not diffed, so still no write. That part was always right.
    expect(writes(seen)).toEqual([]);
  });

  /*
   * CONTROL: dropping the `opts.rotateSecrets` arm from `plan-row.ts` makes
   * this fail with no PATCH at all — the rotation silently doing nothing,
   * which is worse than refusing.
   */
  it('--rotate-secret writes the secret the document holds', async () => {
    const rows = [EVENTS_ROW()];
    const seen: Seen[] = [];
    expect(
      await go(['apply', '--rotate-secret', '--file', eventsDoc('${env:IDV_SECRET}')], rows, seen),
    ).toBe(0);
    expect(writes(seen)).toHaveLength(1);
    expect(writes(seen)[0]?.body).toEqual({
      config: { identityVerification: { eventsSecret: 'doc-secret' } },
    });
    expect(rows[0]?.config).toMatchObject({
      identityVerification: { eventsSecret: 'doc-secret' },
    });
  });

  /*
   * A plan artifact must not hold the credential (CH-26), whether or not it
   * came from the environment.
   *
   * CONTROL: dropping `secret: true` from the change in `plan-row.ts` leaves
   * the `${env:…}` case passing — `fromEnv` masks it — and fails the INLINE
   * case below, which is the half nothing covered: an author who pasted the
   * secret into the file got no masking at all.
   */
  it('never prints the secret, inline or from the environment', async () => {
    for (const value of ['${env:IDV_SECRET}', 'pasted-into-the-file']) {
      out.length = 0;
      expect(await go(['plan', '--rotate-secret', '--file', eventsDoc(value)], [EVENTS_ROW()])).toBe(
        0,
      );
      expect(out.join('')).not.toContain('doc-secret');
      expect(out.join('')).not.toContain('pasted-into-the-file');
      expect(out.join('')).toContain('write-only secret, not shown');
    }
  });

  it('never writes the secret into --json either', async () => {
    expect(
      await go(['plan', '--rotate-secret', '--json', '--file', eventsDoc('pasted-into-the-file')], [
        EVENTS_ROW(),
      ]),
    ).toBe(0);
    expect(out.join('')).not.toContain('pasted-into-the-file');
  });

  /*
   * The customer's first complaint, and the real cause of the 401s: written
   * without `env:`, the literal placeholder text was STORED as the signing
   * secret — 29 characters, past `min(16)`, redacted on read, and reported as
   * unchanged for ever.
   *
   * CONTROL: deleting `MISTAKEN_ENV_REF` from `document.ts` makes this exit 0
   * and PATCH the literal `${IDV_SECRET}` onto the channel, which is the bug.
   */
  it('refuses ${NAME} written without the env: prefix, rather than storing it', async () => {
    const seen: Seen[] = [];
    // A document problem THROWS (`main.ts` turns it into exit 1 and the
    // message on stderr), the same shape as the two refusals above.
    await expect(
      go(['apply', '--file', eventsDoc('${IDV_SECRET}')], [EVENTS_ROW()], seen),
    ).rejects.toThrow(/\$\{env:IDV_SECRET\}/);
    expect(writes(seen)).toEqual([]);
  });
});
