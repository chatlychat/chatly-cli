/**
 * `chatly api-keys create` — asserted on what it SENDS.
 *
 * A fake client that echoes whatever the command asked for agrees with any
 * bug in the request, which is how four mobile SDKs shipped a realtime
 * handshake the server refuses (see
 * `docs/prompts/5/mobile-sdk-visitor-contract.md`). So every test here
 * inspects the recorded `request()` arguments: the method, the path, the body
 * and — the one that matters — the header, because the header is the whole
 * feature.
 */
import { describe, expect, it, vi } from 'vitest';

import { parseArgs } from '../args.js';
import { apiKeys } from './api-keys.js';

import type { ChatlyClient } from '@chatlychat/sdk-node';

const RECIPIENT = 'kiEs7OFzSd9nrps5NIaWShdEff2lvo5wmVrel671mn8=';

function client(answer: unknown) {
  const calls: Array<{ method: string; path: string; options: Record<string, unknown> }> = [];
  const request = vi.fn((method: string, path: string, options: Record<string, unknown> = {}) => {
    calls.push({ method, path, options });
    return Promise.resolve(answer);
  });
  return { calls, chatly: { request } as unknown as ChatlyClient };
}

const minted = {
  id: 'k_1',
  name: 'crossly-canvas-resolve',
  prefix: 'ck_live_abcd',
  scopes: ['messages:write'],
  expiresAt: null,
  token: 'ck_live_abcdefghijklmnop',
};

const run = (c: ChatlyClient, line: string) => apiKeys(c, parseArgs(line.split(' ')));

describe('chatly api-keys create', () => {
  it('posts the name and scopes, and sends NO recipient header when none is given', async () => {
    const h = client(minted);
    const code = await run(h.chatly, 'api-keys create --name probe --scope messages:write');
    expect(code).toBe(0);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.method).toBe('POST');
    expect(h.calls[0]?.path).toBe('/v1/api-keys');
    expect(h.calls[0]?.options.body).toEqual({ name: 'probe', scopes: ['messages:write'] });
    /*
     * Absent, not `{}` and not `{ 'x-secret-recipient': undefined }`. Sealing
     * is opt-in per request and an empty recipient must not reach the server:
     * `secretRecipient` refuses a malformed one with a 400, so a stray empty
     * header would turn an ordinary mint into a failure.
     */
    expect(h.calls[0]?.options).not.toHaveProperty('headers');
  });

  it('collects a repeated --scope and a comma list, trimming blanks', async () => {
    const h = client(minted);
    await run(h.chatly, 'api-keys create --name probe --scope a,b --scope c --scope  ');
    expect(h.calls[0]?.options.body).toEqual({ name: 'probe', scopes: ['a', 'b', 'c'] });
  });

  it('sends x-secret-recipient, prefixing a bare base64 key', async () => {
    const h = client({ ...minted, token: null, sealedSecret: 'blob', sealedScheme: 'v1' });
    const code = await run(
      h.chatly,
      `api-keys create --name probe --scope messages:write --recipient ${RECIPIENT}`,
    );
    expect(code).toBe(0);
    expect(h.calls[0]?.options.headers).toEqual({ 'x-secret-recipient': `x25519:${RECIPIENT}` });
  });

  it('does not double-prefix a key that already carries the scheme', async () => {
    const h = client({ ...minted, token: null, sealedSecret: 'blob', sealedScheme: 'v1' });
    await run(
      h.chatly,
      `api-keys create --name probe --scope messages:write --recipient x25519:${RECIPIENT}`,
    );
    expect(h.calls[0]?.options.headers).toEqual({ 'x-secret-recipient': `x25519:${RECIPIENT}` });
  });

  it('passes --expires-at through, and omits the field entirely without it', async () => {
    const h = client(minted);
    await run(h.chatly, 'api-keys create --name p --scope a --expires-at 2027-01-01T00:00:00.000Z');
    expect(h.calls[0]?.options.body).toMatchObject({ expiresAt: '2027-01-01T00:00:00.000Z' });
    const g = client(minted);
    await run(g.chatly, 'api-keys create --name p --scope a');
    expect(g.calls[0]?.options.body).not.toHaveProperty('expiresAt');
  });

  it('refuses to call the server at all without a name or a scope', async () => {
    const h = client(minted);
    expect(await run(h.chatly, 'api-keys create --scope messages:write')).toBe(2);
    expect(await run(h.chatly, 'api-keys create --name probe')).toBe(2);
    // The point of checking first: a 422 from the server is a round trip that
    // tells the reader less than the usage text does.
    expect(h.calls).toHaveLength(0);
  });

  it('exits 1 and says the key is unrecoverable when neither half comes back', async () => {
    /*
     * Unreachable through `deliverSecret`, which returns a token or a blob.
     * Asserted because the alternative — printing the header rows and exiting
     * 0 — would report success for a live credential nobody can use.
     */
    const h = client({ ...minted, token: null });
    expect(await run(h.chatly, 'api-keys create --name p --scope a')).toBe(1);
  });

  it('prints usage for a bare `api-keys` and exits 2 on an unknown subcommand', async () => {
    const h = client(minted);
    expect(await run(h.chatly, 'api-keys')).toBe(0);
    expect(await run(h.chatly, 'api-keys delete')).toBe(2);
    expect(h.calls).toHaveLength(0);
  });
});
