/**
 * `chatly init` (CHT-F02), end to end with only the socket faked: the real
 * parser, `ChatlyClient` and transport, writing into a real temp directory.
 *
 * Asserted on what reached the DISK and what went over the WIRE — the CSP and
 * the storage table must be the ones the channel's embed block carried, not
 * values this CLI happens to know.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ChatlyClient } from '@chatlychat/sdk-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The Remix route imports `@chatlychat/widget-react/server`, which is not a
 * dependency of this CLI and is not installed beside a temp dir. The stand-in
 * IS the published construction (HMAC-SHA256, the secret as a raw string, hex)
 * with the published argument order, so a loader that swapped the arguments
 * or hashed something else produces a different digest than the fixed vector.
 */
vi.mock('@chatlychat/widget-react/server', async () => {
  const { createHmac } = await import('node:crypto');
  return {
    chatlyUserHash: (secret: string, externalId: string) =>
      createHmac('sha256', secret).update(externalId).digest('hex'),
  };
});

import { run } from '../run.js';

const EMBED = {
  snippet: '<script>/* eager snippet for acme-web */</script>',
  contentSecurityPolicy: {
    scriptSrc: ['https://widget.example.test'],
    connectSrc: ['https://api.example.test', 'wss://rt.example.test'],
    imgSrc: ['https://files.example.test', 'data:', 'blob:'],
    mediaSrc: ['https://files.example.test'],
  },
  storage: [
    {
      key: 'chatly:vt:acme-web',
      store: 'localStorage',
      purpose: 'Keeps the visitor | session',
      lifetime: 'persistent',
      category: 'functional',
      writtenWhen: 'session-start',
    },
  ],
};

const CHANNELS = [
  { type: 'email', publicId: 'mail-1', name: 'Mail', embed: null },
  { type: 'web', publicId: 'acme-web', name: 'Site', embed: EMBED },
];

interface Seen {
  readonly method: string;
  readonly path: string;
}

function factoryFor(channels: unknown, seen: Seen[]) {
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = new URL(String(url)).pathname;
    seen.push({ method, path });
    const ok = method === 'GET' && path === '/v1/channels';
    return new Response(JSON.stringify(ok ? channels : { code: 'nope', message: 'unexpected' }), {
      status: ok ? 200 : 500,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return (opts: { apiKey: string; apiUrl?: string }): ChatlyClient =>
    new ChatlyClient({ ...opts, fetchFn, sleepFn: async () => undefined, retry: { attempts: 1 } });
}

describe('chatly init', () => {
  let out: string[];
  let err: string[];
  let dir: string;
  let seen: Seen[];

  beforeEach(() => {
    out = [];
    err = [];
    seen = [];
    dir = mkdtempSync(join(tmpdir(), 'chatly-init-'));
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const go = (argv: string[], channels: unknown = CHANNELS) =>
    run([...argv, '--dir', dir, '--key', 'ck_test'], factoryFor(channels, seen));
  const read = (p: string) => readFileSync(join(dir, p), 'utf8');

  it('next: writes the four files from the channel embed block, with one GET and no write', async () => {
    const code = await go(['init', 'next']);
    expect(err.join('')).toBe('');
    expect(code).toBe(0);
    expect(seen).toEqual([{ method: 'GET', path: '/v1/channels' }]);

    expect(read('app/api/chatly/identity/route.ts')).toContain(
      "import { chatlyUserHash } from '@chatlychat/widget-react/server';",
    );
    expect(read('components/chatly.tsx')).toContain('<ChatlyLauncher publicId="acme-web"');
    expect(read('CHATLY-PRIVACY.md')).toContain(
      '| `chatly:vt:acme-web` | localStorage | Keeps the visitor \\| session | persistent | functional | session-start |',
    );
    expect(out.join('')).toContain('Wire `currentUserId`');
  });

  it('the generated CSP module is the server’s lists, and withChatly merges rather than replaces', async () => {
    await go(['init', 'next']);
    const mod = (await import(pathToFileURL(join(dir, 'chatly.csp.mjs')).href)) as {
      chatlyCsp: Record<string, string[]>;
      withChatly: (d: Record<string, string[]>) => Record<string, string[]>;
      toHeader: (d: Record<string, string[]>) => string;
    };
    expect(mod.chatlyCsp['connect-src']).toEqual([
      'https://api.example.test',
      'wss://rt.example.test',
    ]);
    const merged = mod.withChatly({
      'script-src': ["'self'", 'https://widget.example.test'],
      'default-src': ["'self'"],
    });
    expect(merged['script-src']).toEqual(["'self'", 'https://widget.example.test']);
    expect(merged['default-src']).toEqual(["'self'"]);
    expect(merged['img-src']).toEqual(["'self'", 'https://files.example.test', 'data:', 'blob:']);
    expect(mod.toHeader({ 'script-src': ["'self'", 'https://a.test'] })).toBe(
      "script-src 'self' https://a.test",
    );
  });

  it('express: the generated identity handler signs exactly what the docs say, and is anonymous without a user', async () => {
    await go(['init', 'express']);
    expect(read('chatly/snippet.html')).toContain(EMBED.snippet);
    const mod = (await import(pathToFileURL(join(dir, 'chatly/identity.mjs')).href)) as {
      chatlyUserHash: (s: string, id: string) => string;
      chatlyIdentity: (
        f: (r: unknown) => string | null,
      ) => (req: unknown, res: unknown) => Promise<unknown>;
    };
    // A fixed vector, so a template that hashed something else fails here.
    const { createHmac } = await import('node:crypto');
    expect(mod.chatlyUserHash('s3cret', 'user_42')).toBe(
      createHmac('sha256', 's3cret').update('user_42').digest('hex'),
    );

    const sent: unknown[] = [];
    const res = {
      statusCode: 200,
      set: () => res,
      status: (c: number) => ((res.statusCode = c), res),
      json: (b: unknown) => (sent.push({ status: res.statusCode, body: b }), res),
    };
    await mod.chatlyIdentity(() => null)({}, res);
    vi.stubEnv('CHATLY_IDV_SECRET', 's3cret');
    await mod.chatlyIdentity(() => 'user_42')({}, res);
    vi.unstubAllEnvs();
    expect(sent).toEqual([
      { status: 200, body: { identity: null } },
      {
        status: 200,
        body: {
          identity: { externalId: 'user_42', userHash: mod.chatlyUserHash('s3cret', 'user_42') },
        },
      },
    ]);
  });

  it('writes nothing at all when any target exists, and names it', async () => {
    mkdirSync(join(dir, 'components'));
    writeFileSync(join(dir, 'components/chatly.tsx'), 'MINE');
    const code = await go(['init', 'next']);
    expect(code).toBe(1);
    expect(err.join('')).toContain('components/chatly.tsx');
    expect(read('components/chatly.tsx')).toBe('MINE');
    expect(existsSync(join(dir, 'chatly.csp.mjs'))).toBe(false);
  });

  it('--dry-run prints and writes nothing', async () => {
    expect(await go(['init', 'next', '--dry-run'])).toBe(0);
    expect(out.join('')).toContain('── chatly.csp.mjs ──');
    expect(existsSync(join(dir, 'chatly.csp.mjs'))).toBe(false);
  });

  it('atlas: no server route, and the launcher passes getToken through', async () => {
    await go(['init', 'next', '--identity', 'atlas']);
    expect(existsSync(join(dir, 'app/api/chatly/identity/route.ts'))).toBe(false);
    expect(read('components/chatly.tsx')).toContain('{ getToken }');
  });

  it('several web channels and no --public-id is refused with the list', async () => {
    const two = [...CHANNELS, { type: 'web', publicId: 'beta-web', name: 'Beta', embed: EMBED }];
    expect(await go(['init', 'next'], two)).toBe(1);
    expect(err.join('')).toContain('beta-web');
    expect(await go(['init', 'next', '--public-id', 'beta-web'], two)).toBe(0);
    expect(read('components/chatly.tsx')).toContain('publicId="beta-web"');
  });

  /** What every identity endpoint must answer for `user_42` under secret `s3cret`. */
  const VECTOR = {
    identity: {
      externalId: 'user_42',
      // HMAC-SHA256('s3cret', 'user_42'), hex — computed independently of any template.
      userHash: '',
    },
  };
  beforeEach(async () => {
    const { createHmac } = await import('node:crypto');
    VECTOR.identity.userHash = createHmac('sha256', 's3cret').update('user_42').digest('hex');
  });

  /** The integrator's one edit: wire `currentUserId` to a signed-in user. */
  const signIn = (p: string) => {
    const src = read(p);
    const wired = src.replace(
      /(async function currentUserId\([^)]*\): Promise<string \| null> \{\n)(?:.*\n)*? {2}return null;\n/,
      "$1  return 'user_42';\n",
    );
    expect(wired).not.toBe(src);
    writeFileSync(join(dir, p.replace(/\.ts$/, '.signed-in.ts')), wired);
  };

  it('remix: route, launcher and the two shared files, from the same single GET', async () => {
    const code = await go(['init', 'remix']);
    expect(err.join('')).toBe('');
    expect(code).toBe(0);
    expect(seen).toEqual([{ method: 'GET', path: '/v1/channels' }]);

    const route = read('app/routes/api.chatly.identity.ts');
    expect(route).toContain("import { chatlyUserHash } from '@chatlychat/widget-react/server';");
    expect(route).toContain('Generated by `chatly init remix`');
    // No framework import: the same file is a Remix v2 and a React Router v7 loader.
    expect(route).not.toMatch(/from '(@remix-run\/[a-z-]+|react-router)'/);

    const launcher = read('app/components/chatly.tsx');
    expect(launcher).toContain('<ChatlyLauncher publicId="acme-web"');
    expect(launcher).toContain('`app/routes/api.chatly.identity.ts`');
    expect(launcher).toContain('`chatly init remix`');
    expect(launcher).toContain('in app/root.tsx');
    expect(launcher).not.toContain("'use client'");
    expect(launcher).not.toContain('chatly init next');

    expect(read('chatly.csp.mjs')).toContain("'connect-src': [\"https://api.example.test\"");
    expect(read('CHATLY-PRIVACY.md')).toContain('`chatly:vt:acme-web`');
    expect(out.join('')).toContain('app/routes/api.chatly.identity.ts to your session');
  });

  it('remix: the loader is anonymous without a user, 500s without a secret, and signs the fixed vector', async () => {
    await go(['init', 'remix']);
    type Loader = (a: { request: Request }) => Promise<Response>;
    const call = async (loader: Loader) => {
      const r = await loader({ request: new Request('https://shop.test/api/chatly/identity') });
      return { status: r.status, cache: r.headers.get('cache-control'), body: await r.json() };
    };
    const anon = (await import(
      pathToFileURL(join(dir, 'app/routes/api.chatly.identity.ts')).href
    )) as { loader: Loader };
    expect(await call(anon.loader)).toEqual({
      status: 200,
      cache: 'no-store',
      body: { identity: null },
    });

    signIn('app/routes/api.chatly.identity.ts');
    const signed = (await import(
      pathToFileURL(join(dir, 'app/routes/api.chatly.identity.signed-in.ts')).href
    )) as { loader: Loader };
    vi.stubEnv('CHATLY_IDV_SECRET', '');
    expect((await call(signed.loader)).status).toBe(500);
    vi.stubEnv('CHATLY_IDV_SECRET', 's3cret');
    expect(await call(signed.loader)).toEqual({ status: 200, cache: 'no-store', body: VECTOR });
    vi.unstubAllEnvs();
  });

  it('remix atlas: no route, and the launcher passes getToken through', async () => {
    expect(await go(['init', 'remix', '--identity', 'atlas'])).toBe(0);
    expect(existsSync(join(dir, 'app/routes/api.chatly.identity.ts'))).toBe(false);
    const launcher = read('app/components/chatly.tsx');
    expect(launcher).toContain('{ getToken }');
    expect(launcher).toContain('`chatly init remix --identity atlas`');
    expect(launcher).not.toContain("'use client'");
  });

  it('astro: endpoint, component and the two shared files; the endpoint signs the fixed vector', async () => {
    const code = await go(['init', 'astro']);
    expect(err.join('')).toBe('');
    expect(code).toBe(0);
    expect(seen).toEqual([{ method: 'GET', path: '/v1/channels' }]);
    expect(existsSync(join(dir, 'chatly.csp.mjs'))).toBe(true);
    expect(existsSync(join(dir, 'CHATLY-PRIVACY.md'))).toBe(true);

    const component = read('src/components/Chatly.astro');
    // The snippet travels as a JS string and is emitted verbatim by set:html.
    expect(component).toContain(`const snippet = ${JSON.stringify(EMBED.snippet)};`);
    expect(component).toContain('<Fragment set:html={snippet} />');
    expect(component).toContain('<script is:inline>');
    expect(component).toContain("Chatly('identify', body.identity)");

    type Get = (c: unknown) => Promise<Response>;
    const call = async (get: Get) => {
      const r = await get({ request: new Request('https://shop.test/api/chatly/identity') });
      return { status: r.status, cache: r.headers.get('cache-control'), body: await r.json() };
    };
    const anon = (await import(
      pathToFileURL(join(dir, 'src/pages/api/chatly/identity.ts')).href
    )) as { GET: Get; prerender: boolean; chatlyUserHash: (s: string, id: string) => string };
    expect(anon.prerender).toBe(false);
    expect(anon.chatlyUserHash('s3cret', 'user_42')).toBe(VECTOR.identity.userHash);
    expect(await call(anon.GET)).toEqual({ status: 200, cache: 'no-store', body: { identity: null } });

    signIn('src/pages/api/chatly/identity.ts');
    const signed = (await import(
      pathToFileURL(join(dir, 'src/pages/api/chatly/identity.signed-in.ts')).href
    )) as { GET: Get };
    vi.stubEnv('CHATLY_IDV_SECRET', '');
    expect((await call(signed.GET)).status).toBe(500);
    vi.stubEnv('CHATLY_IDV_SECRET', 's3cret');
    expect(await call(signed.GET)).toEqual({ status: 200, cache: 'no-store', body: VECTOR });
    vi.unstubAllEnvs();
  });

  it('astro and express refuse --identity atlas, before any request', async () => {
    for (const fw of ['astro', 'express']) {
      expect(await go(['init', fw, '--identity', 'atlas'])).toBe(2);
      expect(err.join('')).toContain(`chatly init ${fw} --identity atlas`);
    }
    expect(seen).toEqual([]);
    expect(existsSync(join(dir, 'chatly.csp.mjs'))).toBe(false);
  });

  it('an unknown framework is refused with the usage, before any request', async () => {
    expect(await go(['init', 'svelte'])).toBe(2);
    expect(err.join('')).toContain('<next|remix|astro|express>');
    expect(seen).toEqual([]);
  });
});
