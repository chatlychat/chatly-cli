/**
 * `chatly doctor --token <jwt>` (CH-09, FormFlow, 2026-11-13).
 *
 * FormFlow's remaining words were "no validation-only check of the derived
 * values for a path-mounted Atlas (https://formize.net/atlas)", so the
 * path-mounted issuer is the one every case here is built on: it is the shape
 * whose `iss` carries a PATH, and the one an identity provider most easily
 * stamps without it.
 *
 * Tokens below are built by `jwt()` from claims, never pasted, so nothing
 * here is a fixture whose shape somebody invented — and nothing here is a
 * real credential. The signature segment is the literal word `unverified`,
 * which is also the assertion that this code never looks at it.
 *
 * Every `CONTROL:` note is the edit that makes that test, and only that test,
 * fail, with the message it fails with.
 */
import { describe, expect, it } from 'vitest';

import { HEALTHY, channelRow, depsFor, stubFetch, type Sent } from './__tests__/doctor-fixtures.js';
import { runChecks, selectChannels, exitCodeFor } from './doctor-checks.js';
import { decodeJwtClaims, tokenContractChecks } from './doctor-token-audience.js';

const ISSUER = 'https://formize.net/atlas';
const AUDIENCE = 'chatly:web_live_1';

/** A compact JWS whose payload is these claims. The signature is a word. */
const jwt = (claims: Record<string, unknown>): string =>
  [
    Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    'unverified',
  ].join('.');

/** The contract body for a channel on a path-mounted Atlas, as the route answers it. */
const contract = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  channelId: 'ch_1',
  publicId: 'web_live_1',
  audience: AUDIENCE,
  issuers: [{ issuer: ISSUER, jwksUri: null, audiences: [AUDIENCE] }],
  checks: [{ id: 'audience_derived', ok: true, detail: '`atlasInstance` is set.' }],
  ...over,
});

const rows = (body: Record<string, unknown>, token: string | undefined) =>
  tokenContractChecks(body, token, 'web_live_1');

const row = (body: Record<string, unknown>, token: string | undefined, prefix: string) => {
  const found = rows(body, token).find((c) => c.name.startsWith(prefix));
  if (found === undefined) {
    throw new Error(
      `no ${prefix} row in ${
        rows(body, token)
          .map((c) => c.name)
          .join(', ') || '(none)'
      }`,
    );
  }
  return found;
};

describe('decodeJwtClaims', () => {
  it('reads `aud`, `iss` and `token_use`, with a single `aud` as a list', () => {
    expect(decodeJwtClaims(jwt({ aud: AUDIENCE, iss: ISSUER, token_use: 'template' }))).toEqual({
      audiences: [AUDIENCE],
      issuer: ISSUER,
      tokenUse: 'template',
    });
  });

  it('reads a multi-valued `aud`, which is a supported shape', () => {
    expect(decodeJwtClaims(jwt({ aud: ['other', AUDIENCE] }))?.audiences).toEqual([
      'other',
      AUDIENCE,
    ]);
  });

  /*
   * Not a JWS: a bare opaque token, a payload that is not JSON, a payload
   * that is JSON but not an object, and a FIVE-segment JWE.
   *
   * The JWE is the one that needs the segment count. Its second segment is
   * the encrypted key, not the claims — so a reader that goes by position
   * alone would read whatever that happens to decode to and report it as the
   * token's audience. Built here with a real claims object in that slot, so
   * the only thing refusing it is the count.
   *
   * CONTROL: drop the `parts.length !== 3` guard and this fails with
   *   `expected { audiences: [ 'chatly:web_live_1' ], … } to be null`
   * — which is a confident answer about a token nobody can read.
   */
  it('answers null for anything that is not a readable compact JWS', () => {
    const claims = Buffer.from(JSON.stringify({ aud: AUDIENCE })).toString('base64url');
    expect(decodeJwtClaims('not-a-token')).toBeNull();
    expect(decodeJwtClaims(`head.${claims}.iv.ciphertext.tag`)).toBeNull();
    expect(decodeJwtClaims(`x.${Buffer.from('nope').toString('base64url')}.y`)).toBeNull();
    expect(decodeJwtClaims(`x.${Buffer.from('[1,2]').toString('base64url')}.y`)).toBeNull();
  });
});

describe('the token rows', () => {
  /* No token, no rows — the whole of "validation-only". */
  it('prints nothing at all when no token was supplied', () => {
    expect(rows(contract(), undefined)).toEqual([]);
    expect(rows(contract(), '  ')).toEqual([]);
  });

  it('passes a token addressed to this channel by a path-mounted issuer', () => {
    const out = rows(contract(), jwt({ aud: AUDIENCE, iss: ISSUER }));
    expect(out.map((c) => c.verdict)).toEqual(['pass', 'pass']);
    // A pass must never read as a verification.
    expect(out[0]?.detail).toContain('does NOT verify its signature');
  });

  /*
   * The headline FormFlow asked for, in their words: "says `audience
   * mismatch` before a visitor does". This is the re-created-channel trap
   * seen from the provider's side — the only side that can see it.
   *
   * CONTROL: change `claims.audiences.includes(expected)` to
   * `claims.audiences.length > 0` and this fails with
   *   `expected 'pass' to be 'fail'`.
   */
  it('FAILS with `audience mismatch` on a token addressed to the old public id', () => {
    const c = row(
      contract(),
      jwt({ aud: 'chatly:web_live_old', iss: ISSUER }),
      'identity.token_audience',
    );
    expect(c.verdict).toBe('fail');
    expect(c.detail).toContain('audience mismatch');
    expect(c.detail).toContain('chatly:web_live_old');
    expect(c.detail).toContain(AUDIENCE);
    expect(c.fix).toContain('getToken({ for: "chatly" })');
  });

  /*
   * The wrong KIND of credential, named as such. A session token carries no
   * `aud`, and reporting that as a mismatch against `[]` is the bare
   * `Unauthorized` this repo has already paid for once.
   *
   * CONTROL: delete the `claims.audiences.length === 0` arm and the detail
   * becomes `the token’s \`aud\` is [] and this channel expects …`, so this
   * fails with `expected '…' to contain 'SESSION token'`.
   */
  it('names the credential when the token carries no `aud` at all', () => {
    const c = row(
      contract(),
      jwt({ iss: ISSUER, token_use: 'session' }),
      'identity.token_audience',
    );
    expect(c.verdict).toBe('fail');
    expect(c.detail).toContain('SESSION token');
    expect(c.detail).toContain('token_use: "session"');
  });

  /*
   * The path-mounted trap itself: the same deployment, stamping only its
   * host. `iss` is compared by exact string equality, so this is refused —
   * and it is the single most likely misconfiguration for an Atlas mounted
   * under a path.
   *
   * CONTROL: compare on `new URL(iss).origin` instead of the string and this
   * fails with `expected 'pass' to be 'fail'`.
   */
  it('FAILS on an issuer that drops the mount path', () => {
    const c = row(
      contract(),
      jwt({ aud: AUDIENCE, iss: 'https://formize.net' }),
      'identity.token_issuer',
    );
    expect(c.verdict).toBe('fail');
    expect(c.detail).toContain('issuer mismatch');
    expect(c.detail).toContain('https://formize.net');
  });

  /* …and a trailing slash, which is the same fault and reads as identical. */
  it('FAILS on an issuer that differs only by a trailing slash', () => {
    expect(
      row(contract(), jwt({ aud: AUDIENCE, iss: `${ISSUER}/` }), 'identity.token_issuer').verdict,
    ).toBe('fail');
  });

  /* A channel that resolves no issuer is already a failed contract row. */
  it('says nothing about the issuer when the contract resolved none', () => {
    const out = rows(contract({ issuers: [] }), jwt({ aud: AUDIENCE, iss: ISSUER }));
    expect(out.map((c) => c.name)).toEqual(['identity.token_audience (web_live_1)']);
  });

  /*
   * A value the operator passed on purpose that is not a token: FAIL, not
   * SKIP, and the value is never printed back.
   *
   * CONTROL: make this arm `verdict: 'skip'` and this fails with
   *   `expected 'skip' to be 'fail'` — a typo'd credential counted among the
   * checks nobody made.
   */
  it('FAILS, and echoes nothing, on a value that is not a token', () => {
    const c = row(contract(), 'eyJhbGciOi-truncated', 'identity.token_audience');
    expect(c.verdict).toBe('fail');
    expect(c.detail).not.toContain('eyJhbGciOi-truncated');
    expect(c.fix).toContain('CHATLY_VISITOR_TOKEN');
  });
});

describe('through `chatly doctor`', () => {
  const channel = channelRow({
    config: {
      allowedOrigins: ['https://example.com'],
      identityVerification: { enabled: true, atlasInstance: ISSUER },
    },
  });

  /*
   * The acceptance criterion end to end: the command exits 1 on a real
   * token addressed to the wrong channel, having fetched the contract once.
   *
   * CONTROL: drop `visitorToken` from the `runChecks` options and the row is
   * absent, so `pick` throws `no identity.token_audience row`.
   */
  it('fails the run on a mismatched token, from one contract read', async () => {
    const sent: Sent[] = [];
    let reads = 0;
    const all = await runChecks(
      selectChannels([channel], undefined),
      { visitorToken: jwt({ aud: 'chatly:web_live_old', iss: ISSUER }) },
      depsFor(stubFetch(HEALTHY, sent), {
        identityContract: async () => {
          reads += 1;
          return contract();
        },
      }),
    );
    const c = all.find((x) => x.name.startsWith('identity.token_audience'));
    expect(c?.verdict).toBe('fail');
    expect(reads).toBe(1);
    expect(exitCodeFor(all)).toBe(1);
  });

  /*
   * A contract body that grades nothing still carries `audience` and
   * `issuers`, so the check the operator explicitly asked for must survive
   * it. `identityContractChecks` used to return early on an empty `checks`
   * array, which would have dropped the token rows on any deployment whose
   * contract route answers no verdicts.
   *
   * CONTROL: restore that early `return [ … skip … ]` in
   * `doctor-readiness.ts` and this fails with
   *   `expected undefined to be 'fail'`.
   */
  it('still compares the token when the contract grades nothing', async () => {
    const all = await runChecks(
      selectChannels([channel], undefined),
      { visitorToken: jwt({ aud: 'chatly:web_live_old', iss: ISSUER }) },
      depsFor(stubFetch(HEALTHY, []), {
        identityContract: async () => ({ audience: AUDIENCE, issuers: [] }),
      }),
    );
    expect(all.find((c) => c.name.startsWith('identity.token_audience'))?.verdict).toBe('fail');
    expect(all.find((c) => c.name.startsWith('identity.contract'))?.verdict).toBe('skip');
  });

  /* And with no token the rows are simply not there, on the same channel. */
  it('prints no token rows on a flagless run', async () => {
    const all = await runChecks(
      selectChannels([channel], undefined),
      {},
      depsFor(stubFetch(HEALTHY, []), { identityContract: async () => contract() }),
    );
    expect(all.some((c) => c.name.startsWith('identity.token_'))).toBe(false);
    expect(exitCodeFor(all)).toBe(0);
  });
});
