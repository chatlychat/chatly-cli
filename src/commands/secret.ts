/**
 * `chatly secret …` — the half of sealed delivery that was never shipped.
 *
 * ═══ THE GAP THIS CLOSES ══════════════════════════════════════════════════
 *
 * `POST /v1/api-keys` (and the other shown-once minters) accept an
 * `X-Secret-Recipient: x25519:<base64>` header and answer with `token: null`
 * plus a `sealedSecret` only the holder of the matching private key can open.
 * `api-rest.mdx` documents the format down to the byte layout, and
 * `apps/api/src/common/crypto/sealed-token.ts` argues at length for why a
 * malformed recipient is a 400 before anything is minted.
 *
 * **Nothing that ships could open one.** A sweep of all eleven published
 * packages and this CLI found exactly one mention outside the server: a line
 * in `integrations.ts` that PRINTS the blob. So the documented safe path
 * ended with "now implement HKDF-SHA256 over X25519 and ChaCha20-Poly1305
 * yourself", and the practical advice an integrator got instead was to paste
 * a live key into a message — which is the thing the whole mechanism exists
 * to avoid. A feature accepted, documented and unusable is the shape this
 * repo keeps finding late; here it was found by being asked for a key in a
 * chat message and having nothing better to offer.
 *
 * ═══ WHY IT IS IN THE CLI AND NOT AN SDK ══════════════════════════════════
 *
 * Because of who runs it. Sealing has two sides and they are DIFFERENT
 * people: the integrator generates a keypair and keeps the private half, and
 * the operator mints with the public half. Minting needs `workspace:write`,
 * which is deliberately more than an API key carries, so the integrator
 * cannot do it and the operator must not hold their private key. What
 * crosses between them is a public key and a sealed blob — both safe in any
 * channel, which is the entire point.
 *
 * The CLI is what both sides already run (`npx @chatlychat/cli`), and this is
 * a once-per-credential command while filling in somebody's form — the same
 * argument `privacy executor-key` makes for itself.
 *
 * ═══ WHY THE CRYPTO IS RESTATED HERE ══════════════════════════════════════
 *
 * `@livechat/shared` is `private: true` and this package is published;
 * `listen-core.ts` carries the same note. So the opener is written against
 * node's built-ins with no dependency, and `secret.spec.ts` seals with the
 * REAL `sealSecret` from `@livechat/shared` (a test-only import the mirror
 * generator drops) and asserts this opens it. That round trip is the only
 * thing that can keep the two halves in step — the format is versioned, so a
 * drift would otherwise surface as an integrator's blob failing to open with
 * no clue which side moved.
 */
import {
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
} from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { ParsedArgs } from '../args.js';

/** Must match `SEALED_SCHEME` in `@livechat/shared/crypto/sealed-secret`. */
const SCHEME = 'x25519-hkdf-sha256-chacha20poly1305/v1';
const KEY_LEN = 32;
const NONCE_LEN = 12;
const TAG_LEN = 16;

/** DER prefix for a raw X25519 public key, so 32 bytes become a `KeyObject`. */
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
/** DER prefix for a raw X25519 private key. */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

function publicFromRaw(raw: Buffer): KeyObject {
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

function rawPublic(key: KeyObject): Buffer {
  return key.export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length);
}

/**
 * The same derivation as `deriveKey` in the sealer: HKDF-SHA256 over the
 * Diffie-Hellman output, a 32-byte zero salt, and BOTH public keys in the
 * info alongside the scheme string.
 *
 * The scheme is in the info AND used as the AEAD's additional data, so a blob
 * cannot be presented beside a different `sealedScheme` than it was built
 * with. Getting either wrong produces an authentication failure and not a
 * wrong plaintext, which is why the error below can say what it says.
 */
function deriveKey(shared: Buffer, ephemeral: Buffer, recipient: Buffer): Buffer {
  const info = Buffer.concat([Buffer.from(SCHEME), ephemeral, recipient]);
  return Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(32), info, KEY_LEN));
}

/**
 * Open a `sealedSecret`. Throws with a reason a human can act on.
 *
 * Exported for the spec, which is the only other caller.
 */
export function unsealSecret(sealed: string, privateKeyPem: string): string {
  const blob = Buffer.from(sealed, 'base64');
  if (blob.length < KEY_LEN + NONCE_LEN + TAG_LEN) {
    throw new Error(
      `that sealedSecret is ${String(blob.length)} bytes, and the smallest possible one is ` +
        `${String(KEY_LEN + NONCE_LEN + TAG_LEN)}. It is truncated, or it is not base64 of a sealed blob.`,
    );
  }
  const ephRaw = blob.subarray(0, KEY_LEN);
  const nonce = blob.subarray(KEY_LEN, KEY_LEN + NONCE_LEN);
  const body = blob.subarray(KEY_LEN + NONCE_LEN, blob.length - TAG_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);

  const privateKey = privateKeyFromPem(privateKeyPem);
  const shared = diffieHellman({ privateKey, publicKey: publicFromRaw(ephRaw) });
  const key = deriveKey(shared, ephRaw, rawPublic(publicFromPrivate(privateKey)));

  const decipher = createDecipheriv('chacha20-poly1305', key, nonce, {
    authTagLength: TAG_LEN,
  });
  decipher.setAAD(Buffer.from(SCHEME), { plaintextLength: body.length });
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    /*
     * ChaCha20-Poly1305 cannot tell WHICH input was wrong — a bad key, a
     * tampered body and a mismatched scheme all fail the same tag check. So
     * this lists the possibilities instead of guessing one, because the usual
     * cause is the mundane first item.
     */
    throw new Error(
      'that sealedSecret did not open with this private key. Either it was sealed to a ' +
        'different public key, the blob was altered or truncated in transit, or it was ' +
        `sealed under a scheme other than ${SCHEME} — check the sealedScheme field.`,
    );
  }
}

/** Parse the PEM, refusing a key of the wrong curve with a usable message. */
function privateKeyFromPem(pem: string): KeyObject {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'x25519') {
    throw new Error(
      `that private key is ${String(key.asymmetricKeyType)}, not x25519. Generate one with ` +
        '`chatly secret keypair`.',
    );
  }
  return key;
}

function publicFromPrivate(privateKey: KeyObject): KeyObject {
  return createPublicKey(privateKey);
}

/**
 * Takes no `ChatlyClient`, and is dispatched before one is built.
 *
 * Both subcommands are local crypto: `keypair` generates, `open` decrypts.
 * Neither touches the API, so requiring a credential would have been a real
 * barrier for the person most likely to run this — the INTEGRATOR, who by
 * definition does not have the key yet, because opening the sealed blob is
 * how they get it. Caught by running the built binary rather than the unit:
 * `resolveCredentials` throws before dispatch for everything in `COMMANDS`,
 * so the first real invocation answered "No API key".
 *
 * Same shape as `login` and `logout` for the same reason, and listed in
 * `NOT_IN_TABLE` in `cli.spec.ts` beside them.
 */
export async function secret(args: ParsedArgs): Promise<number> {
  const sub = args.path[1] ?? 'help';
  switch (sub) {
    case 'keypair': {
      const { publicKey, privateKey } = generateKeyPairSync('x25519');
      const pub = rawPublic(publicKey).toString('base64');
      const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
      if (args.flags['json'] === true) {
        process.stdout.write(
          `${JSON.stringify({ recipient: `x25519:${pub}`, publicKey: pub, privateKeyPem: pem }, null, 2)}\n`,
        );
        return 0;
      }
      /*
       * The private key goes to stdout and nowhere else — not a file. A
       * command that wrote `~/.chatly/secret.key` would be deciding where
       * somebody's long-lived private key lives, and the honest answer is
       * that only they know (a password manager, a CI secret, an HSM). The
       * public half is printed in the exact header form so it can be copied
       * without reformatting, which is the step people get wrong.
       */
      process.stdout.write(
        `Send this to whoever mints the credential — it is safe in any channel:\n\n` +
          `  X-Secret-Recipient: x25519:${pub}\n\n` +
          `Keep this. It is the only thing that can open what comes back, it is not\n` +
          `stored anywhere, and it will not be shown again:\n\n${pem}\n` +
          `Then: chatly secret open --sealed <sealedSecret> --key-file <path>\n`,
      );
      return 0;
    }
    case 'open': {
      const sealed = args.flags['sealed'];
      const inline = args.flags['key'];
      const keyFile = args.flags['key-file'];
      if (typeof sealed !== 'string' || sealed === '') {
        process.stderr.write('chatly secret open --sealed <sealedSecret> --key-file <path>\n');
        return 2;
      }
      let pem: string;
      if (typeof keyFile === 'string' && keyFile !== '') {
        pem = readFileSync(keyFile, 'utf8');
      } else if (typeof inline === 'string' && inline !== '') {
        /*
         * `--key` exists and `--key-file` is documented first, deliberately.
         * A PEM on a command line is in the shell history of whoever ran it;
         * the flag is here because a CI step with the key in an env var has
         * nowhere else to put it, and refusing that would send people to
         * `echo | ...` which is worse.
         */
        pem = inline.includes('\n') ? inline : inline.replace(/\\n/g, '\n');
      } else {
        process.stderr.write(
          'pass the private key with --key-file <path> (preferred) or --key "<pem>".\n',
        );
        return 2;
      }
      let plaintext: string;
      try {
        plaintext = unsealSecret(sealed, pem);
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        return 1;
      }
      // Bare, with no label, so it pipes. `chatly secret open … | pbcopy` and
      // `$(chatly secret open …)` are the two things people do with it.
      process.stdout.write(`${plaintext}\n`);
      return 0;
    }
    default:
      process.stdout.write(
        'chatly secret keypair                                   generate an X25519 keypair\n' +
          'chatly secret open --sealed <blob> --key-file <path>     open a sealedSecret\n\n' +
          'Sealed delivery: mint a credential with the header `X-Secret-Recipient:\n' +
          'x25519:<publicKey>` and the response carries `token: null` plus a\n' +
          '`sealedSecret` only your private key opens. The plaintext never exists\n' +
          'outside your own process, so nothing has to be pasted anywhere.\n',
      );
      return sub === 'help' ? 0 : 2;
  }
}
