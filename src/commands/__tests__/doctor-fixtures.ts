/**
 * The world `chatly doctor`'s specs run against: a recording `fetch`, a
 * `DoctorDeps` whose two API reads are stubs, and a channel row shaped like
 * `GET /v1/channels` returns one.
 *
 * Here rather than in `doctor.spec.ts` because two spec files drive the same
 * judgement from opposite ends — the browser-shaped probes, and the verdicts
 * the server computes — and `doctor.spec.ts` was over the 650-line band with
 * both in it. A second copy of this table is a second definition of
 * "healthy", which is how a probe starts agreeing with the stub instead of
 * with the code.
 *
 * `__tests__/` and not `commands/` on purpose: this exports functions that
 * look like callers to the route-caller and dead-export gates, and that
 * directory is where this package already keeps its fixtures
 * (`wac/__tests__/wac-fixtures.ts`).
 */
import { runChecks, selectChannels, type DoctorCheck, type DoctorDeps } from '../doctor-checks.js';

export interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

export const PRESIGNED =
  'https://uploads.chatlychat.com/chatly/workspaces/ws_1/uploads/u_1/x.png?X-Amz-Signature=deadbeef';

/** A channel row shaped like `GET /v1/channels` returns one. */
export function channelRow(over: Record<string, unknown> = {}): Record<string, unknown> {
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
export function stubFetch(
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

export function depsFor(
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
    // Empty rather than a pass: a stub that answers `ok: true` for checks a
    // test never named is a stub the code agrees with whatever it does.
    identityContract: async () => ({}),
    ...over,
    get healthCalls(): number {
      return state.healthCalls;
    },
  };
}

export const pick = (checks: readonly DoctorCheck[], prefix: string): DoctorCheck => {
  const found = checks.find((c) => c.name.startsWith(prefix));
  if (found === undefined) {
    throw new Error(`no check named ${prefix} in ${checks.map((c) => c.name).join(', ')}`);
  }
  return found;
};

/** The default world: everything serves, CORS is in effect, origins are set. */
export const HEALTHY: Record<
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

export async function check(
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
