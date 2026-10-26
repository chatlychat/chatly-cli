/**
 * `chatly platform plan` / `chatly platform apply` (CHT-F04), end to end with
 * only the socket faked — the real argument parser, `ChatlyClient`,
 * transport and error mapping all run.
 *
 * The fake is a small STATEFUL server rather than a table of canned
 * answers, and that is the point of it. `apply`'s read-back re-reads the
 * surface after writing; a fake that answered the same thing before and
 * after would agree with any write at all, including one the server
 * silently ignored. The tests assert on what the CLI SENT — method, path and
 * body — and on what the re-read found.
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

interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: string;
  members: Array<{ userId: string; email: string; role: string }>;
  apiKeys: Array<Record<string, unknown>>;
  /** What `GET …/settings` answers; `POST …/settings` merges into it as the server does. */
  settings: Record<string, Record<string, unknown>>;
}

function settingsFor(id: string): Tenant['settings'] {
  return {
    businessHours: {
      enabled: false,
      tz: 'UTC',
      schedule: { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null },
      holidays: [],
    },
    routing: { defaultStrategy: 'round_robin', autoAssignmentEnabled: false },
    widgetChannel: {
      id: `ch-${id}`,
      publicId: `pub-${id}`,
      name: 'Website',
      config: {
        allowedOrigins: ['https://acme.test'],
        identityVerification: { mode: 'hmac', secret: '__redacted__' },
      },
    },
  };
}

interface Server {
  tenants: Tenant[];
  /** Set to make `POST …/users` answer 201 and store `agent` whatever was asked. */
  ignoreRole: boolean;
  /** Set to make `POST …/settings` answer 200 and store nothing. */
  ignoreSettings: boolean;
  next: number;
}

function newServer(): Server {
  return {
    ignoreRole: false,
    ignoreSettings: false,
    next: 1,
    tenants: [
      {
        id: 'ws-acme',
        slug: 'acme',
        name: 'Acme',
        status: 'active',
        members: [{ userId: 'u-ops', email: 'ops@acme.test', role: 'admin' }],
        apiKeys: [
          // Revoked: listed with `revokedAt`, and must never be matched.
          {
            id: 'k-old',
            name: 'deploy',
            scopes: ['conversations:read'],
            revokedAt: '2026-10-01T00:00:00Z',
          },
        ],
        settings: settingsFor('ws-acme'),
      },
      // A tenant the documents never mention. Nothing about it may be read.
      {
        id: 'ws-other',
        slug: 'other',
        name: 'Other',
        status: 'active',
        members: [],
        apiKeys: [],
        settings: settingsFor('ws-other'),
      },
    ],
  };
}

function respond(
  server: Server,
  method: string,
  path: string,
  body: Record<string, unknown> | undefined,
) {
  const ok = (b: unknown, status = 200) => ({ status, body: b });
  const tenant = (id: string | undefined) => server.tenants.find((t) => t.id === id);
  const row = (t: Tenant) => ({ id: t.id, slug: t.slug, name: t.name, status: t.status });

  if (method === 'GET' && path === '/v1/platform/whoami') {
    return ok({
      appId: '00000000-0000-0000-0000-000000000001',
      prefix: 'cp_live_abcd',
      scopes: [],
    });
  }
  if (method === 'GET' && path === '/v1/platform/workspaces') {
    return ok({ items: server.tenants.map(row), nextCursor: null, hasMore: false });
  }
  if (method === 'POST' && path === '/v1/platform/workspaces') {
    const t: Tenant = {
      id: `ws-new-${String(server.next++)}`,
      slug: String(body?.['slug']),
      name: String(body?.['name']),
      status: 'active',
      members: [],
      apiKeys: [],
      settings: settingsFor('new'),
    };
    server.tenants.push(t);
    return ok(row(t), 201);
  }
  const m =
    /^\/v1\/platform\/workspaces\/([^/]+)(?:\/(users|api_keys|bots|knowledge_sources|settings)(?:\/([^/]+))?)?$/.exec(
      path,
    );
  const t = tenant(m?.[1]);
  if (m === null || t === undefined) {
    return ok({ code: 'not_found', message: `no route ${method} ${path}` }, 404);
  }
  const [, , sub, childId] = m;
  if (method === 'GET' && sub === undefined) {
    return ok({ ...row(t), users: t.members, channels: [], counts: {} });
  }
  if (sub === 'users' && method === 'POST') {
    const member = {
      userId: `u-${String(server.next++)}`,
      email: String(body?.['email']).toLowerCase(),
      role: server.ignoreRole ? 'agent' : String(body?.['role']),
    };
    t.members.push(member);
    return ok({ ...member, membershipId: 'm-1', name: body?.['name'], created: true }, 201);
  }
  if (sub === 'users' && method === 'DELETE') {
    t.members = t.members.filter((u) => u.userId !== childId);
    return ok({ revoked: true });
  }
  if (sub === 'api_keys' && method === 'GET') {
    return ok(t.apiKeys);
  }
  if (sub === 'api_keys' && method === 'POST') {
    const key = {
      id: `k-${String(server.next++)}`,
      name: body?.['name'],
      scopes: body?.['scopes'],
      revokedAt: null,
      // CHT-SI05: stored as sent, returned on every later read — as the server does.
      metadata: body?.['metadata'] ?? {},
    };
    t.apiKeys.push(key);
    return ok({ ...key, token: 'ck_live_SECRET_ONCE', note: 'copy it now' }, 201);
  }
  if (sub === 'settings' && method === 'GET') {
    return ok({ workspaceId: t.id, ...t.settings });
  }
  if (sub === 'settings' && method === 'POST' && server.ignoreSettings) {
    return ok({ workspaceId: t.id, ...t.settings });
  }
  if (sub === 'settings' && method === 'POST') {
    // The server's merge: hours by top-level key, routing as set, channel config by key.
    const hours = body?.['businessHours'] as Record<string, unknown> | undefined;
    if (hours !== undefined) {
      t.settings['businessHours'] = { ...t.settings['businessHours'], ...hours };
    }
    const routing = body?.['routing'] as Record<string, unknown> | undefined;
    if (routing !== undefined) {
      t.settings['routing'] = { ...t.settings['routing'], ...routing };
    }
    const wc = body?.['widgetChannel'] as { config?: Record<string, unknown> } | undefined;
    if (wc?.config !== undefined) {
      const ch = t.settings['widgetChannel'] ?? {};
      ch['config'] = { ...(ch['config'] as Record<string, unknown>), ...wc.config };
    }
    return ok({ workspaceId: t.id, ...t.settings });
  }
  if ((sub === 'bots' || sub === 'knowledge_sources') && method === 'GET') {
    return ok([]);
  }
  return ok({ code: 'not_found', message: `no route ${method} ${path}` }, 404);
}

function factoryFor(server: Server, seen: Seen[]) {
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = new URL(String(url)).pathname;
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    seen.push({ method, path, body });
    const answer = respond(server, method, path, body);
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return (opts: { apiKey: string; apiUrl?: string }): ChatlyClient =>
    new ChatlyClient({ ...opts, fetchFn, sleepFn: async () => undefined, retry: { attempts: 1 } });
}

describe('chatly platform plan / apply', () => {
  let out: string[];
  let err: string[];
  let dir: string;
  let server: Server;
  let seen: Seen[];

  beforeEach(() => {
    out = [];
    err = [];
    seen = [];
    server = newServer();
    dir = mkdtempSync(join(tmpdir(), 'chatly-pac-'));
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

  function file(document: unknown): string {
    const path = join(dir, 'chatly.platform.json');
    writeFileSync(path, JSON.stringify(document));
    return path;
  }

  const go = (argv: string[]) => run([...argv, '--key', 'cp_live_test'], factoryFor(server, seen));

  /** Exactly what the live tenant already is. */
  const MATCHING = {
    version: 1,
    platform: { prefix: 'cp_live_abcd' },
    resources: {
      workspaces: [{ slug: 'acme', name: 'Acme' }],
      users: [{ workspace: 'acme', email: 'Ops@Acme.test', name: 'Ops', role: 'admin' }],
    },
  };

  it('plan reads only, reads only the named tenant, and reports a matching tenant as noop', async () => {
    const code = await go(['platform', 'plan', '--file', file(MATCHING)]);
    expect(err.join('')).toBe('');
    expect(code).toBe(0);
    expect(seen.every((s) => s.method === 'GET')).toBe(true);
    expect(seen.map((s) => s.path)).toEqual([
      '/v1/platform/whoami',
      '/v1/platform/workspaces',
      '/v1/platform/workspaces/ws-acme',
    ]);
    // The undeclared tenant was counted, never read.
    expect(seen.some((s) => s.path.includes('ws-other'))).toBe(false);
    expect(out.join('')).toContain('1 workspace(s) this credential owns are not in this document');
  });

  it('plan --json says noop for both rows — a no-update-route type is not "blocked" when unchanged', async () => {
    await go(['platform', 'plan', '--json', '--file', file(MATCHING)]);
    const parsed = JSON.parse(out.join('')) as { plan: Array<{ type: string; action: string }> };
    expect(parsed.plan.map((i) => `${i.type}:${i.action}`)).toEqual([
      'workspaces:noop',
      'users:noop',
    ]);
  });

  it('a changed field on an existing tenant is blocked with the reason, and nothing is written', async () => {
    const doc = {
      ...MATCHING,
      resources: { workspaces: [{ slug: 'acme', name: 'Acme Renamed' }] },
    };
    const code = await go(['platform', 'apply', '--file', file(doc)]);
    expect(code).toBe(1);
    expect(seen.filter((s) => s.method !== 'GET')).toEqual([]);
    expect(out.join('')).toContain('there is no PATCH on a platform workspace');
  });

  it('the prefix guard refuses before any other read', async () => {
    const doc = { ...MATCHING, platform: { prefix: 'cp_live_zzzz' } };
    const code = await go(['platform', 'apply', '--file', file(doc)]);
    expect(code).toBe(1);
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(['GET /v1/platform/whoami']);
    expect(err.join('')).toContain('cp_live_abcd');
  });

  it('apply creates a tenant then its children under the NEW id, with no parent field in any body', async () => {
    const doc = {
      version: 1,
      resources: {
        workspaces: [{ slug: 'beta', name: 'Beta' }],
        users: [{ workspace: 'beta', email: 'lead@beta.test', name: 'Lead', role: 'owner' }],
        apiKeys: [{ workspace: 'beta', name: 'deploy', scopes: ['conversations:read'] }],
      },
    };
    const code = await go(['platform', 'apply', '--file', file(doc)]);
    const writes = seen.filter((s) => s.method !== 'GET');
    expect(writes).toEqual([
      { method: 'POST', path: '/v1/platform/workspaces', body: { slug: 'beta', name: 'Beta' } },
      {
        method: 'POST',
        path: '/v1/platform/workspaces/ws-new-1/users',
        body: { email: 'lead@beta.test', name: 'Lead', role: 'owner' },
      },
      {
        method: 'POST',
        path: '/v1/platform/workspaces/ws-new-1/api_keys',
        body: { name: 'deploy', scopes: ['conversations:read'] },
      },
    ]);
    expect(out.join('')).toContain('ck_live_SECRET_ONCE');
    expect(out.join('')).toContain('Read back: everything matches the document.');
    expect(code).toBe(0);
  });

  it('a revoked key is not matched: the document row is a create, not a noop', async () => {
    const doc = {
      version: 1,
      resources: {
        apiKeys: [{ workspace: 'acme', name: 'deploy', scopes: ['conversations:read'] }],
      },
    };
    await go(['platform', 'apply', '--file', file(doc)]);
    expect(seen.filter((s) => s.method === 'POST').map((s) => s.path)).toEqual([
      '/v1/platform/workspaces/ws-acme/api_keys',
    ]);
  });

  it('read-back catches a 201 that ignored part of the request', async () => {
    server.ignoreRole = true;
    const doc = {
      version: 1,
      resources: {
        users: [{ workspace: 'acme', email: 'new@acme.test', name: 'New', role: 'admin' }],
      },
    };
    const code = await go(['platform', 'apply', '--file', file(doc)]);
    expect(code).toBe(1);
    expect(out.join('')).toContain('Read back: 1 item(s) still differ from the document');
    expect(out.join('')).toContain('users/acme/new@acme.test: blocked');
  });

  it('--prune removes an unmentioned member under its tenant id, and never offers a tenant', async () => {
    const doc = {
      version: 1,
      resources: { workspaces: [{ slug: 'acme', name: 'Acme' }], users: [] },
    };
    const code = await go(['platform', 'apply', '--prune', '--file', file(doc)]);
    expect(seen.filter((s) => s.method !== 'GET')).toEqual([
      { method: 'DELETE', path: '/v1/platform/workspaces/ws-acme/users/u-ops', body: undefined },
    ]);
    expect(code).toBe(0);
  });

  it('points the old top-level CHT-F04 names at the settings row, before any read', async () => {
    const doc = {
      version: 1,
      resources: { widgetChannel: [{ workspace: 'acme', allowedOrigins: ['https://a.test'] }] },
    };
    await expect(go(['platform', 'plan', '--file', file(doc)])).rejects.toThrow(
      /declare it inside a `settings` row/,
    );
    expect(seen).toEqual([]);
  });

  describe('settings (business hours, routing, widget channel)', () => {
    const SETTINGS = (row: Record<string, unknown>) => ({
      version: 1,
      resources: {
        workspaces: [{ slug: 'acme', name: 'Acme' }],
        settings: [{ workspace: 'acme', ...row }],
      },
    });

    /*
     * Control: drop `mergeFields` from the `settings` def and this fails —
     * the live hours carry `enabled`, `schedule` and `holidays` the document
     * never named, and a whole-object comparison calls that a change for ever.
     */
    it('compares only the keys the document names, so a matching subset is noop', async () => {
      const doc = SETTINGS({
        businessHours: { tz: 'UTC' },
        routing: { defaultStrategy: 'round_robin' },
        widgetChannel: { config: { allowedOrigins: ['https://acme.test'] } },
      });
      await go(['platform', 'plan', '--json', '--file', file(doc)]);
      const parsed = JSON.parse(out.join('')) as { plan: Array<{ type: string; action: string }> };
      expect(parsed.plan.map((i) => `${i.type}:${i.action}`)).toEqual([
        'workspaces:noop',
        'settings:noop',
      ]);
      expect(seen.every((s) => s.method === 'GET')).toBe(true);
      // Read for the declared tenant only.
      expect(seen.map((s) => s.path)).toContain('/v1/platform/workspaces/ws-acme/settings');
      expect(seen.some((s) => s.path.includes('ws-other'))).toBe(false);
    });

    it('apply POSTs only the changed sections, with the document values, and reads back a match', async () => {
      const doc = SETTINGS({
        businessHours: { tz: 'Europe/Madrid' },
        routing: { defaultStrategy: 'round_robin' },
        widgetChannel: { config: { identityVerification: { mode: 'hmac' }, consent: 'auto' } },
      });
      const code = await go(['platform', 'apply', '--file', file(doc)]);
      expect(seen.filter((s) => s.method !== 'GET')).toEqual([
        {
          method: 'POST',
          path: '/v1/platform/workspaces/ws-acme/settings',
          body: {
            businessHours: { tz: 'Europe/Madrid' },
            widgetChannel: { config: { identityVerification: { mode: 'hmac' }, consent: 'auto' } },
          },
        },
      ]);
      expect(out.join('')).toContain('Read back: everything matches the document.');
      expect(code).toBe(0);
    });

    it('does not report a redacted value as a change when the document names around it', async () => {
      // Live `identityVerification` carries `secret: "__redacted__"`; the document names `mode`.
      const doc = SETTINGS({
        widgetChannel: { config: { identityVerification: { mode: 'hmac' } } },
      });
      await go(['platform', 'plan', '--json', '--file', file(doc)]);
      const parsed = JSON.parse(out.join('')) as { plan: Array<{ type: string; action: string }> };
      expect(parsed.plan.find((i) => i.type === 'settings')?.action).toBe('noop');
    });

    it('a write the server answers 200 to and ignores fails read-back', async () => {
      server.ignoreSettings = true;
      const doc = SETTINGS({ routing: { defaultStrategy: 'load_balanced' } });
      const code = await go(['platform', 'apply', '--file', file(doc)]);
      expect(seen.filter((s) => s.method === 'POST')).toHaveLength(1);
      expect(out.join('')).toContain('item(s) still differ from the document');
      expect(code).toBe(1);
    });
  });

  it('refuses a whole cp_ token where the prefix belongs', async () => {
    const doc = { ...MATCHING, platform: { prefix: `cp_${'x'.repeat(43)}` } };
    await expect(go(['platform', 'plan', '--file', file(doc)])).rejects.toThrow(
      /looks like a whole token/,
    );
    expect(seen).toEqual([]);
  });

  it('sends metadata on a create, and reads it back as matching', async () => {
    const doc = {
      version: 1,
      resources: {
        apiKeys: [
          {
            workspace: 'acme',
            name: 'ci',
            scopes: ['conversations:read'],
            metadata: { env: 'prod' },
          },
        ],
      },
    };
    const code = await go(['platform', 'apply', '--file', file(doc)]);
    expect(seen.find((s) => s.method === 'POST')?.body).toEqual({
      name: 'ci',
      scopes: ['conversations:read'],
      metadata: { env: 'prod' },
    });
    expect(out.join('')).toContain('Read back: everything matches the document.');
    expect(code).toBe(0);
  });

  it('a changed tag on an existing key cannot be applied — no PATCH exists — and writes nothing', async () => {
    const acme = server.tenants[0];
    acme?.apiKeys.push({
      id: 'k-live',
      name: 'ci',
      scopes: ['conversations:read'],
      revokedAt: null,
      metadata: { env: 'staging' },
    });
    const doc = {
      version: 1,
      resources: {
        apiKeys: [
          {
            workspace: 'acme',
            name: 'ci',
            scopes: ['conversations:read'],
            metadata: { env: 'prod' },
          },
        ],
      },
    };
    const code = await go(['platform', 'apply', '--file', file(doc)]);
    expect(code).toBe(1);
    expect(seen.filter((s) => s.method !== 'GET')).toEqual([]);
    expect(out.join('')).toContain('`metadata` changed');
  });

  it('an unknown subcommand is a usage error, not a request', async () => {
    expect(await go(['platform', 'destroy'])).toBe(2);
    expect(err.join('')).toContain('Unknown subcommand "platform destroy"');
    expect(seen).toEqual([]);
  });
});
