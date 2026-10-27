/**
 * `chatly api-keys create` — the automatable step sealed delivery never had.
 *
 * ═══ THE GAP THIS CLOSES ══════════════════════════════════════════════════
 *
 * `commands/secret.ts` shipped `secret keypair` and `secret open`: generate a
 * keypair, and open a blob sealed to it. Both are automation tools, and there
 * was **no automatable step between them.** `POST /v1/api-keys` carried no
 * `@AllowApiKey()`, so the only thing that could mint — and therefore the
 * only thing that could drive `x-secret-recipient` — was a browser.
 *
 * That made the documented safe path end in a hand-written `curl` whose
 * credential the docs could not explain how to obtain, and it is why the
 * practical advice an integrator got was still "paste a live key into a
 * message". A security mechanism reachable only by hand is a security
 * mechanism nobody uses.
 *
 * The route opened on 2026-10-26. See `api-keys.controller.ts` for the
 * argument, which is worth reading before changing anything here: the guard
 * was enforcing a property — a read-only key must not mint a write-scoped
 * one — that `ungrantablePermissions` already enforced more precisely, by
 * refusing any scope the CALLING key does not hold itself.
 *
 * ═══ WHAT THAT MEANS FOR WHOEVER RUNS THIS ════════════════════════════════
 *
 * The minting key needs `workspace:write` AND every scope it is conferring.
 * So the first key in a workspace still comes from a dashboard session —
 * a key can only ever confer what it holds, which is the floor of the model
 * rather than a gap in it. After that, minting is scriptable for ever.
 *
 * A 403 here names the scopes that were refused, so the fix is one round
 * trip: grant them to the minting key, or stop asking for them.
 */
import { bool, str, type ParsedArgs } from '../args.js';
import { printJson } from '../output.js';

import type { ChatlyClient } from '@chatlychat/sdk-node';

/** Every value of a repeated flag, with `--scopes a,b` accepted as well. */
function many(flags: ParsedArgs['flags'], name: string): string[] {
  const v = flags[name];
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  return raw
    .flatMap((s) => s.split(','))
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

interface Created {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: ReadonlyArray<string>;
  readonly expiresAt: string | null;
  /** `null` when the secret was sealed — the plaintext never existed here. */
  readonly token: string | null;
  readonly sealedSecret?: string;
  readonly sealedScheme?: string;
}

const USAGE = `chatly api-keys create --name <name> --scope <scope> [--scope <scope> …]

  --name <name>            What the key is for. Shown in the dashboard.
  --scope <permission>     Repeatable, or --scope a,b. The minting key must
                           hold every one of these itself.
  --recipient <publicKey>  Seal the secret to an X25519 public key
                           (\`x25519:<base64>\`, from \`chatly secret keypair\`).
                           The response then carries no plaintext at all.
  --expires-at <iso8601>   Optional expiry. Must be in the future.
  --json                   The raw response.

Minting needs a key with \`workspace:write\`. The secret is shown ONCE.
Open a sealed one with:
  chatly secret open --sealed <blob> --key-file <path>
`;

export async function apiKeys(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const sub = args.path[1];
  if (sub !== 'create') {
    process.stdout.write(USAGE);
    // An unrecognised subcommand is a usage error; a bare `api-keys` is help.
    return sub === undefined ? 0 : 2;
  }

  const name = str(args.flags, 'name');
  const scopes = many(args.flags, 'scope');
  if (name === undefined || scopes.length === 0) {
    process.stderr.write('Both --name and at least one --scope are required.\n\n');
    process.stderr.write(USAGE);
    return 2;
  }

  /*
   * Normalised the same way the dashboard does, so a pasted bare base64 key
   * works. The server refuses a malformed recipient BEFORE minting — see
   * `sealed-token.ts` — which is the behaviour that makes this safe to get
   * wrong: a bad header is a 400, never a live key nobody holds.
   */
  const given = str(args.flags, 'recipient');
  const recipient =
    given === undefined ? undefined : given.startsWith('x25519:') ? given : `x25519:${given}`;
  const expiresAt = str(args.flags, 'expires-at');

  const created = await chatly.request<Created>('POST', '/v1/api-keys', {
    body: { name, scopes, ...(expiresAt === undefined ? {} : { expiresAt }) },
    ...(recipient === undefined ? {} : { headers: { 'x-secret-recipient': recipient } }),
  });

  if (bool(args.flags, 'json')) {
    printJson(created);
    return 0;
  }

  process.stdout.write(`id       ${created.id}\n`);
  process.stdout.write(`name     ${created.name}\n`);
  process.stdout.write(`scopes   ${created.scopes.join(', ')}\n`);
  process.stdout.write(`expires  ${created.expiresAt ?? 'never'}\n`);

  if (created.sealedSecret !== undefined) {
    process.stdout.write(
      `\nSealed with ${created.sealedScheme ?? 'an unnamed scheme'}. Safe to send anywhere —\n` +
        'only the matching private key opens it:\n\n' +
        `${created.sealedSecret}\n\n` +
        'The recipient runs:\n' +
        '  chatly secret open --sealed <blob> --key-file <their private key>\n',
    );
    return 0;
  }

  if (created.token === null) {
    /*
     * Neither a token nor a blob. Unreachable today — `deliverSecret` returns
     * one or the other — but a silent success here would be a key nobody
     * holds, which is the exact failure the sealed path exists to avoid.
     */
    process.stderr.write(
      '\nThe server returned neither a token nor a sealed secret. The key EXISTS\n' +
        `and its secret is unrecoverable — revoke it: DELETE /v1/api-keys/${created.id}\n`,
    );
    return 1;
  }

  process.stdout.write(`\nShown once, not stored anywhere:\n\n${created.token}\n`);
  return 0;
}
