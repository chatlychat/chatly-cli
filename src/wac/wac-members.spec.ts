/**
 * `members` in `chatly plan` / `chatly apply` (CH-08).
 *
 * The property that matters is that a teammate is invited ONCE: the live read
 * is the invitation list, not the member list, so a row stays matched while
 * the invitee has not signed in yet. The fake below honours the `status`
 * filter exactly as `InvitesAdminService.list` does — a fake that returned
 * every row whatever was asked would agree with a CLI that forgot
 * `?status=all`, which is the shape of the bug this file is here to catch.
 *
 * Every assertion is on what was SENT.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatlyClient } from '@chatlychat/sdk-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { doc as docOf, issues, live } from './__tests__/wac-fixtures.js';
import { buildPlan } from './diff.js';
import { parseDocument } from './document.js';
import { run } from '../run.js';

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly body: Record<string, unknown> | undefined;
}

type Invite = Record<string, unknown> & {
  id: string;
  email: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  expiresAt: string;
};

const DAY = 24 * 60 * 60 * 1000;
const later = (ms: number): string => new Date(Date.now() + ms).toISOString();

function invite(over: Partial<Invite> & { email: string }): Invite {
  return {
    id: `i${over.email}`,
    role: 'agent',
    invitedBy: null,
    invitedByName: null,
    invitedByEmail: null,
    createdAt: later(-DAY),
    expiresAt: later(14 * DAY),
    acceptedAt: null,
    revokedAt: null,
    ...over,
  };
}

function server(rows: Invite[], seen: Seen[]) {
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const u = new URL(String(url));
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    seen.push({ method, path: u.pathname, search: u.search, body });
    const json = (status: number, b: unknown): Response =>
      new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    // `listInvitesQuerySchema.status` defaults to `pending`, and `pending`
    // means not accepted, not revoked and not expired.
    const visible = (): Invite[] => {
      const status = u.searchParams.get('status') ?? 'pending';
      return status === 'all'
        ? rows
        : rows.filter(
            (r) =>
              r.acceptedAt === null && r.revokedAt === null && Date.parse(r.expiresAt) > Date.now(),
          );
    };
    if (method === 'GET' && u.pathname === '/v1/invites') {
      return json(200, { items: visible(), nextCursor: null });
    }
    if (method === 'POST' && u.pathname === '/v1/invites' && body !== undefined) {
      rows.push(invite({ email: String(body['email']), role: String(body['role'] ?? 'agent') }));
      // The route answers the first page of PENDING invites after the send.
      return json(201, { items: visible(), nextCursor: null });
    }
    return json(500, { code: 'unexpected', message: `${method} ${u.pathname}` });
  }) as unknown as typeof fetch;
  return (o: { apiKey: string; apiUrl?: string }): ChatlyClient =>
    new ChatlyClient({ ...o, fetchFn, sleepFn: async () => undefined, retry: { attempts: 1 } });
}

const go = (args: string[], rows: Invite[], seen: Seen[] = []) =>
  run([...args, '--key', 'ck_t'], server(rows, seen));
const writes = (seen: Seen[]) => seen.filter((s) => s.method !== 'GET');

describe('inviting a teammate from the document', () => {
  let out: string[];
  let dir: string;
  beforeEach(() => {
    out = [];
    dir = mkdtempSync(join(tmpdir(), 'chatly-wac-mem-'));
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
  });

  const file = (members: unknown[]): string => {
    const p = join(dir, 'chatly.json');
    writeFileSync(p, JSON.stringify({ version: 1, resources: { members } }));
    return p;
  };
  const OPS = { email: 'ops@example.com', role: 'agent' };

  it('posts the row FLAT, and reads the invite list with status=all', async () => {
    const rows: Invite[] = [];
    const seen: Seen[] = [];
    expect(await go(['apply', '--file', file([OPS])], rows, seen)).toBe(0);
    const post = writes(seen);
    expect(post).toHaveLength(1);
    expect(post[0]?.path).toBe('/v1/invites');
    expect(post[0]?.body).toEqual({ email: 'ops@example.com', role: 'agent' });
    expect(seen.filter((s) => s.method === 'GET').map((s) => s.search)).toContain('?status=all');
    expect(out.join('')).toContain('Read back: everything matches');
  });

  it('invites nobody a second time while the invitation is still pending', async () => {
    const rows = [invite({ email: 'ops@example.com' })];
    const seen: Seen[] = [];
    expect(await go(['apply', '--file', file([OPS])], rows, seen)).toBe(0);
    expect(writes(seen)).toEqual([]);
  });

  /*
   * The whole reason the live read is the invitation list. An accepted invite
   * is invisible to `?status=pending`, so a CLI reading that would re-invite
   * the person on every deploy after they joined.
   */
  it('invites nobody a second time once the invitation has been accepted', async () => {
    const rows = [invite({ email: 'ops@example.com', acceptedAt: later(-DAY) })];
    const seen: Seen[] = [];
    expect(await go(['apply', '--file', file([OPS])], rows, seen)).toBe(0);
    expect(writes(seen)).toEqual([]);
  });

  it('never deletes anybody, even with --prune', async () => {
    const rows = [invite({ email: 'someone-else@example.com' })];
    const seen: Seen[] = [];
    /*
     * 1, not 0: a `--prune` that left an orphan standing is reported as
     * unverified by the generic read-back, exactly as it is for `channels`
     * and `emailTemplates`. The point of this test is the WIRE — no DELETE
     * is sent for a person — and the line that says why.
     */
    expect(await go(['apply', '--prune', '--file', file([OPS])], rows, seen)).toBe(1);
    expect(writes(seen).map((w) => w.method)).toEqual(['POST']);
    expect(out.join('')).toContain('`--prune` cannot delete this');
  });
});

/* ══ The rules, without a transport ═══════════════════════════════════════ */

const planOf = (members: unknown[], rows: Array<Record<string, unknown>> = []) =>
  buildPlan(parseDocument(docOf({ members })), live({ members: rows }));

describe('an invitation that is no longer live', () => {
  it('is not matched, so the document invites again (revoked)', () => {
    const plan = planOf(
      [{ email: 'ops@example.com' }],
      [invite({ email: 'ops@example.com', revokedAt: later(-DAY) })],
    );
    expect(plan.items.map((i) => i.action)).toEqual(['create']);
  });

  it('is not matched, so the document invites again (expired, never accepted)', () => {
    const plan = planOf(
      [{ email: 'ops@example.com' }],
      [invite({ email: 'ops@example.com', expiresAt: later(-DAY) })],
    );
    expect(plan.items.map((i) => i.action)).toEqual(['create']);
  });

  it('is invisible rather than an orphan — nothing offers to delete it', () => {
    const plan = planOf([], [invite({ email: 'gone@example.com', revokedAt: later(-DAY) })]);
    expect(plan.items).toEqual([]);
  });
});

describe('a role that differs from the server', () => {
  it('is blocked rather than planned as an update no key can make', () => {
    const plan = planOf(
      [{ email: 'ops@example.com', role: 'admin' }],
      [invite({ email: 'ops@example.com', role: 'agent' })],
    );
    expect(plan.items[0]?.action).toBe('blocked');
    expect(plan.items[0]?.reason).toContain('members:write');
    expect(plan.items[0]?.reason).toContain('dashboard');
  });
});

describe('the email is normalised on both sides, as the route does', () => {
  it('matches a live invitation whatever the author typed', () => {
    const plan = planOf(
      [{ email: 'Ops@Example.COM' }],
      [invite({ email: 'ops@example.com', role: 'agent' })],
    );
    expect(plan.items.map((i) => i.action)).toEqual(['noop']);
  });
});

describe('what the document may not say', () => {
  it('refuses a row carrying state the server owns', () => {
    const found = issues(docOf({ members: [{ email: 'ops@example.com', acceptedAt: null }] }));
    expect(found.join('\n')).toContain('`acceptedAt` is returned on a read');
  });

  it('refuses something that is not an email address', () => {
    const found = issues(docOf({ members: [{ email: 'ops' }] }));
    expect(found.join('\n')).toContain('must match');
  });
});
