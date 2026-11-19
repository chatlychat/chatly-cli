/**
 * `chatly sources list | get | sync | update | delete`, on the wire.
 *
 * Real `run()`, real client, real transport, only `fetch` faked — and every
 * assertion is on what went UP, because the thing worth knowing about this
 * group is WHICH ROUTE it chose. A fake that answers any path with a plausible
 * row agrees with a command that sent the wrong one.
 *
 * ── Why the route matters more than the output ────────────────────────────
 *
 * A knowledge source lives in `docs_sources` or `kb_ingest_sources`, and the
 * two are served by different route families. `GET /v1/docs-sources` lists the
 * first only, so a workspace whose one source is a provisioned CRAWL saw
 * nothing — the defect CH1 reported. These tests pin that `list` asks for the
 * merged list, and that each write lands on the family that owns the id.
 */
import { ChatlyClient } from '@chatlychat/sdk-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { run } from '../run.js';

interface Sent {
  method: string;
  path: string;
  search: string;
}

/** Answers in order; the last one repeats, so a dispatch's GET+write both land. */
function factoryFor(answers: ReadonlyArray<unknown>, sent: Sent[]) {
  let i = 0;
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    sent.push({ method: init?.method ?? 'GET', path: u.pathname, search: u.search });
    const body = answers[Math.min(i, answers.length - 1)] ?? {};
    i += 1;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return (opts: { apiKey: string; apiUrl?: string }) =>
    new ChatlyClient({ ...opts, fetchFn, sleepFn: async () => undefined, retry: { attempts: 1 } });
}

const CRAWL = { id: 's_1', kind: 'website', label: 'Docs crawl', syncStatus: 'synced' };
const PROVIDER = { id: 's_2', kind: 'docs_provider', label: 'Forumulate', syncStatus: 'synced' };

describe('chatly sources', () => {
  let out: string[];
  let err: string[];
  beforeEach(() => {
    out = [];
    err = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /*
   * The defect itself. `?include=all` is what merges the documentation
   * providers into the crawl list; without it the route answers crawls only
   * and sets an `x-chatly-list-hint` header no CLI reads.
   */
  it('list asks the MERGED knowledge-source list, with include=all', async () => {
    const sent: Sent[] = [];
    const code = await run(['sources', 'list', '--key', 'ck_t'], factoryFor([[CRAWL]], sent));
    expect(code).toBe(0);
    expect(sent[0]).toMatchObject({ method: 'GET', path: '/v1/kb-ingest/sources' });
    expect(sent[0]?.search).toContain('include=all');
    // And the crawl the reporter could not see is on screen, by kind.
    expect(out.join('')).toContain('website');
  });

  it('a bare `chatly sources` is the list, like every other group', async () => {
    const sent: Sent[] = [];
    expect(await run(['sources', '--key', 'ck_t'], factoryFor([[CRAWL]], sent))).toBe(0);
    expect(sent[0]?.path).toBe('/v1/kb-ingest/sources');
  });

  /*
   * The by-id read goes to kb-ingest and NOT to `/v1/docs-sources/{id}`,
   * because that one 404s a crawl: the kb-ingest route is the only one that
   * resolves both kinds.
   */
  it('get reads the one route that resolves either kind', async () => {
    const sent: Sent[] = [];
    await run(['sources', 'get', 's_1', '--key', 'ck_t'], factoryFor([CRAWL], sent));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: 'GET', path: '/v1/kb-ingest/sources/s_1' });
    expect(JSON.parse(out.join(''))).toEqual(CRAWL);
  });

  it('sync sends a CRAWL to the ingest route', async () => {
    const sent: Sent[] = [];
    const code = await run(
      ['sources', 'sync', 's_1', '--key', 'ck_t'],
      factoryFor([CRAWL, { queued: true }], sent),
    );
    expect(code).toBe(0);
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual([
      'GET /v1/kb-ingest/sources/s_1',
      'POST /v1/kb-ingest/sources/s_1/ingest',
    ]);
  });

  it('sync sends a PROVIDER to the docs-sources route, and --full with it', async () => {
    const sent: Sent[] = [];
    await run(
      ['sources', 'sync', 's_2', '--full', '--key', 'ck_t'],
      factoryFor([PROVIDER, { queued: true, full: true }], sent),
    );
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual([
      'GET /v1/kb-ingest/sources/s_2',
      'POST /v1/docs-sources/s_2/sync',
    ]);
  });

  /*
   * `--full` has no meaning for a crawl — there is no incremental watermark
   * to drop — so it is said out loud rather than accepted and ignored, which
   * is the "honoured nowhere" shape this repo keeps finding.
   */
  it('says so when --full is passed for a crawl, instead of silently dropping it', async () => {
    const sent: Sent[] = [];
    await run(
      ['sources', 'sync', 's_1', '--full', '--key', 'ck_t'],
      factoryFor([CRAWL, { queued: true }], sent),
    );
    expect(err.join('')).toMatch(/--full is a documentation-provider setting/);
    expect(sent[1]?.path).toBe('/v1/kb-ingest/sources/s_1/ingest');
  });

  it('update PATCHes the docs-sources route for a provider', async () => {
    const sent: Sent[] = [];
    const code = await run(
      ['sources', 'update', 's_2', '--body', '{"label":"Guides"}', '--key', 'ck_t'],
      factoryFor([PROVIDER, PROVIDER], sent),
    );
    expect(code).toBe(0);
    expect(sent[1]).toMatchObject({ method: 'PATCH', path: '/v1/docs-sources/s_2' });
  });

  it('delete DELETEs the docs-sources route and forwards --articles', async () => {
    const sent: Sent[] = [];
    await run(
      ['sources', 'delete', 's_2', '--articles', 'archive', '--key', 'ck_t'],
      factoryFor([PROVIDER, { kept: 0, archived: 3, deleted: 0 }], sent),
    );
    expect(sent[1]).toMatchObject({ method: 'DELETE', path: '/v1/docs-sources/s_2' });
    expect(sent[1]?.search).toContain('articles=archive');
  });

  /*
   * Both routes opened to keys on 2026-11-19, so these two now DISPATCH on
   * `kind` instead of refusing. The assertion is on the route the write went
   * to, not on a canned response: a fixture that echoes agrees with a write
   * sent to the wrong table, which is this repo's house failure mode.
   */
  it('patches a crawl through the kb-ingest route', async () => {
    const sent: Sent[] = [];
    const code = await run(
      ['sources', 'update', 's_1', '--body', '{"label":"x"}', '--key', 'ck_t'],
      factoryFor([CRAWL, { id: 's_1', label: 'x' }], sent),
    );
    expect(code).toBe(0);
    // Control: make `writeRoute` always return the docs-sources path and this
    // reads `/v1/docs-sources/s_1`.
    expect(sent[1]).toMatchObject({ method: 'PATCH', path: '/v1/kb-ingest/sources/s_1' });
  });

  it('deletes a crawl through the kb-ingest route', async () => {
    const sent: Sent[] = [];
    const code = await run(
      ['sources', 'delete', 's_1', '--key', 'ck_t'],
      factoryFor([CRAWL, { deleted: true }], sent),
    );
    expect(code).toBe(0);
    expect(sent[1]).toMatchObject({ method: 'DELETE', path: '/v1/kb-ingest/sources/s_1' });
    // No `?articles` on this route — it keeps its articles unconditionally.
    expect(sent[1]?.search ?? '').not.toContain('articles');
  });

  it('refuses --articles on a crawl rather than dropping it', async () => {
    /*
     * The route has no such option, so sending it would be accepted and
     * ignored — and the caller would believe they had archived the articles.
     */
    const sent: Sent[] = [];
    const code = await run(
      ['sources', 'delete', 's_1', '--articles', 'delete', '--key', 'ck_t'],
      factoryFor([CRAWL], sent),
    );
    expect(code).toBe(2);
    expect(err.join('')).toContain('always keeps its');
    expect(sent.map((x) => x.method)).toEqual(['GET']);
  });

  it('refuses to guess the id, before any request', async () => {
    const sent: Sent[] = [];
    await expect(run(['sources', 'get', '--key', 'ck_t'], factoryFor([], sent))).rejects.toThrow(
      /a source id/,
    );
    expect(sent).toHaveLength(0);
  });

  it('exits 2 with the usage on an unknown subcommand', async () => {
    const sent: Sent[] = [];
    expect(await run(['sources', 'nonsense', '--key', 'ck_t'], factoryFor([], sent))).toBe(2);
    expect(err.join('')).toContain('Unknown: sources nonsense');
    expect(sent).toHaveLength(0);
  });

  it('is reachable by its singular alias', async () => {
    const sent: Sent[] = [];
    expect(await run(['source', 'list', '--key', 'ck_t'], factoryFor([[PROVIDER]], sent))).toBe(0);
    expect(sent[0]?.path).toBe('/v1/kb-ingest/sources');
  });
});
