/**
 * `chatly channels brand` (CHT-SI14) and `chatly webhooks deliveries --trace`
 * (CHT-SI13), driven through the real parser, the real `ChatlyClient` and the
 * real transport with only the socket faked — and asserted on what was SENT:
 * method, URL, query and body.
 */
import { ChatlyClient } from '@chatlychat/sdk-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { run } from '../run.js';

interface Sent {
  readonly method: string;
  readonly url: URL;
  readonly body: unknown;
}

function factoryFor(body: string, sent: Sent[]) {
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const raw = typeof init?.body === 'string' ? init.body : undefined;
    sent.push({
      method: init?.method ?? 'GET',
      url: new URL(String(url)),
      body: raw === undefined ? undefined : (JSON.parse(raw) as unknown),
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return (opts: { apiKey: string; apiUrl?: string }) =>
    new ChatlyClient({ ...opts, fetchFn, sleepFn: async () => undefined, retry: { attempts: 1 } });
}

let out: string[] = [];
beforeEach(() => {
  out = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const TRACE = '01JBQ3V4Z8K2M5N7P9R1S3T5V7';

describe('chatly webhooks deliveries', () => {
  it('forwards --trace, --endpoint and --status as the route’s own query names', async () => {
    const sent: Sent[] = [];
    await run(
      [
        'webhooks',
        'deliveries',
        '--key',
        'ck_test',
        '--trace',
        TRACE,
        '--endpoint',
        'ep-1',
        '--status',
        'failed',
      ],
      factoryFor('{"items":[],"nextCursor":null,"hasMore":false}', sent),
    );
    expect(sent[0]?.method).toBe('GET');
    expect(sent[0]?.url.pathname).toBe('/v1/webhooks/deliveries');
    expect(sent[0]?.url.searchParams.get('trace')).toBe(TRACE);
    expect(sent[0]?.url.searchParams.get('endpointId')).toBe('ep-1');
    expect(sent[0]?.url.searchParams.get('status')).toBe('failed');
  });

  it('renders the fields the API actually sends, trace included', async () => {
    const page = {
      items: [
        {
          id: 'd1',
          eventType: 'conversation.created',
          status: 'delivered',
          httpStatus: 204,
          attempt: 0,
          trace: TRACE,
          createdAt: '2026-10-25T10:00:00.000Z',
        },
      ],
      nextCursor: null,
      hasMore: false,
    };
    await run(['webhooks', 'deliveries', '--key', 'ck_test'], factoryFor(JSON.stringify(page), []));
    const printed = out.join('');
    expect(printed).toContain('conversation.created');
    expect(printed).toContain('204');
    expect(printed).toContain(TRACE);
  });
});

describe('chatly channels brand', () => {
  it('--url PUTs { brandUrl } to the channel’s brand route', async () => {
    const sent: Sent[] = [];
    await run(
      ['channels', 'brand', 'ch_1', '--key', 'ck_test', '--url', 'https://r.test/brand.json'],
      factoryFor('{"configured":true}', sent),
    );
    expect(sent[0]?.method).toBe('PUT');
    expect(sent[0]?.url.pathname).toBe('/v1/channels/ch_1/brand');
    expect(sent[0]?.body).toEqual({ brandUrl: 'https://r.test/brand.json' });
  });

  it('--body PUTs the document wrapped as { brand }', async () => {
    const sent: Sent[] = [];
    const doc = { color: { accent: { $value: '#0e9f6e' } } };
    await run(
      ['channels', 'brand', 'ch_1', '--key', 'ck_test', '--body', JSON.stringify(doc)],
      factoryFor('{"configured":true}', sent),
    );
    expect(sent[0]?.method).toBe('PUT');
    expect(sent[0]?.body).toEqual({ brand: doc });
  });

  it('with neither, GETs the read-back', async () => {
    const sent: Sent[] = [];
    await run(
      ['channels', 'brand', 'ch_1', '--key', 'ck_test'],
      factoryFor('{"configured":false}', sent),
    );
    expect(sent[0]?.method).toBe('GET');
    expect(sent[0]?.url.pathname).toBe('/v1/channels/ch_1/brand');
  });

  it('refuses --url and a document together without sending anything', async () => {
    const sent: Sent[] = [];
    const code = await run(
      [
        'channels',
        'brand',
        'ch_1',
        '--key',
        'ck_test',
        '--url',
        'https://r.test/b',
        '--body',
        '{}',
      ],
      factoryFor('{}', sent),
    ).catch(() => 1);
    expect(code).not.toBe(0);
    expect(sent).toHaveLength(0);
  });
});
