/**
 * `chatly bots rotate-secret <id> [--activate-at <instant>]`, on the wire.
 *
 * Driven through the real `run()`, the real `ChatlyClient` and the real
 * transport, with only `fetch` faked — and every assertion that matters is on
 * what went UP. A canned response cannot tell a CLI that sent the window from
 * one that dropped it: both get a 201 with a secret in it, and the second one
 * has just cut every in-flight delivery over to a secret nobody has deployed.
 */
import { ChatlyClient } from '@chatlychat/sdk-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { run } from '../run.js';

interface Sent {
  method: string;
  path: string;
  rawBody: string | undefined;
  headers: Record<string, string>;
}

function factoryFor(answer: unknown, sent: Sent[]) {
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    sent.push({
      method: init?.method ?? 'GET',
      path: new URL(String(url)).pathname,
      rawBody: typeof init?.body === 'string' ? init.body : undefined,
      headers,
    });
    return new Response(JSON.stringify(answer), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return (opts: { apiKey: string; apiUrl?: string }) =>
    new ChatlyClient({ ...opts, fetchFn, sleepFn: async () => undefined, retry: { attempts: 1 } });
}

const PATH = '/v1/bots/b_1/external/rotate-secret';

describe('chatly bots rotate-secret', () => {
  let out: string[];
  let err: string[];
  beforeEach(() => {
    out = [];
    err = [];
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

  it('with no flag sends no body — the hard cut every existing script relies on', async () => {
    const sent: Sent[] = [];
    const code = await run(
      ['bots', 'rotate-secret', 'b_1', '--key', 'ck_t'],
      factoryFor({ signingSecret: 'whsec_n', activatesAt: null }, sent),
    );
    expect(code).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe('POST');
    expect(sent[0]?.path).toBe(PATH);
    expect(sent[0]?.rawBody).toBeUndefined();
    expect(sent[0]?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    // Nothing was asked for, so a null is not news.
    expect(err.join('')).toBe('');
  });

  it('--activate-at sends exactly {"activateAt"}, verbatim, and prints the instant back', async () => {
    const sent: Sent[] = [];
    const code = await run(
      [
        'bots',
        'rotate-secret',
        'b_1',
        '--activate-at',
        '2026-10-16T11:00:00+02:00',
        '--key',
        'ck_t',
      ],
      factoryFor({ signingSecret: 'whsec_n', activatesAt: '2026-10-16T09:00:00.000Z' }, sent),
    );
    expect(code).toBe(0);
    expect(sent[0]?.path).toBe(PATH);
    expect(sent[0]?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent[0]?.rawBody).toBe('{"activateAt":"2026-10-16T11:00:00+02:00"}');
    expect(JSON.parse(out.join(''))).toEqual({
      signingSecret: 'whsec_n',
      activatesAt: '2026-10-16T09:00:00.000Z',
    });
    expect(err.join('')).toBe('');
  });

  it('--activate-at=… is the same request', async () => {
    const sent: Sent[] = [];
    await run(
      ['bots', 'rotate-secret', 'b_1', '--activate-at=2026-10-16T09:00:00Z', '--key', 'ck_t'],
      factoryFor({ signingSecret: 'whsec_n', activatesAt: '2026-10-16T09:00:00.000Z' }, sent),
    );
    expect(sent[0]?.rawBody).toBe('{"activateAt":"2026-10-16T09:00:00Z"}');
  });

  it('refuses a bare --activate-at before sending anything, rather than cutting over', async () => {
    const sent: Sent[] = [];
    await expect(
      run(
        ['bots', 'rotate-secret', 'b_1', '--activate-at', '--key', 'ck_t'],
        factoryFor({ signingSecret: 'whsec_n', activatesAt: null }, sent),
      ),
    ).rejects.toThrow(/--activate-at needs an ISO 8601 instant/);
    expect(sent).toHaveLength(0);
  });

  it('says on stderr when a requested window came back as a hard cut', async () => {
    const sent: Sent[] = [];
    await run(
      [
        'bots',
        'rotate-secret',
        'b_1',
        '--activate-at',
        '2020-01-01T00:00:00Z',
        '--key',
        'ck_t',
        '--json',
      ],
      factoryFor({ signingSecret: 'whsec_n', activatesAt: null }, sent),
    );
    expect(err.join('')).toMatch(/ALREADY signing/);
    // stdout stays the bare JSON, so `--json | jq` still works.
    expect(JSON.parse(out.join(''))).toEqual({ signingSecret: 'whsec_n', activatesAt: null });
  });
});
