/**
 * The `members` resource: a teammate, described as the INVITATION that makes
 * one (CH-08).
 *
 * ═══ WHY THE LIVE LIST IS THE INVITE LIST ════════════════════════════════
 *
 * The obvious read route is `GET /v1/workspaces/me/members`, and it is the
 * wrong one. A member row does not exist until the person accepts, so a
 * document row would miss on every run between the invite and the sign-in —
 * and a miss is a `create`, which is another email. A declarative file that
 * re-mails every teammate on every deploy is worse than no file.
 *
 * `GET /v1/invites?status=all` is the set that answers "has this file already
 * been applied": the row is written the moment the invite is sent and KEEPS
 * `acceptedAt` once redeemed, so the second `apply` is a `noop` whether or
 * not the invitee has signed in yet. The default status is `pending`, which
 * would lose the accepted ones, so the query is part of the path.
 *
 * What that costs: a member who joined some other way — the workspace owner,
 * anybody invited before this file existed — is invisible here, so the
 * document cannot describe them and `--prune` cannot touch them. Both are the
 * right answer for a file whose only verb is "invite".
 *
 * ═══ A ROW CANNOT BE UPDATED, AND THAT IS DELIBERATE ═════════════════════
 *
 * `update: []`. The only field on a teammate that a document could change is
 * `role`, and the only route that changes it is
 * `PATCH /v1/memberships/{id}/role`, which carries no `@AllowApiKey()` and
 * requires `members:write` — a scope `GET /v1/api-keys/scopes` does not offer
 * and no key can hold (`api-keys/api-key-scopes.ts`, and the ceiling itself
 * in `invites/key-actor-roles.ts`). So there is no route to list, and a
 * changed `role` is reported as `blocked` with `updateBlocked` beneath it
 * rather than planned as an update that `apply` could never make. Planning a
 * write nobody can perform is the failure this whole table exists to avoid:
 * it would promise a change, attempt it, and 403 in the middle of a deploy.
 *
 * Note this is `plan` refusing, not a second opinion about the security
 * posture: the CLI is simply not pretending to a capability the key lacks.
 *
 * ═══ REVOKED AND EXPIRED ARE NOT MATCHABLE ═══════════════════════════════
 *
 * `ignoreLive`, the same treatment a revoked `ck_` key gets in the platform
 * table. A revoked invitation is not an invitation: matching a document row
 * to one would report `noop` for a teammate who can never get in, which is
 * the worst answer available — the plan would say the workspace matches the
 * file while the person it describes is locked out. Filtered out instead, so
 * the row is a `create` and `apply` sends a fresh one. An invitation past
 * `expiresAt` and never accepted is the same state by another route.
 *
 * A filtered row is invisible rather than an orphan, which is also right:
 * nothing should offer to delete a row that is already dead.
 */
import { SERVER_OWNED } from './resource-shared.js';

import type { ResourceDef } from './resource-def.js';

/**
 * `inviteEntrySchema`'s own `.trim().toLowerCase()`, applied to both sides
 * before matching — the same reason `macros` carries `normaliseShortCode`.
 * Without it `Ops@Example.com` in a document never matches the stored
 * `ops@example.com`, so every run invites the same person again.
 */
const normaliseEmail = (key: string): string => key.trim().toLowerCase();

/** Unreadable dates fail towards "still live", so a bad value sends no mail. */
const expired = (value: unknown): boolean =>
  typeof value === 'string' && Date.parse(value) <= Date.now();

export const MEMBERS: ResourceDef = {
  type: 'members',
  label: 'teammate',
  /*
   * Both are `members:invite`, which is not a typo for `members:read`:
   * `GET /v1/invites` and `POST /v1/invites` carry the same
   * `@RequirePermission('members:invite')`. Read off the handlers, as the
   * header of `resources.ts` requires — `members:read` gates
   * `GET /v1/workspaces/me/members`, which this resource does not call.
   */
  readScope: 'members:invite',
  writeScope: 'members:invite',
  naturalKey: 'email',
  keySource: 'authored',
  /*
   * `workspace_invites` has no unique index on (workspace_id, email) — only
   * the workspace FK and the token digest. So two live rows may share an
   * address and `diff.ts` refuses both rather than guessing which one the
   * document meant.
   */
  keyEnforced: false,
  normalizeKey: normaliseEmail,
  /*
   * Caught here rather than as a 400 at apply time. Deliberately coarse: the
   * route validates with zod's `.email()` and this only has to stop the
   * typo — a pattern that tried to be RFC-correct would refuse addresses the
   * server accepts, which is the wrong direction for a parse-time check.
   */
  keyPattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
  list: { path: '/v1/invites?status=all', paged: true },
  idField: 'id',
  create: { path: '/v1/invites' },
  update: [],
  updateBlocked:
    'the `role` of a teammate can only be changed with `members:write`, which is not a grantable ' +
    'API-key scope — `PATCH /v1/memberships/{id}/role` does not accept a key at all, so no ' +
    '`chatly apply` can make this change however the key was minted. Change it in the ' +
    'dashboard (Workspace → Management) and put the same value in this file, or remove the person ' +
    'and invite them again at the role you want.',
  remove: null,
  removeBlocked:
    'this file sends invitations and does not take people out of a workspace. Revoking a ' +
    'pending invite (`POST /v1/invites/{id}/revoke`) does not accept an API key, and ' +
    '`DELETE /v1/memberships/{id}` — which does — needs the MEMBERSHIP id, which an ' +
    'invitation row does not carry. Remove a teammate in the dashboard, or with ' +
    '`chatly api DELETE /v1/memberships/<membership id>`.',
  ignoreLive: (row) =>
    typeof row['revokedAt'] === 'string' ||
    (typeof row['acceptedAt'] !== 'string' && expired(row['expiresAt'])),
  opaque: [],
  /*
   * The invitation token is never in the response: it is sha256-digested into
   * `token_digest` and the plain copy goes out in the email only. So there is
   * no one-time secret for `apply` to print.
   */
  secrets: [],
  unwritable: [
    ...SERVER_OWNED,
    'invitedBy',
    'invitedByName',
    'invitedByEmail',
    'expiresAt',
    'acceptedAt',
    'revokedAt',
  ],
};
