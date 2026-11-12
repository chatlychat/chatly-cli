/**
 * Which API-key scopes each CLI command needs, derived rather than listed
 * (CH-17).
 *
 * ═══ THE ASK ══════════════════════════════════════════════════════════════
 *
 * FormFlow: "our CI key holds 8 scopes, minted for plan/apply/doctor, and
 * nothing says whether that is minimal or complete." The symptoms were a
 * `chatly ai quota` that 403s on `workspace:billing:read` and a key that
 * cannot rotate itself, both discovered in a pipeline rather than before one.
 *
 * ═══ WHY THERE IS NO TABLE OF COMMANDS HERE ═══════════════════════════════
 *
 * Because a table is the thing that goes stale. `plan` and `apply` read and
 * write exactly the resources the document declares, and each
 * `ResourceDef` already names its routes — so the scope list is a fold over
 * the SAME defs the commands drive. Add a resource and `whoami --for` covers
 * it; move a route to a different scope and one edit, beside the route,
 * fixes both the write and the answer about it.
 *
 * `doctor` is the one short hardcoded list, because `doctor` is a handful of
 * fixed reads rather than a table walk. It is pinned by a spec against the
 * calls `doctor.ts` actually makes.
 *
 * ═══ WHAT THIS WILL NOT DO ════════════════════════════════════════════════
 *
 * Claim a key is sufficient. It answers from the scopes the SERVER says the
 * credential carries (`GET /v1/api-keys/whoami`) against the routes these
 * commands issue; it does not call them. A per-route authorization probe is
 * the only thing that could promise more, and probing a write to find out
 * whether it is allowed is not a thing a readiness check may do.
 */
import { RESOURCES } from './resources.js';

import type { WacDocument } from './document.js';

/** The commands `--for` answers about. `all` is the union. */
export const SCOPED_COMMANDS = ['plan', 'apply', 'doctor', 'all'] as const;
export type ScopedCommand = (typeof SCOPED_COMMANDS)[number];

/**
 * `GET /v1/api-keys/whoami` itself, which every one of these commands makes
 * before anything else — `plan` and `apply` to check the `workspace:` guard,
 * `whoami --for` to ask this question at all. A key without it cannot even
 * find out what it is missing.
 */
const WHOAMI_SCOPE = 'workspace:read';

/**
 * `chatly doctor`'s reads, which are not a table walk: `GET /v1/channels`,
 * `POST /v1/uploads/presign`, `GET /v1/integration-health`,
 * `GET /v1/workspace/readiness` and — per channel that verifies visitors —
 * `GET /v1/channels/{id}/identity-contract`. Three scopes, not five: the two
 * workspace reads share `workspace:read` and the contract rides the
 * `channels:read` the channel list already needs.
 *
 * `uploads:create` is in here and is the one worth knowing about: without it
 * the CORS preflight — the check this command exists for — reports SKIPPED,
 * so a key that holds everything else gets a green run that proved nothing.
 */
const DOCTOR_SCOPES = ['channels:read', 'uploads:create', 'workspace:read'] as const;

/**
 * One level of `IMPLIED_BY` from `@livechat/shared/permissions`, restated.
 *
 * Restated and not imported: that package is `private: true` and this one is
 * PUBLISHED, so an import typechecks, passes every test here and throws
 * `ERR_MODULE_NOT_FOUND` on a customer's first `npm install` — the trap
 * `doctor-checks.ts` documents at length for the same reason.
 *
 * Two entries, because there are two. A THIRD implication added server-side
 * and not here makes this over-report ("missing kb:write:sources" for a key
 * holding the parent), which is a false alarm on a readiness check — the
 * wrong direction to be wrong in, so it is pinned by a spec that lists both
 * and says where the authority is.
 */
const IMPLIED_BY: Readonly<Record<string, string>> = {
  'contacts:write:events': 'contacts:write',
  'kb:write:sources': 'kb:write',
};

/**
 * The scopes a command needs, sorted, de-duplicated.
 *
 * `doc` narrows `plan` and `apply` to the resources that document actually
 * declares — including the ones it only REFERENCES, since `plan` reads those
 * too. Without a document (none on disk, or `--for doctor`) it answers for
 * every resource type, which over-reports rather than under-reports: being
 * told you lack `macros:read` for a file with no macros is a confusing
 * answer, and being told a key is fine when `apply` will 403 is a worse one.
 */
export function scopesFor(command: ScopedCommand, doc?: WacDocument): ReadonlyArray<string> {
  if (command === 'doctor') {
    return [...DOCTOR_SCOPES].sort();
  }
  if (command === 'all') {
    return unique([...scopesFor('apply', doc), ...DOCTOR_SCOPES]);
  }
  const declared = doc === undefined ? undefined : new Set(typesOf(doc));
  const defs = RESOURCES.filter((d) => declared === undefined || declared.has(d.type));
  const out = [WHOAMI_SCOPE];
  for (const def of defs) {
    if (def.readScope !== undefined) {
      out.push(def.readScope);
    }
    if (command === 'apply' && def.writeScope !== undefined) {
      out.push(def.writeScope);
    }
  }
  return unique(out);
}

/**
 * Every type the document touches: the sections it declares AND the types
 * those sections reference.
 *
 * The references matter — `readLive` fetches them (a `botRoutes`-only
 * document still reads `/v1/bots` to resolve `bot:`), so a key without
 * `triggers:read` fails on a file that declares no bots at all.
 */
function typesOf(doc: WacDocument): ReadonlyArray<string> {
  const out = new Set<string>();
  for (const section of doc.sections) {
    out.add(section.def.type);
    for (const ref of Object.values(section.def.references ?? {})) {
      out.add(ref.type);
    }
  }
  return [...out];
}

/**
 * The scopes `needed` that `held` does not satisfy — exactly, by wildcard, or
 * by implication. Empty means ok.
 */
export function missingScopes(
  held: ReadonlyArray<string>,
  needed: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (held.includes('*')) {
    return [];
  }
  const set = new Set(held);
  return needed.filter((scope) => {
    const parent = IMPLIED_BY[scope];
    return !set.has(scope) && (parent === undefined || !set.has(parent));
  });
}

function unique(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(values)].sort();
}
