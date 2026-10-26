/**
 * `chatly deliveries list | show | replay`, on the wire: real `run()`, real
 * client and transport, only `fetch` faked, assertions on what went UP.
 */
import { ChatlyClient } from '@chatlychat/sdk-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { run } from '../run.js';

interface Sent {
  method: string;
  path: string;
  search: string;
}

function factoryFor(answer: unknown, sent: Sent[]) {
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    sent.push({ method: init?.method ?? 'GET', path: u.pathname, search: u.search });
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return (opts: { apiKey: string; apiUrl?: string }) =>
    new ChatlyClient({ ...opts, fetchFn, sleepFn: async () => undefined, retry: { attempts: 1 } });
}

describe('chatly deliveries', () => {
  let err: string[];
  beforeEach(() => {
    err = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('list walks the bot-scoped ledger and forwards --status', async () => {
    const sent: Sent[] = [];
    const code = await run(
      ['deliveries', 'list', '--bot', 'b_1', '--status', 'dead', '--key', 'ck_t'],
      factoryFor({ items: [], nextCursor: null, hasMore: false }, sent),
    );
    expect(code).toBe(0);
    expect(sent[0]).toMatchObject({ method: 'GET', path: '/v1/bots/b_1/deliveries' });
    expect(sent[0]?.search).toContain('status=dead');
  });

  it('show reads one delivery by event id', async () => {
    const sent: Sent[] = [];
    await run(
      ['deliveries', 'show', 'evt_9', '--bot', 'b_1', '--key', 'ck_t'],
      factoryFor({ id: 'evt_9' }, sent),
    );
    expect(sent[0]).toMatchObject({ method: 'GET', path: '/v1/bots/b_1/deliveries/evt_9' });
  });

  it('replay POSTs the replay route for that event id', async () => {
    const sent: Sent[] = [];
    await run(
      ['delivery', 'replay', 'evt_9', '--bot', 'b_1', '--key', 'ck_t'],
      factoryFor({ queued: true }, sent),
    );
    expect(sent[0]).toMatchObject({
      method: 'POST',
      path: '/v1/bots/b_1/deliveries/evt_9/replay',
    });
  });

  it('refuses to guess the bot', async () => {
    const sent: Sent[] = [];
    await expect(
      run(['deliveries', 'show', 'evt_9', '--key', 'ck_t'], factoryFor({}, sent)),
    ).rejects.toThrow(/--bot/);
    expect(sent).toHaveLength(0);
  });
});
