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

function server(rows: Row[], seen: Seen[], opts: { ignorePatch?: boolean } = {}) {
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
  const go = (args: string[], rows: Row[], seen: Seen[] = [], o = {}) =>
    run([...args, '--key', 'ck_t'], server(rows, seen, o));
  const writes = (seen: Seen[]) => seen.filter((s) => s.method !== 'GET');

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
