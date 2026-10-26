/**
 * `chatly.platform.json` — the platform document's schema.
 *
 * ═══ WHAT IT LOOKS LIKE ═══════════════════════════════════════════════════
 *
 *   {
 *     "version": 1,
 *     "platform": { "prefix": "cp_live_a1b2c3d4" },
 *     "resources": {
 *       "workspaces": [{ "slug": "acme", "name": "Acme Inc" }],
 *       "users": [
 *         { "workspace": "acme", "email": "ops@acme.test", "name": "Ops", "role": "admin" }
 *       ],
 *       "apiKeys": [
 *         { "workspace": "acme", "name": "deploy", "scopes": ["conversations:read"] }
 *       ],
 *       "botCredentials": [{ "workspace": "acme", "name": "assistant" }],
 *       "knowledgeSources": [
 *         { "workspace": "acme", "label": "Docs", "url": "https://acme.test/docs" }
 *       ]
 *     }
 *   }
 *
 * ═══ WHY FLAT SECTIONS AND NOT WORKSPACES THAT NEST THEIR CHILDREN ════════
 *
 * A nested shape reads better for one tenant and worse for the job this file
 * exists for. The ask behind CHT-F04 is "four products were provisioned four
 * slightly different ways", which is a question about CONSISTENCY ACROSS
 * tenants: what every workspace's deploy key is scoped to, which of them has
 * a bot credential nobody uses, whether the same two people are admins
 * everywhere. Flat sections put each of those on one screen and make a
 * diff-of-the-file readable; nesting buries them one indent deeper per
 * tenant.
 *
 * It also means the engine is the same engine. `wac/diff.ts` and
 * `wac/apply.ts` are untouched by this feature except for the path-parameter
 * mechanism, and the dependency ordering a nested document would have had to
 * re-invent (create the workspace, then everything that names it, and skip a
 * child whose parent's create failed) is what `references` and `dependsOn`
 * already do.
 *
 * ═══ THE GUARD ════════════════════════════════════════════════════════════
 *
 * `platform.prefix` against `GET /v1/platform/whoami`'s `prefix`, which is
 * the identifying head of the `cp_` token. The workspace document guards on a
 * workspace id for the same reason and the stakes here are higher: this
 * document creates TENANTS, and running a staging file against a production
 * reseller credential provisions real customers. Optional, because a document
 * meant to be portable across two platform credentials cannot name one —
 * and checked on `plan` as well as `apply`, because a plan is what somebody
 * reads before they approve.
 *
 * It is the PREFIX and not the whole token: the prefix is published on every
 * `whoami` and on every key row, it is not a credential, and a document in
 * git must not contain one. `${env:…}` interpolation works here as it does
 * everywhere else if somebody wants it out of the file entirely.
 */

import {
  PLATFORM_RESOURCE_KEYS,
  PLATFORM_RESOURCE_TYPES,
  platformResourceDef,
  REFUSED_KEYS,
} from './platform-resources.js';
import { addressOf } from '../wac/resource-def.js';

import type { DocumentSchema, Issue } from '../wac/document.js';

export { addressOf };

/** The default filenames, in the order `--file`-less runs look for them. */
export const PLATFORM_DEFAULT_FILES = [
  'chatly.platform.json',
  'chatly.platform.yaml',
  'chatly.platform.yml',
];

const TOP_LEVEL_KEYS = ['version', 'platform', 'resources'];

const PLATFORM_KEYS = ['prefix'];

/**
 * `platform: { prefix }`, validated.
 *
 * A nested object rather than a bare `platform: "cp_live_…"` string, because
 * the two things that might reasonably join it later — a restriction echo and
 * an environment name — are properties OF the credential rather than
 * alternatives to it, and widening a string to an object afterwards is a
 * breaking change to a file format. An unknown key inside it is refused by
 * name like every other key in this document.
 */
function readGuard(raw: Record<string, unknown>, issues: Issue[]): string | undefined {
  const block = raw['platform'];
  if (block === undefined) {
    return undefined;
  }
  if (typeof block !== 'object' || block === null || Array.isArray(block)) {
    issues.push({
      path: 'platform',
      message:
        'must be an object: `"platform": { "prefix": "cp_live_…" }`, or left out. It is a ' +
        'guard — `apply` refuses to run against any other platform credential, which is what ' +
        'stops a staging file provisioning real tenants.',
    });
    return undefined;
  }
  const entries = block as Record<string, unknown>;
  for (const key of Object.keys(entries)) {
    if (!PLATFORM_KEYS.includes(key)) {
      issues.push({
        path: `platform.${key}`,
        message: `unknown key "${key}". Valid: ${PLATFORM_KEYS.join(', ')}.`,
      });
    }
  }
  const prefix = entries['prefix'];
  if (prefix === undefined) {
    issues.push({
      path: 'platform.prefix',
      message:
        'required when `platform` is present. It is the identifying head of the `cp_` token, ' +
        'which `chatly api GET /v1/platform/whoami` reports as `prefix` — NOT the token ' +
        'itself. Remove the whole `platform` block if this document is meant to be portable ' +
        'across credentials.',
    });
    return undefined;
  }
  if (typeof prefix !== 'string' || prefix.length === 0) {
    issues.push({ path: 'platform.prefix', message: 'must be a non-empty string.' });
    return undefined;
  }
  /*
   * A WHOLE token here is refused, loudly, rather than accepted and compared
   * against the prefix it starts with.
   *
   * `platform-credentials.service.ts` mints `cp_<32 bytes base64url>` and
   * stores only its hash and a short prefix. A document in git that carried
   * the whole thing would be a reseller credential in a repository — the
   * single worst secret this product has, since it creates tenants and mints
   * their keys — and this file is the one file we KNOW is committed. Being
   * tolerant here would be the convenience that makes that happen.
   */
  if (prefix.length > 24) {
    issues.push({
      path: 'platform.prefix',
      message:
        'that looks like a whole token, not a prefix. Put the PREFIX here — the short ' +
        'identifying head `GET /v1/platform/whoami` reports — and never the token: a `cp_` ' +
        'credential creates tenants and mints their API keys, and this document is a file in ' +
        'git. Pass the token with --key or CHATLY_API_KEY, or interpolate it nowhere at all.',
    });
    return undefined;
  }
  return prefix;
}

/** The platform document: six resource types, a `cp_` credential. */
export const PLATFORM_SCHEMA: DocumentSchema = {
  topLevelKeys: TOP_LEVEL_KEYS,
  resourceKeys: PLATFORM_RESOURCE_KEYS,
  types: PLATFORM_RESOURCE_TYPES,
  def: platformResourceDef,
  refusedKeys: REFUSED_KEYS,
  guard: readGuard,
};
