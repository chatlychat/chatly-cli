/**
 * `chatly doctor --token <jwt>` — does a REAL minted token address this
 * channel? (CH-09, FormFlow, 2026-11-13.)
 *
 * ═══ WHAT THE CONTRACT CHECKS COULD NOT SEE ═══════════════════════════════
 *
 * `GET /v1/channels/{id}/identity-contract` grades the CHANNEL against
 * itself: the audience it expects, whether that audience is derived or
 * copied, whether its issuers resolve. Every one of those can be green while
 * the identity provider stamps something else — the template on the Atlas
 * side is written by hand, in another tool, and nothing in Chatly has ever
 * seen its output. FormFlow's words for the gap: there is no "validation-only
 * check of the derived values", and the symptom when it is wrong is a visitor
 * who is silently anonymous.
 *
 * So: paste a token, compare it against the contract, and say `audience
 * mismatch` before a visitor does.
 *
 * ═══ VALIDATION-ONLY, WHICH IS A PROMISE ABOUT THREE THINGS ═══════════════
 *
 *   1. No network. This reads the token's own bytes and the contract body
 *      `doctor` has already fetched. Nothing is dialled, discovered or
 *      POSTed.
 *   2. No signature verification, and the detail SAYS SO on every row. The
 *      key set is not here and fetching it would break (1); a green row means
 *      "addressed to this channel", never "valid". Reading a pass as a
 *      verification is the one way this check could mislead, so it is written
 *      out rather than implied.
 *   3. No token, no rows. The check is skipped entirely rather than printed
 *      as a SKIP on every flagless run — the same judgement `csp.site` makes
 *      about `--origin`, and for the same reason: a line that says "not
 *      checked" on every run is the line people learn to skim past.
 *
 * ═══ WHY `aud` AND `iss`, AND NOT A THIRD THING ═══════════════════════════
 *
 * These are the two values the verifier compares by EXACT STRING EQUALITY,
 * which makes them the two that drift silently. `aud` carries the channel's
 * public id, so it goes stale the moment a channel is re-created. `iss` is
 * the path-mounted trap: an Atlas at `https://formize.net/atlas` must stamp
 * the whole path, and a token from the same deployment stamping
 * `https://formize.net` — or the same string with a trailing slash — fails
 * against a channel that looks perfectly configured. Neither is a secret and
 * neither is logged anywhere else; nothing else in the token is read.
 *
 * ═══ THE CREDENTIAL IS NAMED IN THE REFUSAL ═══════════════════════════════
 *
 * This repo has already paid for a refusal that named no credential: every
 * mobile SDK could not connect because `handshakeAuthSchema`'s `kind`
 * defaults to AGENT, so a visitor's token was verified as an agent's and
 * refused with a bare `Unauthorized`. A token with no `aud` at all is almost
 * always the WRONG KIND of token — an Atlas session token rather than the
 * integration token `getToken({ for: 'chatly' })` mints — so that case says
 * which credential it was handed and which one it wanted, instead of
 * reporting a mismatch against an empty list.
 */
import type { DoctorCheck } from './doctor-checks.js';

/** Where the token comes from when `--token` is not passed. */
export const VISITOR_TOKEN_ENV = 'CHATLY_VISITOR_TOKEN';

/** The three claims read, and nothing else. `aud` normalised to a list. */
export interface TokenClaims {
  readonly audiences: readonly string[];
  readonly issuer: string | null;
  /** Atlas's own hint: `template` is the integration token, `session` is not. */
  readonly tokenUse: string | null;
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

const strings = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).flatMap((v) => {
    const s = text(v);
    return s === null ? [] : [s];
  });

/**
 * A compact JWS's payload claims, or `null` when the value is not one.
 *
 * NOT a verification: the signature is neither checked nor parsed, and the
 * header is skipped entirely. Five segments (a JWE) answers `null` too — the
 * payload is encrypted, so there is nothing to read without the key.
 */
export function decodeJwtClaims(token: string): TokenClaims | null {
  const parts = token.trim().split('.');
  if (parts.length !== 3) {
    return null;
  }
  const payload = parts[1];
  if (payload === undefined || payload === '') {
    return null;
  }
  let claims: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    claims = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  return {
    audiences: strings(claims['aud']),
    issuer: text(claims['iss']),
    tokenUse: text(claims['token_use']),
  };
}

const NOT_VERIFIED =
  'This compares the token’s claims with the channel’s contract and does NOT verify its ' +
  'signature or expiry — a pass means the token is addressed to this channel, not that it is ' +
  'valid.';

const FIX_AUD =
  'Set the integration’s `audience` in your identity provider to the `audience` this channel ' +
  'publishes (`chatly api GET /v1/channels/{id}/identity-contract`). On Atlas that is ' +
  '`PUT /v1/instance/integrations/chatly`, and the widget must ask for that integration by ' +
  'name: `getToken({ for: "chatly" })`.';

/**
 * The token rows for one channel, given the contract body `doctor` read.
 *
 * `token` undefined → no rows at all. Pure; never throws.
 */
export function tokenContractChecks(
  body: Record<string, unknown>,
  token: string | undefined,
  label: string,
): DoctorCheck[] {
  if (token === undefined || token.trim() === '') {
    return [];
  }
  const claims = decodeJwtClaims(token);
  if (claims === null) {
    return [
      {
        name: `identity.token_audience (${label})`,
        // FAIL rather than SKIP: the operator passed a value on purpose, and
        // a typo'd credential reported as "could not look" is the shape of
        // defect this whole command was filed for.
        verdict: 'fail',
        detail:
          'The value passed as the visitor token is not a readable JWT (three dot-separated ' +
          'base64url segments), so nothing in it could be compared with this channel. Its ' +
          'contents are not printed.',
        fix:
          `Pass the token a page actually mints — \`--token\` or $${VISITOR_TOKEN_ENV}. On ` +
          'Atlas: `await atlas.session.getToken({ for: "chatly" })`.',
      },
    ];
  }
  const expected = text(body['audience']);
  const out: DoctorCheck[] = [];
  if (expected !== null) {
    const matches = claims.audiences.includes(expected);
    out.push({
      name: `identity.token_audience (${label})`,
      verdict: matches ? 'pass' : 'fail',
      detail: matches
        ? `The token’s \`aud\` names \`${expected}\`, which is this channel’s audience. ${NOT_VERIFIED}`
        : claims.audiences.length === 0
          ? // The wrong KIND of credential, named as such — see the header.
            'audience mismatch: the token carries no `aud` claim at all, so it can never be ' +
            `addressed to this channel (\`${expected}\`). A token with no audience is usually a ` +
            'SESSION token rather than the integration token Chatly needs' +
            (claims.tokenUse === null
              ? ''
              : ` (this one says \`token_use: "${claims.tokenUse}"\`)`) +
            `. ${NOT_VERIFIED}`
          : `audience mismatch: the token’s \`aud\` is ${JSON.stringify(claims.audiences)} and ` +
            `this channel expects \`${expected}\`. Every token from this template is refused ` +
            `and the visitor stays anonymous. ${NOT_VERIFIED}`,
      fix: matches ? null : FIX_AUD,
    });
  }
  /*
   * The issuer half. Skipped rather than failed when the contract resolved no
   * issuer: `identity.issuer_resolved` already says so, and two rows about
   * one missing configuration is the noise this file's header argues against.
   */
  const issuers = (Array.isArray(body['issuers']) ? body['issuers'] : []).flatMap(
    (entry: unknown) => {
      const found =
        typeof entry === 'object' && entry !== null && !Array.isArray(entry)
          ? text((entry as Record<string, unknown>)['issuer'])
          : null;
      return found === null ? [] : [found];
    },
  );
  if (issuers.length > 0 && claims.issuer !== null) {
    const matches = issuers.includes(claims.issuer);
    out.push({
      name: `identity.token_issuer (${label})`,
      verdict: matches ? 'pass' : 'fail',
      detail: matches
        ? `The token’s \`iss\` is \`${claims.issuer}\`, which this channel trusts. ${NOT_VERIFIED}`
        : `issuer mismatch: the token’s \`iss\` is \`${claims.issuer}\` and this channel trusts ` +
          `${JSON.stringify(issuers)}. \`iss\` is compared by EXACT string equality, so a ` +
          'trailing slash, or an identity provider mounted under a path answering with only ' +
          `its host, is refused like any other issuer. ${NOT_VERIFIED}`,
      fix: matches
        ? null
        : 'Make the two equal as strings. Where the provider’s issuer is the authority, set ' +
          '`identityVerification.atlasInstance` to the instance URL exactly as the token ' +
          'stamps it — path and all — and Chatly derives the issuer, the key set and the ' +
          'audience from it.',
    });
  }
  return out;
}
