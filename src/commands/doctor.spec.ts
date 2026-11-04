/**
 * `chatly doctor`, with only the network and the two API reads faked.
 *
 * ═══ WHAT THESE ASSERT ON ═════════════════════════════════════════════════
 *
 * **What the command SENT**, not what a canned response said. A fake
 * transport that answers every probe with a 200 agrees with whatever the code
 * asked it, which is exactly how four mobile SDKs here shipped unable to
 * connect with green suites. The preflight assertions below read the recorded
 * request: the method, the two `access-control-request-*` headers and the
 * `Origin` — because a preflight missing any of them is not the request a
 * browser makes, and a bucket can answer it while refusing the real one.
 *
 * `doctor-checks.ts` has no runtime imports precisely so these drive the
 * shipped judgement rather than a reproduction of it.
 */
import { describe, expect, it } from 'vitest';

import {
  exitCodeFor,
  runChecks,
  selectChannels,
  type DoctorCheck,
  type DoctorDeps,
} from './doctor-checks.js';

const PRESIGNED =
  'https://uploads.chatlychat.com/chatly/workspaces/ws_1/uploads/u_1/x.png?X-Amz-Signature=deadbeef';

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

/** A channel row shaped like `GET /v1/channels` returns one. */
function channelRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  const embed = {
    loaderUrl: 'https://widget.chatlychat.com/loader.js',
    scriptOrigin: 'https://widget.chatlychat.com',
    uploadOrigin: 'https://uploads.chatlychat.com',
    fileOrigin: 'https://files.chatlychat.com',
    deprecatedFileOrigins: [],
    contentSecurityPolicy: {
      scriptSrc: ['https://widget.chatlychat.com', "'sha256-abc'"],
      connectSrc: [
        'https://api.chatlychat.com',
        'https://rt.chatlychat.com',
        'wss://rt.chatlychat.com',
        'https://uploads.chatlychat.com',
      ],
      imgSrc: ['https://files.chatlychat.com', 'data:', 'blob:'],
      mediaSrc: ['https://files.chatlychat.com'],
    },
    ...((over['embed'] as Record<string, unknown>) ?? {}),
  };
  return {
    id: 'ch_1',
    publicId: 'web_live_1',
    type: 'web',
    originsRestricted: true,
    config: { allowedOrigins: ['https://example.com'] },
    ...over,
    embed,
  };
}

/**
 * A `fetch` that records every request and answers from a per-URL table.
 *
 * The default answer is a served JavaScript asset, so a test only states the
 * responses it is about — and a URL mapped to `null` REJECTS, which is what a
 * host that does not resolve does.
 */
function stubFetch(
  table: Record<string, { status: number; headers?: Record<string, string>; body?: string } | null>,
  sent: Sent[],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    sent.push({ url, method: init?.method ?? 'GET', headers });
    const match = Object.entries(table).find(([key]) => url.startsWith(key));
    if (match !== undefined && match[1] === null) {
      throw new TypeError('fetch failed');
    }
    const step = match?.[1] ?? {
      status: 200,
      headers: { 'content-type': 'application/javascript' },
    };
    /*
     * `null` rather than `''` for a 204: the `Response` constructor REFUSES a
     * body on a null-body status, and a 204 is the healthy answer to a CORS
     * preflight — so the obvious `?? ''` makes the stub throw on exactly the
     * case these tests are about.
     */
    const nullBody = step.status === 204 || step.status === 304;
    return new Response(nullBody ? null : (step.body ?? ''), {
      status: step.status,
      headers: step.headers ?? {},
    });
  }) as unknown as typeof fetch;
}

function depsFor(
  fetchFn: typeof fetch,
  over: Partial<DoctorDeps> = {},
): DoctorDeps & { healthCalls: number } {
  const state = { healthCalls: 0 };
  return {
    fetchFn,
    presign: async () => PRESIGNED,
    health: async () => {
      state.healthCalls += 1;
      return [];
    },
    ...over,
    get healthCalls(): number {
      return state.healthCalls;
    },
  };
}

const pick = (checks: readonly DoctorCheck[], prefix: string): DoctorCheck => {
  const found = checks.find((c) => c.name.startsWith(prefix));
  if (found === undefined) {
    throw new Error(`no check named ${prefix} in ${checks.map((c) => c.name).join(', ')}`);
  }
  return found;
};

/** The default world: everything serves, CORS is in effect, origins are set. */
const HEALTHY: Record<
  string,
  { status: number; headers?: Record<string, string>; body?: string } | null
> = {
  [PRESIGNED]: { status: 204, headers: { 'access-control-allow-origin': '*' } },
  'https://widget.chatlychat.com/version.json': {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      assets: {
        'loader.js': {},
        'widget.js': {},
        'widget-engine.js': {},
        'media/hold-music.wav': {},
      },
    }),
  },
  'https://api.chatlychat.com': { status: 404 },
  'https://rt.chatlychat.com': { status: 404 },
  'https://files.chatlychat.com': { status: 404 },
  'https://uploads.chatlychat.com': { status: 400 },
};

async function check(
  prefix: string,
  rows: ReadonlyArray<Record<string, unknown>>,
  table: typeof HEALTHY = HEALTHY,
  opts: { origin?: string } = {},
  over: Partial<DoctorDeps> = {},
): Promise<{ check: DoctorCheck; sent: Sent[]; all: DoctorCheck[] }> {
  const sent: Sent[] = [];
  const all = await runChecks(
    selectChannels(rows, undefined),
    opts,
    depsFor(stubFetch(table, sent), over),
  );
  return { check: pick(all, prefix), sent, all };
}

describe('upload.preflight — the check that earns the command', () => {
  it('sends the preflight a real browser sends, to the real presigned URL', async () => {
    const { check: c, sent } = await check('upload.preflight', [channelRow()], HEALTHY, {
      origin: 'https://app.example.com',
    });
    expect(c.verdict).toBe('pass');

    const pre = sent.find((s) => s.method === 'OPTIONS');
    expect(pre, 'no OPTIONS preflight was sent at all').toBeDefined();
    /*
     * The URL is the presigned one, query and all. R2 answers a preflight per
     * BUCKET (`/{bucket}/{key}`), and a bare-path probe gets a 403 with no
     * CORS headers at all — so a guessed path is a different question.
     */
    expect(pre?.url).toBe(PRESIGNED);
    expect(pre?.headers['access-control-request-method']).toBe('PUT');
    expect(pre?.headers['access-control-request-headers']).toBe('content-type');
    // `--origin` is the site, so the probe asks the question that site asks.
    expect(pre?.headers['origin']).toBe('https://app.example.com');
  });

  it('carries a reserved Origin when the operator named no site', async () => {
    const { sent } = await check('upload.preflight', [channelRow()]);
    const origin = sent.find((s) => s.method === 'OPTIONS')?.headers['origin'];
    expect(origin).toMatch(/^https:\/\/[a-z-]+\.invalid$/);
  });

  it('FAILS when a 2xx carries no access-control-allow-origin — a stored policy that is not honoured', async () => {
    // The 2026-11-04 defect, in the one shape a status code alone cannot see.
    const { check: c } = await check('upload.preflight', [channelRow()], {
      ...HEALTHY,
      [PRESIGNED]: { status: 204 },
    });
    expect(c.verdict).toBe('fail');
    expect(c.detail).toContain('access-control-allow-origin=(absent)');
    expect(c.fix).toContain('apply-bucket-cors');
  });

  it('FAILS on the 403 an unconfigured bucket answers', async () => {
    const { check: c } = await check('upload.preflight', [channelRow()], {
      ...HEALTHY,
      [PRESIGNED]: { status: 403 },
    });
    expect(c.verdict).toBe('fail');
    expect(c.detail).toContain('403');
  });

  it('warns rather than failing when the key cannot presign, and names the scope', async () => {
    const { check: c } = await check('upload.preflight', [channelRow()], HEALTHY, {}, {
      presign: () => Promise.reject(new Error('Missing permission: uploads:create')),
    });
    expect(c.verdict).toBe('warn');
    expect(c.fix).toContain('uploads:create');
  });

  it('warns when the deployment has no object storage at all', async () => {
    const { check: c } = await check('upload.preflight', [channelRow()], HEALTHY, {}, {
      presign: async () => 'data:no-s3-configured;key=x',
    });
    expect(c.verdict).toBe('warn');
    expect(c.detail).toContain('no object storage');
  });
});

describe('upload.host', () => {
  it('warns when uploads do not go to a Chatly host', async () => {
    // Defect 2: an account-specific R2 subdomain in every customer's CSP.
    const { check: c } = await check('upload.host', [
      channelRow({
        embed: { uploadOrigin: 'https://039852fe.r2.cloudflarestorage.com' },
      }),
    ]);
    expect(c.verdict).toBe('warn');
    expect(c.detail).toContain('039852fe.r2.cloudflarestorage.com');
    expect(c.fix).toContain('S3_UPLOAD_PUBLIC_BASE_URL');
  });

  it('passes a chatlychat.com subdomain', async () => {
    const { check: c } = await check('upload.host', [channelRow()]);
    expect(c.verdict).toBe('pass');
  });

  it('does not mistake a lookalike suffix for a Chatly host', async () => {
    const { check: c } = await check('upload.host', [
      channelRow({ embed: { uploadOrigin: 'https://uploads.notchatlychat.com' } }),
    ]);
    expect(c.verdict).toBe('warn');
  });
});

describe('csp.hosts', () => {
  it('FAILS and names the host when one we published does not resolve', async () => {
    const { check: c } = await check('csp.hosts', [channelRow()], {
      ...HEALTHY,
      'https://rt.chatlychat.com': null,
    });
    expect(c.verdict).toBe('fail');
    expect(c.detail).toContain('rt.chatlychat.com');
  });

  it('accepts any HTTP status, because the question is whether the host answers', async () => {
    const { check: c } = await check('csp.hosts', [channelRow()]);
    expect(c.verdict).toBe('pass');
  });

  it('maps a wss source to https rather than dropping it', async () => {
    /*
     * The fixture names the realtime host ONLY as `wss://`, which is the case
     * a scheme-blind reader gets wrong invisibly: `fetch` cannot dial `wss:`,
     * so the natural "skip what is not http(s)" drops the host entirely and
     * reports a pass for a host nobody checked. The published policy usually
     * carries both schemes — a browser matches a WebSocket by scheme — so the
     * https twin would otherwise hide this.
     */
    const { sent } = await check('csp.hosts', [
      channelRow({
        embed: {
          contentSecurityPolicy: {
            scriptSrc: ['https://widget.chatlychat.com'],
            connectSrc: ['wss://rt.chatlychat.com'],
            imgSrc: ['data:', 'blob:'],
            mediaSrc: [],
          },
        },
      }),
    ]);
    const dialled = sent.filter((s) => s.method === 'GET').map((s) => s.url);
    expect(dialled).toContain('https://rt.chatlychat.com');
  });

  it('dials a host named in two directives once, and skips data:/blob:/hashes', async () => {
    const { sent } = await check('csp.hosts', [channelRow()]);
    const dialled = sent.filter((s) => s.method === 'GET').map((s) => s.url);
    expect(dialled.filter((u) => u === 'https://rt.chatlychat.com')).toHaveLength(1);
    expect(dialled.some((u) => u.startsWith('wss:') || u.startsWith('data:'))).toBe(false);
    expect(dialled.some((u) => u.includes('sha256'))).toBe(false);
  });
});

describe('widget.assets', () => {
  it('derives the chunk list from the host’s own version.json', async () => {
    const { check: c, sent } = await check('widget.assets', [channelRow()]);
    expect(c.verdict).toBe('pass');
    const got = sent.map((s) => s.url);
    expect(got).toContain('https://widget.chatlychat.com/widget-engine.js');
    // `.js` only: the manifest also lists media, which is not a script.
    expect(got.some((u) => u.endsWith('hold-music.wav'))).toBe(false);
  });

  it('FAILS on a chunk that 404s — built, referenced, never served', async () => {
    const { check: c } = await check('widget.assets', [channelRow()], {
      ...HEALTHY,
      /*
       * A JavaScript content-type ON the 404, so only the STATUS check can
       * catch this. With `content-type: absent` the content-type assertion
       * catches it too and deleting the status check leaves the suite green —
       * which is what the control run found.
       */
      'https://widget.chatlychat.com/widget-engine.js': {
        status: 404,
        headers: { 'content-type': 'application/javascript' },
      },
    });
    expect(c.verdict).toBe('fail');
    expect(c.detail).toContain('widget-engine.js');
    expect(c.detail).toContain('HTTP 404');
  });

  it('FAILS on a 200 that is not JavaScript — an SPA fallback answering for a missing file', async () => {
    const { check: c } = await check('widget.assets', [channelRow()], {
      ...HEALTHY,
      'https://widget.chatlychat.com/widget.js': {
        status: 200,
        headers: { 'content-type': 'text/html' },
      },
    });
    expect(c.verdict).toBe('fail');
    expect(c.detail).toContain('text/html');
  });

  it('falls back to the two bootstrap assets when there is no manifest', async () => {
    const { check: c, sent } = await check('widget.assets', [channelRow()], {
      ...HEALTHY,
      'https://widget.chatlychat.com/version.json': { status: 404 },
    });
    expect(c.verdict).toBe('pass');
    expect(c.detail).toContain('version.json is absent');
    expect(sent.map((s) => s.url)).toContain('https://widget.chatlychat.com/loader.js');
  });
});

describe('widget.origins', () => {
  it('warns rather than passing when the list is empty, because that admits anyone', async () => {
    const { check: c } = await check('widget.origins', [
      channelRow({ config: { allowedOrigins: [] }, originsRestricted: false }),
    ]);
    expect(c.verdict).toBe('warn');
    expect(c.detail).toContain('ANY origin');
  });

  it('FAILS on --origin that is not allowed, and the fix carries the exact value to add', async () => {
    const { check: c } = await check('widget.origins', [channelRow()], HEALTHY, {
      origin: 'https://their-site.com',
    });
    expect(c.verdict).toBe('fail');
    expect(c.fix).toContain('"https://example.com","https://their-site.com"');
  });

  it('passes --origin that is allowed, comparing by origin rather than by string', async () => {
    /*
     * Both sides are deliberately unequal as strings — the stored value has
     * the trailing slash a browser's own `location.origin` never has, and the
     * flag carries a path. A `list.includes(flag)` reads false for a site
     * that IS allowed, and tells the operator to add an origin that is
     * already there.
     */
    const { check: c } = await check(
      'widget.origins',
      [channelRow({ config: { allowedOrigins: ['https://example.com/'] } })],
      HEALTHY,
      { origin: 'https://example.com/pricing' },
    );
    expect(c.verdict).toBe('pass');
  });
});

describe('identity.jwks', () => {
  const idv = (enabled: boolean): Record<string, unknown> =>
    channelRow({
      config: { allowedOrigins: ['https://example.com'], identityVerification: { enabled } },
    });

  it('is not asked for when no channel verifies visitors', async () => {
    const sent: Sent[] = [];
    const deps = depsFor(stubFetch(HEALTHY, sent));
    const all = await runChecks(selectChannels([idv(false)], undefined), {}, deps);
    expect(all.some((c) => c.name === 'identity.jwks')).toBe(false);
    expect(deps.healthCalls).toBe(0);
  });

  it('reports the server’s own verdict, because the key set is resolved there', async () => {
    /*
     * `resolveOidcIssuers` is the ONE resolution and lives in a PRIVATE
     * package, so this command cannot run it — see `DoctorDeps.health`. The
     * verdict therefore comes from `GET /v1/integration-health`, which does.
     */
    const { check: c } = await check('identity.jwks', [idv(true)], HEALTHY, {}, {
      health: async () => [
        { id: 'channel.origins', ok: true, detail: 'not this one', fix: null },
        {
          id: 'identity.jwks_reachable',
          ok: false,
          detail: '1 of 1 key set(s) could not be fetched: dns',
          fix: 'Check the issuer host resolves.',
        },
      ],
    });
    expect(c.verdict).toBe('fail');
    expect(c.detail).toContain('could not be fetched');
    expect(c.fix).toBe('Check the issuer host resolves.');
  });

  it('treats ok:null as a warning, because not-determined is not broken', async () => {
    const { check: c } = await check('identity.jwks', [idv(true)], HEALTHY, {}, {
      health: async () => [
        { id: 'identity.jwks_reachable', ok: null, detail: 'not probed yet', fix: null },
      ],
    });
    expect(c.verdict).toBe('warn');
  });

  it('warns when integration-health cannot be read', async () => {
    const { check: c } = await check('identity.jwks', [idv(true)], HEALTHY, {}, {
      health: () => Promise.reject(new Error('Missing permission: workspace:read')),
    });
    expect(c.verdict).toBe('warn');
    expect(c.fix).toContain('workspace:read');
  });
});

describe('files.deprecated', () => {
  it('warns only when a host is actually being retired', async () => {
    const { all } = await check('upload.host', [channelRow()]);
    expect(all.some((c) => c.name.startsWith('files.deprecated'))).toBe(false);

    const { check: c } = await check('files.deprecated', [
      channelRow({ embed: { deprecatedFileOrigins: ['https://old.chatlychat.com'] } }),
    ]);
    expect(c.verdict).toBe('warn');
    expect(c.detail).toContain('old.chatlychat.com');
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
    expect(all).toHaveLength(1);
    expect(all[0]?.verdict).toBe('warn');
    expect(exitCodeFor(all)).toBe(0);
  });

  it('exits non-zero on a failure and zero on warnings alone', () => {
    const w = { name: 'a', verdict: 'warn', detail: '', fix: null } as const;
    const f = { name: 'b', verdict: 'fail', detail: '', fix: null } as const;
    expect(exitCodeFor([w, w])).toBe(0);
    expect(exitCodeFor([w, f])).toBe(1);
  });
});
