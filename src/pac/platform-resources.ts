/**
 * The resource table `chatly platform plan` and `chatly platform apply` work
 * from — the Platform API as a file (CHT-F04).
 *
 * ═══ WHY THIS IS A SECOND TABLE AND NOT MORE ROWS IN `wac/resources.ts` ═══
 *
 * A different CREDENTIAL and a different SHAPE, and either one on its own
 * would be enough.
 *
 * The credential: every route here is behind `PlatformGuard`
 * (`apps/api/src/modules/platform/platform.guard.ts`), which resolves a `cp_`
 * platform credential and refuses anything else. A workspace `ck_` key
 * presented to `/v1/platform/*` is not merely unauthorised — that guard's own
 * header spells out that there is no code path which turns a platform
 * credential into a membership, and none which turns a key into a platform
 * principal. So one document cannot describe both surfaces: it would be one
 * file needing two credentials, and the first thing it would do is fail half
 * its reads.
 *
 * The shape: a workspace-level resource lives at a flat collection path and
 * names its parent in the BODY. Every resource here lives under
 * `/v1/platform/workspaces/{workspaceId}/…` and names its parent in the PATH,
 * and a platform document describes SEVERAL workspaces at once — which is the
 * whole point of it, and the reason `naturalKey` below is a synthetic
 * `address` rather than an email or a name. `a@b.c` identifies a member
 * inside one tenant and nothing at all across a document that provisions
 * four.
 *
 * ═══ VERIFIED AGAINST HANDLERS ════════════════════════════════════════════
 *
 * Every path, key, flag and field-set below was read off
 * `apps/api/src/modules/platform/**` on 2026-10-25. CLAUDE.md records why
 * that is not optional — the SDK manifest's first version listed two routes
 * that do not exist and had its `paged` flag wrong in both directions — and
 * `packages/sdk-spec/surface.json` holds no `/v1/platform` path at all, so
 * there was no manifest to read even if one were trusted. The citations:
 *
 *   workspaces        platform.controller.ts:199 (POST),
 *                     platform-workspace-read.controller.ts:115 (GET, PAGED)
 *   users             platform.controller.ts:229 (POST), :249 (DELETE);
 *                     read from the DETAIL route's `users[]`,
 *                     platform-workspace-read.controller.ts:160
 *   apiKeys           platform.controller.ts:422 (POST),
 *                     platform-api-keys.controller.ts:129 (GET), :159 (DELETE)
 *   botCredentials    platform.controller.ts:483 (POST), :465 (GET), :524 (DELETE)
 *   knowledgeSources  platform-knowledge.controller.ts:117 (POST), :161 (GET),
 *                     :197 (DELETE)
 *
 * ═══ FIVE THINGS THE HANDLERS DECIDED, EACH OF WHICH WOULD BE A LIVE BUG ══
 *
 *  1. **NOTHING on this surface has an update route.** There is no PATCH on a
 *     platform workspace, a membership, a key, a bot credential or a
 *     knowledge source — grep the five controllers and the only `@Patch` in
 *     the module is on `platform-admin` (the operator console) and
 *     `platform-bot` (a message's blocks). So every `update` below is `[]`
 *     with an `updateBlocked` sentence, and a document that changes a field
 *     on an existing resource is reported as un-appliable rather than sent
 *     somewhere that would strip it and answer 200. This is the single most
 *     important fact about planning this surface and it is why the table
 *     reads as thin as it does.
 *
 *  2. **A revoked credential stays in the list.** `GET …/api_keys` says so in
 *     its own route description — "a revoked key stays listed, with
 *     `revokedAt` set" — and `listBots` orders BY `revokedAt` precisely
 *     because revoked rows are in the answer. Matching a document row to one
 *     would report `noop` for a credential that authenticates nothing: the
 *     plan would say the tenant matches the file while the pipeline the file
 *     describes is locked out. Hence `ignoreLive` on both.
 *
 *  3. **A knowledge source is written as `url` and read back as `seedUrl`.**
 *     `knowledgeSourceSchema` takes `url`; `KNOWLEDGE_SOURCE_FIELDS` returns
 *     `seedUrl`. Without the projection below, `url` compares against a field
 *     that does not exist, reports a change on every run, and — since there
 *     is no update route — is reported as permanently un-appliable. Exactly
 *     the `externalAgent` shape in the workspace table.
 *
 *  4. **`POST /v1/platform/workspaces` 409s on a taken slug.** It is a strict
 *     create and not an upsert (`createWorkspace` reads the slug and throws
 *     `SlugTakenError` before it writes anything), and `workspaces.slug` is
 *     unique ACROSS the installation rather than per reseller. So a slug is a
 *     real natural key, and `plan` can tell a create from a noop without a
 *     uuid — which is the property that makes a portable document possible.
 *
 *  5. **A soft-deleted workspace is not in the default list** and a SUSPENDED
 *     one is (`platform-workspace-read.controller.ts`: "omitting `?status=`
 *     still answers every workspace that is not soft-deleted — suspended ones
 *     included"). A suspended tenant therefore matches its document row and
 *     reports `noop`, which is correct: it exists, and there is no platform
 *     route that un-suspends it. `status` is `unwritable` so nobody can try.
 *
 * ═══ WHAT IS DELIBERATELY NOT HERE ════════════════════════════════════════
 *
 * `REFUSED_KEYS` below, by name, each with the reason. Login links are a
 * mint, not a declaration. Channel config, IDV mode, business hours and
 * routing WERE refused here because no platform route read them back; since
 * `GET`/`POST /v1/platform/workspaces/{id}/settings` they are the `settings`
 * row, and their old names point there.
 */

import { addressOf, type ResourceDef } from '../wac/resource-def.js';

export { addressOf } from '../wac/resource-def.js';

/** Fields every platform row carries that no write path accepts. */
const SERVER_OWNED = ['id', 'workspaceId', 'createdAt', 'updatedAt'] as const;

/**
 * The synthetic natural key, on both sides. Never authored, never diffed.
 *
 * `document.ts`'s rule is that a field the server returns and no write path
 * accepts must be refused by name, because zod strips it and answers 200. The
 * address is not that — it exists on neither side of the wire — but a
 * document that sets it is still a document whose author has misunderstood
 * something, and the refusal is free. So it is in every `unwritable` list.
 */
export const ADDRESS = 'address';

/** The head of a credential-list row that says it is no longer a credential. */
function revoked(row: Record<string, unknown>): boolean {
  const at = row['revokedAt'];
  return typeof at === 'string' && at.length > 0;
}

/**
 * Dependency order, and it is the array order.
 *
 * `workspaces` first and everything else after, because every other resource
 * here names a workspace in its request PATH and a single `apply` may be
 * about to create that workspace. `diff.ts` resolves the reference where it
 * can and notes "this plan creates it first" where it cannot; `apply.ts`
 * fills the path from the id the create actually returned, and skips the
 * child outright if the parent failed.
 */
export const PLATFORM_RESOURCES: ReadonlyArray<ResourceDef> = [
  {
    type: 'workspaces',
    label: 'workspace',
    naturalKey: 'slug',
    keySource: 'authored',
    /*
     * TRUE, and more strongly than anywhere in the workspace table: the
     * unique index on `workspaces.slug` is installation-wide, so a slug this
     * credential cannot see may still be taken. That is a 409 on create
     * rather than a mismatch, and the 409's message names the slug.
     */
    keyEnforced: true,
    list: { path: '/v1/platform/workspaces', paged: true },
    idField: 'id',
    create: { path: '/v1/platform/workspaces' },
    update: [],
    updateBlocked:
      'there is no PATCH on a platform workspace — not for `name`, not for `plan`, not for ' +
      '`sandbox`. `POST /v1/platform/workspaces` creates and 409s on a slug that is taken, and ' +
      'the only other writes are delete and restore. Rename a tenant from inside it ' +
      '(`PATCH /v1/workspace/settings` with a `ck_` key), which is a different credential and ' +
      'therefore a different document.',
    /*
     * `null`, and this is the most consequential safety decision in the file.
     *
     * `DELETE /v1/platform/workspaces/{id}` EXISTS and works — it soft-deletes
     * the tenant and starts a 30-day purge clock. `--prune` will not call it.
     *
     * Everything else `--prune` can delete on this surface is recoverable by
     * re-running `apply`: a membership is re-added, a key or a bot credential
     * is re-minted (with a new token, which the plan says out loud), a
     * knowledge source is re-crawled and its articles were never deleted. A
     * workspace is the one row where prune would destroy a customer's
     * conversations, contacts and tickets because a slug was spelled
     * differently in a file — and a platform document is a SUBSET of the
     * tenants a credential owns, so "not in the document" is the normal state
     * of a healthy workspace rather than evidence of anything.
     *
     * The reader never offers the chance anyway (see `platform-live.ts`: it
     * reads only the slugs the document declares, so an undeclared tenant is
     * not even an orphan). This is the second lock, for the case where
     * somebody changes that.
     */
    remove: null,
    removeBlocked:
      '`--prune` will not delete a tenant. `DELETE /v1/platform/workspaces/{id}` exists and ' +
      'soft-deletes the workspace with a 30-day purge clock — every conversation, contact and ' +
      'ticket in it — and a platform document describes a SUBSET of the tenants a credential ' +
      'owns, so a workspace this file does not mention is the normal state of a healthy ' +
      'customer. Delete one deliberately, by id, with that route.',
    opaque: [],
    secrets: [],
    unwritable: [
      ...SERVER_OWNED,
      ADDRESS,
      // Derived from `deleted_at` / `suspended_at`; there is no column and no
      // write path. See `platformWorkspaceLifecycleFields`.
      'status',
      'deletedAt',
      'purgeAfter',
      // `deletedAt + 30 days`'s sibling: set only by `createWorkspace`, and
      // only together with `sandbox`, which the DB enforces with a CHECK.
      'sandboxExpiresAt',
      // Always `free` on create. There is no plan parameter on this surface.
      'plan',
      // The detail route's nested reads. A document declares `users:` as its
      // own section; copying the read shape in would describe nothing.
      'users',
      'channels',
      'counts',
    ],
  },
  {
    type: 'users',
    label: 'member',
    naturalKey: ADDRESS,
    keySource: 'authored',
    /*
     * FALSE. `memberships` has no unique index on (workspace_id, user_id) that
     * this file can rely on, and more to the point the key here is an EMAIL
     * resolved to a user — `provisionUser` creates the account or attaches an
     * existing one. Two rows with one email in one workspace is not a shape
     * the server produces today, and `diff.ts` refuses to touch either if it
     * ever does, which is the only honest answer.
     */
    keyEnforced: false,
    /*
     * Case-folded, because the server folds it: `provisionUser` lowercases
     * the email before it looks the account up
     * (`platform-provisioning.service.ts`), so `Ops@Acme.test` in a document
     * IS `ops@acme.test` on the server. Without this the row plans as a
     * create plus an orphan on every run. The slug half is already lowercase
     * by the slug rule, so folding the whole address is safe.
     */
    normalizeKey: (key) => key.toLowerCase(),
    /*
     * The DETAIL route, not a list route, because there is no list route.
     *
     * `GET /v1/platform/workspaces/{workspaceId}` answers `users[]` with
     * `{ userId, email, role }` and nothing else. `rowsFrom` pulls them out;
     * `platform-live.ts` fetches each path once and reuses it, so declaring
     * two resources against one route costs one request.
     */
    list: { path: '/v1/platform/workspaces/{workspaceId}', paged: false },
    rowsFrom: (response) => {
      const users = (response as { users?: unknown } | null)?.users;
      return Array.isArray(users) ? (users as Array<Record<string, unknown>>) : [];
    },
    /*
     * `userId`, because that is what the DELETE path takes
     * (`…/users/{userId}`) and what the detail route returns. There is no
     * membership id on the read — `provisionUser`'s RESPONSE carries
     * `membershipId`, the detail does not — so a membership cannot be
     * addressed from a plan and nothing here tries to.
     */
    idField: 'userId',
    create: { path: '/v1/platform/workspaces/{workspaceId}/users' },
    update: [],
    updateBlocked:
      "there is no route that changes a member's role. `POST …/users` creates or attaches and " +
      'then sets the role once; after that the only platform write is removal. Change a role ' +
      'from inside the workspace (`PATCH /v1/workspace/team/{id}` with a `ck_` key), or remove ' +
      'the row from this document, apply, add it back with the new role and apply again — which ' +
      'deletes and recreates the MEMBERSHIP and keeps the user account.',
    // 200 `{ revoked }`. A soft delete on the membership; the user account and
    // every historical assignee reference survive, which is why this is safe
    // to prune.
    remove: { path: '/v1/platform/workspaces/{workspaceId}/users/{id}' },
    /*
     * `name` is WRITE-ONLY on this surface. `provisionUserSchema` requires it;
     * the detail route returns `userId`, `email` and `role` and no name at
     * all. Without this a document that sets a name reports a change on every
     * run and — there being no update route — is permanently blocked.
     */
    opaque: ['name'],
    secrets: [],
    unwritable: [...SERVER_OWNED, ADDRESS, 'userId', 'membershipId', 'created'],
    references: {
      /*
       * `workspace: "acme"` — the slug, resolved to the uuid that goes in the
       * PATH. `pathParam` is what keeps it out of the body: `provisionUserSchema`
       * is a plain `z.object`, so a `workspaceId` field would be stripped in
       * silence and the route would answer 201 having ignored it.
       */
      workspace: { type: 'workspaces', wire: 'workspaceId', pathParam: true },
    },
    parent: { type: 'workspaces', field: 'workspace', wire: 'workspaceId', childKey: 'email' },
  },
  {
    type: 'apiKeys',
    label: 'workspace API key',
    naturalKey: ADDRESS,
    keySource: 'authored',
    // `api_keys` has no unique index on `name`. This file is the only thing
    // keeping one key per name, so a duplicate is refused rather than guessed.
    keyEnforced: false,
    list: { path: '/v1/platform/workspaces/{workspaceId}/api_keys', paged: false },
    idField: 'id',
    create: { path: '/v1/platform/workspaces/{workspaceId}/api_keys' },
    update: [],
    updateBlocked:
      "a key's `scopes` and `expiresAt` are fixed at mint — there is no PATCH. Widening a key " +
      'means minting a new one and revoking the old one, which is a NEW `ck_` token your ' +
      'deployment has to pick up, so this CLI will not do it behind a diff. Change the `name` in ' +
      'the document instead: the new key is minted and the old one is reported as an orphan.',
    // 200 `{ revoked }`, idempotent — `false` means it was already off.
    remove: { path: '/v1/platform/workspaces/{workspaceId}/api_keys/{id}' },
    opaque: [],
    /*
     * The token, shown exactly once. `apply.ts` prints it in a block of its
     * own and writes it nowhere — not into the document, which is the one file
     * we KNOW is in git.
     */
    secrets: ['token'],
    unwritable: [
      ...SERVER_OWNED,
      ADDRESS,
      'prefix',
      'lastUsedAt',
      'revokedAt',
      // Response-only: the sentence telling the caller to copy the token.
      'note',
      'token',
    ],
    /*
     * A revoked key stays in the list with `revokedAt` set, by that route's
     * own documented contract. See the header, point 2.
     */
    ignoreLive: revoked,
    references: {
      workspace: { type: 'workspaces', wire: 'workspaceId', pathParam: true },
    },
    parent: { type: 'workspaces', field: 'workspace', wire: 'workspaceId', childKey: 'name' },
  },
  {
    type: 'botCredentials',
    label: 'bot credential',
    naturalKey: ADDRESS,
    keySource: 'authored',
    keyEnforced: false,
    list: { path: '/v1/platform/workspaces/{workspaceId}/bots', paged: false },
    idField: 'id',
    create: { path: '/v1/platform/workspaces/{workspaceId}/bots' },
    update: [],
    updateBlocked:
      'there is no PATCH on a bot credential. What it can do is fixed — the operations on ' +
      '`PlatformBotController`, inside one workspace — so there is no scope to widen and ' +
      'nothing to change but the expiry, which is set at mint. Rename it in the document to ' +
      'mint a replacement and orphan the old one.',
    // 200 `{ revoked }`. Effective on the next request.
    remove: { path: '/v1/platform/workspaces/{workspaceId}/bots/{id}' },
    opaque: [],
    secrets: ['token'],
    unwritable: [
      ...SERVER_OWNED,
      ADDRESS,
      'prefix',
      'createdByPlatformAppId',
      // Set when a bot credential is bound to an `ai_bots` row, which is not
      // something `POST …/bots` accepts.
      'aiBotId',
      'lastUsedAt',
      'revokedAt',
      'note',
      'token',
    ],
    ignoreLive: revoked,
    references: {
      workspace: { type: 'workspaces', wire: 'workspaceId', pathParam: true },
    },
    parent: { type: 'workspaces', field: 'workspace', wire: 'workspaceId', childKey: 'name' },
  },
  {
    type: 'knowledgeSources',
    label: 'knowledge source',
    naturalKey: ADDRESS,
    keySource: 'authored',
    /*
     * FALSE, and `label` must therefore be written explicitly. It DEFAULTS to
     * the generated collection name when omitted, so a document that leaves
     * it out would be matching on a value the server chose — which is the
     * same trap `docsSources` carries in the workspace table.
     */
    keyEnforced: false,
    list: {
      path: '/v1/platform/workspaces/{workspaceId}/knowledge_sources',
      paged: false,
    },
    idField: 'id',
    create: { path: '/v1/platform/workspaces/{workspaceId}/knowledge_sources' },
    update: [],
    updateBlocked:
      'there is no PATCH on a platform knowledge source. `url`, the crawl bounds and the ' +
      'publish flag are fixed at create. Disconnect it and connect a new one — ' +
      '`DELETE …/knowledge_sources/{id}` KEEPS every article the source imported, so nothing ' +
      'the bot has been answering from is lost — or give the new one a different `label`.',
    // 200 `{ deleted: true }`. Stops the re-crawl and KEEPS the articles,
    // which is what makes this safe to prune.
    remove: { path: '/v1/platform/workspaces/{workspaceId}/knowledge_sources/{id}' },
    /*
     * Accepted on create and returned by nothing. `KNOWLEDGE_SOURCE_FIELDS`
     * has no `maxPages`, `maxDepth`, `confineToPathPrefix` or
     * `followPdfLinks` — the worker clamps and applies them and the read
     * shape never mentions them. Declared opaque so a document may set them
     * on a create without reporting a phantom change for ever afterwards.
     */
    opaque: ['maxPages', 'maxDepth', 'confineToPathPrefix', 'followPdfLinks'],
    secrets: [],
    unwritable: [
      ...SERVER_OWNED,
      ADDRESS,
      // Projected into `url` below; the document writes `url`.
      'seedUrl',
      'status',
      'syncStatus',
      'lastSyncedAt',
      'lastError',
      'articleCount',
      'unreadableCount',
      // `POST` answers the resource plus the literal `true`.
      'queued',
    ],
    /*
     * `seedUrl` → `url`. The write takes `url`; the read answers `seedUrl`.
     *
     * `publishOnIngest` is left exactly as it comes: it is the ALIAS, both
     * names are accepted on the way in and both come back always equal, so a
     * document may use either and the diff compares like with like.
     */
    project: (row) => ({ ...row, url: row['seedUrl'] }),
    references: {
      workspace: { type: 'workspaces', wire: 'workspaceId', pathParam: true },
    },
    parent: { type: 'workspaces', field: 'workspace', wire: 'workspaceId', childKey: 'label' },
  },
  {
    /*
     * A tenant's business hours, routing and web-channel config — one row per
     * workspace, `{ "workspace": "acme", "businessHours": {…}, "routing": {…},
     * "widgetChannel": { "config": {…} } }`, every section optional.
     *
     * A SINGLETON: `childKey` is the parent field itself, so the address is
     * `acme/acme` and `platform-live.ts` reads it only for workspaces this
     * section names. All three sections are MERGED by the server, so
     * `mergeFields` compares only the keys the document writes — a field left
     * out is left as stored, on the server and in the plan alike.
     *
     * `widgetChannel.config.allowedOrigins` is the exact origin list (the
     * config merge replaces a list). `widgetChannel.origins` only ever ADDS
     * (`planWidgetChannelWrite` unions), so it is projected for reading but a
     * shorter list there can never verify.
     */
    type: 'settings',
    label: 'workspace settings',
    naturalKey: ADDRESS,
    keySource: 'authored',
    // One per workspace by construction: there is nothing to duplicate.
    keyEnforced: true,
    list: { path: '/v1/platform/workspaces/{workspaceId}/settings', paged: false },
    rowsFrom: (response) =>
      typeof response === 'object' && response !== null && !Array.isArray(response)
        ? [response as Record<string, unknown>]
        : [],
    idField: 'workspaceId',
    // A POST that MERGES into settings every workspace already has — the
    // `widget_channel` shape. On a workspace this run creates it is the same call.
    create: { path: '/v1/platform/workspaces/{workspaceId}/settings' },
    update: [{ method: 'POST', path: '/v1/platform/workspaces/{workspaceId}/settings' }],
    remove: null,
    removeBlocked:
      "a workspace's settings cannot be deleted. Take the row out of the document to stop " +
      'managing them; they stay as stored.',
    mergeFields: ['businessHours', 'routing', 'widgetChannel'],
    opaque: [],
    secrets: [],
    unwritable: [...SERVER_OWNED, ADDRESS],
    project: (row) => {
      const wc = row['widgetChannel'] as Record<string, unknown> | null | undefined;
      const config = wc?.['config'] as Record<string, unknown> | undefined;
      return wc === null || wc === undefined
        ? row
        : { ...row, widgetChannel: { ...wc, origins: config?.['allowedOrigins'] ?? [] } };
    },
    references: {
      workspace: { type: 'workspaces', wire: 'workspaceId', pathParam: true },
    },
    parent: { type: 'workspaces', field: 'workspace', wire: 'workspaceId', childKey: 'workspace' },
  },
];

export const PLATFORM_RESOURCE_TYPES: ReadonlyArray<string> = PLATFORM_RESOURCES.map((r) => r.type);

const BY_TYPE = new Map(PLATFORM_RESOURCES.map((r) => [r.type, r]));

export function platformResourceDef(type: string): ResourceDef | undefined {
  return BY_TYPE.get(type);
}

/**
 * Keys a platform document may NOT declare, refused by name with the reason
 * rather than reported as "unknown resource type", which would send the
 * reader hunting for a spelling mistake (`wac/document.ts` does the same for
 * `channels:`).
 *
 * Three are CHT-F04's old top-level names, kept as pointers to the `settings`
 * row that now plans them. The fourth is real: **a login link is a mint, not
 * a declaration.** Its plaintext exists in one response and nowhere else,
 * `GET /v1/platform/login_links` returns no token and no hash, and a document
 * that "declared" one would mint a new single-use credential on every apply.
 */
export const REFUSED_KEYS: Readonly<Record<string, string>> = {
  widgetChannel:
    'declare it inside a `settings` row: `{ "workspace": "acme", "widgetChannel": { "config": ' +
    '{ … } } }`. It is read back by `GET /v1/platform/workspaces/{id}/settings` and merged by ' +
    'the POST beside it.',
  businessHours:
    'declare it inside a `settings` row: `{ "workspace": "acme", "businessHours": { "tz": ' +
    '"Europe/Madrid", … } }`.',
  routing:
    'declare it inside a `settings` row: `{ "workspace": "acme", "routing": { ' +
    '"defaultStrategy": "round_robin" } }`.',
  loginLinks:
    'a login link is a single-use credential, not a declaration. Its plaintext exists in the ' +
    'mint response and nowhere else, `GET /v1/platform/login_links` carries neither token nor ' +
    'hash, and anything declarative would mint a fresh one on every apply. Use `chatly api ' +
    'POST /v1/platform/login_links`.',
};

/** Every key `resources:` accepts, including the ones it refuses by name. */
export const PLATFORM_RESOURCE_KEYS: ReadonlyArray<string> = [
  ...PLATFORM_RESOURCE_TYPES,
  ...Object.keys(REFUSED_KEYS),
];

/** The address of one child row, for a message or a key. */
export function childAddress(parentKey: string, childKey: string): string {
  return addressOf(parentKey, childKey);
}
