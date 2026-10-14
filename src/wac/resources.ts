/**
 * The resource table `chatly plan` and `chatly apply` work from.
 *
 * ═══ WHY A TABLE ══════════════════════════════════════════════════════════
 *
 * The ask behind this feature, in the integrator's words: "we wrote ~600
 * lines to idempotently upsert tools, bots, routes, cards and channel
 * config." Those 600 lines are nine copies of the same four steps — list,
 * index by some stable name, compare, write — differing only in a route and a
 * field name. This file is those differences and nothing else; `diff.ts` is
 * the four steps, once, and `apply.ts` is the writes.
 *
 * ═══ IDENTITY: THE DECISION EVERYTHING ELSE RESTS ON ═════════════════════
 *
 * A declarative file cannot refer to resources by the server's uuid. On a
 * fresh checkout against a fresh workspace there are no uuids, and a file
 * carrying them is a file you cannot apply to a second environment — which
 * is the whole reason this exists ("teams that run more than one
 * environment"). So every resource needs a NATURAL KEY: a field the author
 * writes, that comes back on the list read, and that identifies one row.
 *
 * Read off the handlers and the migrations, the nine are:
 *
 *   brands          slug        UNIQUE (workspace_id, slug)
 *   bots            slug        UNIQUE (workspace_id, slug) WHERE NOT NULL
 *   macros          shortCode   UNIQUE (workspace_id, lower(short_code))
 *   emailTemplates  kind        UNIQUE (workspace_id, kind) — and a path param
 *   customerCards   key         UNIQUE (workspace_id, key)
 *   botRoutes       name        NO CONSTRAINT
 *   triggers        name        NO CONSTRAINT
 *   webhooks        url         NO CONSTRAINT
 *   docsSources     label       NO CONSTRAINT
 *   channels        publicId    UNIQUE — but minted by the server
 *
 * The first five are real: the database refuses a second row, so matching on
 * the key cannot pick the wrong one. The next four are a CONVENTION the
 * document enforces rather than a constraint the server does — so `diff.ts`
 * refuses to touch a key that appears twice on either side instead of
 * guessing, which is the only honest thing to do with a key that can repeat.
 *
 * ── The resource with no natural key at all ──────────────────────────────
 *
 * CHANNELS. `publicId` is required on create but it is a RESERVATION, not a
 * name you choose freely: `channels_public_id_unique` is global rather than
 * workspace-scoped, so another tenant may already hold `web`. `type` and
 * `publicId` are both immutable afterwards, `config` reads back with
 * `__redacted__` in every credential key, and the create response carries
 * per-provider webhook registration results that a diff cannot model. A
 * `channels:` section is therefore REFUSED by `document.ts`, by name, with
 * the reason — not half-supported. `chatly channels create|update` is the
 * way, and that is what the refusal says.
 *
 * ═══ VERIFIED AGAINST HANDLERS, NOT AGAINST NAMES ════════════════════════
 *
 * Every path, key, `paged` flag, update field-set and projection below was
 * read off `apps/api/src/modules/**` and `packages/db/migrations/**`.
 * CLAUDE.md records why that is not optional: the SDK manifest's first
 * version listed two routes that do not exist and had its `paged` flag wrong
 * in BOTH directions, and a fake transport that answers every route with a
 * page envelope agrees with whatever the manifest says. Seven of the nine
 * list routes here are `@PaginationExempt` bare arrays; treating one as a
 * page is the bug two SDKs shipped.
 *
 * Six things in this table exist only because a handler said so, and each
 * would be a live bug if guessed:
 *
 *  1. `macros.shortCode` does not round-trip. `normaliseShortCode` strips a
 *     leading `/` and lowercases, so a document saying `/Refund` would never
 *     match the stored `refund`, would create on every run, and would then
 *     collide with the unique index forever. Hence `normalizeKey`.
 *  2. `emailTemplates` keeps the customised copy under `override`, not at the
 *     top level, and the list always returns all five kinds with
 *     `override: null` for the ones on the built-in. A naive diff reads
 *     `row.subject` — which does not exist — and reports a change every run.
 *     Hence `project`.
 *  3. A bot's external config comes back nested under `externalAgent` and is
 *     written to a DIFFERENT route (`PATCH /v1/bots/{id}/external`). Hence
 *     `project` plus a second update route.
 *  4. `webhooks` has NO general PATCH. Only the pinned schema version can
 *     change; `url`, `eventTypes` and `description` are frozen at create.
 *  5. `triggers` POST is a FULL REPLACE keyed on the body's `id`, and an
 *     unknown id is a 404 rather than a create. So the id must come from the
 *     live row, and an omitted field is RESET to its default — hence
 *     `fullReplace`, which makes `plan` say so out loud.
 *  6. `docsSources` PATCH accepts six fields. `provider`, `spaceId`,
 *     `organizationId`, `includePaths` and `excludePaths` are create-only, so
 *     a change to one of them is reported as un-appliable rather than sent to
 *     a route that will strip it and answer 200.
 */

export type { Action, ResourceDef, ResourceRef, UpdateRoute } from './resource-def.js';
export { looksLikeCredential, normalizedKey, projected, routeForField } from './resource-def.js';

import type { ResourceDef } from './resource-def.js';

/** Fields every row carries that no write path accepts. */
const SERVER_OWNED = ['id', 'workspaceId', 'createdAt', 'updatedAt'] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Dependency order, and it is the array order.
 *
 * `botRoutes` after `bots` because a route names a bot, and in a single
 * `apply` that bot may not exist until this run creates it. Nothing else
 * references anything else, so the rest is ordered by how likely somebody is
 * to be looking for it.
 */
export const RESOURCES: ReadonlyArray<ResourceDef> = [
  {
    type: 'brands',
    label: 'brand',
    naturalKey: 'slug',
    keySource: 'authored',
    keyEnforced: true,
    list: { path: '/v1/brands', paged: false },
    idField: 'id',
    create: { path: '/v1/brands' },
    update: [{ method: 'PATCH', path: '/v1/brands/{id}' }],
    // A soft delete. 200 with `{ id }` — that id is the only confirmation.
    remove: { path: '/v1/brands/{id}' },
    removeBlocked: undefined,
    opaque: [],
    secrets: [],
    /*
     * `usage` is computed. The list route calls `listWithUsage`, so every row
     * carries `{ channels, conversations, triggers, workflows }` counts that
     * no write schema has ever heard of.
     */
    unwritable: [...SERVER_OWNED, 'usage'],
  },
  {
    type: 'bots',
    label: 'bot',
    naturalKey: 'slug',
    keySource: 'authored',
    keyEnforced: true,
    list: { path: '/v1/bots', paged: true },
    idField: 'id',
    create: { path: '/v1/bots' },
    update: [
      /*
       * The external agent's delivery config lives on its own route and comes
       * back nested. Listed FIRST so these three fields are claimed before
       * the catch-all sees them.
       */
      {
        method: 'PATCH',
        path: '/v1/bots/{id}/external',
        fields: ['webhookUrl', 'timeoutSeconds', 'fallbackMessage'],
      },
      { method: 'PATCH', path: '/v1/bots/{id}' },
    ],
    /*
     * There IS a `DELETE /v1/bots/{id}` (204), and `--prune` uses it. The
     * `slug` collision note below is the reason the create path is the
     * dangerous one here, not the delete path.
     */
    remove: { path: '/v1/bots/{id}' },
    opaque: ['signingSecret', 'callbackToken', 'token', 'systemPrompt'],
    /*
     * `type: "external"` answers with a signing secret AND a `cb_` token,
     * flattened onto the bot object, each shown once, with no route that
     * reads either back. `config.ts` prints the whole create response for
     * exactly this reason.
     */
    secrets: ['signingSecret', 'token', 'callbackToken'],
    /*
     * `slug` and `type` are create-only — the PATCH schema has neither. A
     * change of slug is a different bot (the old one becomes an orphan),
     * which is the honest reading, so `slug` is not listed here: it is the
     * natural key and `diff.ts` never diffs that.
     */
    unwritable: [
      ...SERVER_OWNED,
      'templateOrigin',
      'externalAgent',
      'signingSecretSet',
      'credentialId',
    ],
    project: (row) => {
      /*
       * Flatten `externalAgent`.
       *
       * The CREATE body takes `webhookUrl` / `timeoutSeconds` /
       * `fallbackMessage` at the top level; the READ returns them under
       * `externalAgent`, alongside a `signingSecretSet` boolean that stands
       * in for the secret. Without this a document that sets `webhookUrl`
       * reports a change on every single run, for ever.
       */
      const external = asRecord(row['externalAgent']);
      if (external === undefined) {
        return row;
      }
      return {
        ...row,
        webhookUrl: external['webhookUrl'],
        timeoutSeconds: external['timeoutSeconds'],
        fallbackMessage: external['fallbackMessage'],
      };
    },
  },
  {
    type: 'botRoutes',
    label: 'routing rule',
    /*
     * `name`, which is both the only candidate and the weakest key here.
     *
     * `ai_bot_routes` carries no unique index at all — only an eval index and
     * a bot index — so two rules may share a name. `keyEnforced: false` is
     * what makes `diff.ts` refuse a duplicate rather than guess, and the plan
     * says so on the line.
     */
    naturalKey: 'name',
    keySource: 'authored',
    keyEnforced: false,
    list: { path: '/v1/bot-routes', paged: false },
    idField: 'id',
    create: { path: '/v1/bot-routes' },
    update: [{ method: 'PATCH', path: '/v1/bot-routes/{id}' }],
    // 200 with `{ deleted: true }`.
    remove: { path: '/v1/bot-routes/{id}' },
    opaque: [],
    secrets: [],
    unwritable: [...SERVER_OWNED],
    /*
     * `bot: <slug>` instead of `botId: <uuid>`.
     *
     * The one reference this surface needs, and the one that decides whether
     * the whole document is portable. `botId` is a uuid the author cannot
     * know, which would pin the file to one environment — the exact thing it
     * exists to avoid. `bot` resolves against the live bot list plus whatever
     * this run is about to create, and an unresolvable one BLOCKS the route
     * rather than sending a null that zod would strip.
     */
    references: { bot: { type: 'bots', wire: 'botId' } },
  },
  {
    type: 'triggers',
    label: 'trigger',
    naturalKey: 'name',
    keySource: 'authored',
    keyEnforced: false,
    list: { path: '/v1/triggers', paged: true },
    idField: 'id',
    /*
     * `POST /v1/triggers` is an upsert keyed on the body's `id`, and an id the
     * workspace does not have is a 404 rather than a create — so there is no
     * such thing as creating a trigger at an id you chose. The id comes from
     * the live row this file matched by name; absent a match, the POST goes
     * without one and the server mints it.
     */
    create: { path: '/v1/triggers', upsert: true },
    update: [],
    /*
     * And it REPLACES. Every settable field is written unconditionally, so a
     * field the document omits reverts to its schema default — `priority`
     * goes to 0, `debounceSeconds` to null. `plan` prints that on every
     * trigger change rather than letting somebody discover it.
     */
    fullReplace: true,
    // 200 with `{ ok: true }`. A hard delete.
    remove: { path: '/v1/triggers/{id}' },
    opaque: [],
    secrets: [],
    /*
     * `brandId` is RETURNED on a read and is not in the upsert body — so a
     * document setting it would be silently stripped and the plan would
     * report the same change for ever. Refused at parse time instead.
     */
    unwritable: [...SERVER_OWNED, 'brandId'],
  },
  {
    type: 'macros',
    label: 'macro',
    /*
     * `shortCode`, not `name`. The short code is what an agent types, it is
     * the field the database makes unique, and two macros may legitimately
     * share a name across scopes.
     */
    naturalKey: 'shortCode',
    keySource: 'authored',
    keyEnforced: true,
    /*
     * The server's own normalisation, applied to BOTH sides before matching.
     *
     * `normaliseShortCode` strips a leading `/` and lowercases, and the DB
     * CHECK only permits `^[a-z0-9][a-z0-9_-]{0,63}$`. So `/Refund` in a
     * document is stored and returned as `refund`. Without this, that row
     * never matches, `apply` creates on every run, and the unique index
     * refuses it for ever — a config file that is permanently broken by a
     * capital letter.
     */
    normalizeKey: (key) => key.replace(/^\//, '').toLowerCase(),
    /*
     * `@PaginationExempt`: a bare array, capped at 200 rows and ordered by
     * language rank then usage. NOT a page — the shared manifest flagged it
     * `paged` for a day and two SDKs built a paginator over it. The cap is
     * also why `--prune` is refused when the answer comes back at full
     * length: a macro past the cap is invisible, not absent.
     */
    list: { path: '/v1/macros', paged: false },
    idField: 'id',
    create: { path: '/v1/macros' },
    update: [{ method: 'PATCH', path: '/v1/macros/{id}' }],
    // The only real 204 on the whole SDK surface: no body comes back.
    remove: { path: '/v1/macros/{id}' },
    opaque: [],
    secrets: [],
    unwritable: [...SERVER_OWNED, 'usageCount', 'userId', 'createdByUserId'],
  },
  {
    type: 'emailTemplates',
    label: 'email template',
    /*
     * `kind`, which is also the id: the write is
     * `PUT /v1/email-templates/{kind}`. The one resource here whose key space
     * is CLOSED — five kinds, all five always on the list read. So there is
     * no such thing as an orphan and `--prune` has nothing to do; a kind the
     * document omits is simply unmanaged.
     */
    naturalKey: 'kind',
    keySource: 'authored',
    keyEnforced: true,
    list: { path: '/v1/email-templates', paged: false },
    idField: 'kind',
    /*
     * No POST exists, and none is needed: all five kinds are always there, so
     * every write is an update of an existing row. A kind the catalogue does
     * not offer is reported as un-creatable by name.
     */
    create: null,
    /*
     * A PUT with a `.strict()` body of `{ subject, body }` — an unknown key
     * is a 400 here, which is the lucky case and not one to rely on
     * elsewhere. `kind` is a path segment and must NOT appear in the body;
     * `diff.ts` drops the natural key from every update body for this reason
     * among others.
     */
    update: [{ method: 'PUT', path: '/v1/email-templates/{id}', fields: ['subject', 'body'] }],
    updateBlocked:
      'the PUT body is `.strict()` and takes only `subject` and `body`. Everything else on a ' +
      'template row is the catalogue describing itself.',
    fullReplace: true,
    /*
     * DELETE here does not delete a template. It drops the workspace's
     * OVERRIDE and puts the built-in copy back, answering 200 with
     * `{ restored: false }` when there was nothing to drop. `--prune` does
     * not call it: reverting a kind the document merely does not mention is
     * not what "prune" means to anybody.
     */
    remove: null,
    removeBlocked:
      'DELETE /v1/email-templates/{kind} reverts to the built-in copy rather than deleting ' +
      'anything, and all five kinds always exist. Use `chatly email-templates reset <kind>`.',
    opaque: [],
    secrets: [],
    unwritable: ['label', 'whenSent', 'audience', 'builtInSummary', 'tokens', 'override'],
    project: (row) => {
      /*
       * The customised copy lives under `override`, or `override` is null and
       * this kind is on the built-in. A diff against `row.subject` compares
       * against a field that does not exist, so it reports a change on every
       * run — and `override: null` is precisely the state a first `apply`
       * is meant to leave behind.
       */
      const override = asRecord(row['override']);
      return {
        kind: row['kind'],
        subject: override?.['subject'],
        body: override?.['body'],
      };
    },
  },
  {
    type: 'customerCards',
    label: 'customer card',
    naturalKey: 'key',
    keySource: 'authored',
    keyEnforced: true,
    list: { path: '/v1/customer-cards', paged: false },
    idField: 'id',
    create: { path: '/v1/customer-cards' },
    /*
     * `position` is on the PATCH schema and NOT on the create schema, which
     * is `.strict()` — so a document that sets `position` on a card that does
     * not exist yet gets a 400 on the create and the right answer on the next
     * run. Left as it is rather than papered over: the API's 400 names the
     * key, and a CLI that silently dropped it would be the second renaming
     * layer `bodyFrom` refuses to add.
     */
    update: [{ method: 'PATCH', path: '/v1/customer-cards/{id}' }],
    // 200 with `{ ok: true }`.
    remove: { path: '/v1/customer-cards/{id}' },
    /*
     * `headers` is WRITE-ONLY by design. The read shape has no `headers`
     * field at all — it returns `headerNames: string[]`, names and never
     * values, because that is where a card's bearer token lives. A diff on it
     * would say "changed" on every single run, which is a diff nobody reads.
     */
    opaque: ['headers'],
    /*
     * The create answers `{ card: {...}, secret: "cc_…" }` — the secret
     * BESIDE the card rather than inside it, which is why `apply.ts` sweeps
     * the whole response envelope and not just the resource object.
     */
    secrets: ['secret'],
    unwritable: ['id', 'headerNames'],
    project: (row) => ({ ...row, headers: undefined }),
  },
  {
    type: 'webhooks',
    label: 'webhook endpoint',
    /*
     * The URL. A webhook endpoint has no name and no key, and the URL is the
     * thing that is actually unique about it in practice — two subscriptions
     * to one URL is a double delivery, not a configuration. The database does
     * NOT enforce it (`webhook_endpoints` has no index block at all), hence
     * `keyEnforced: false`.
     *
     * Compared byte for byte, so a trailing slash is a different endpoint
     * here because it is a different endpoint there.
     */
    naturalKey: 'url',
    keySource: 'authored',
    keyEnforced: false,
    list: { path: '/v1/webhooks', paged: false },
    idField: 'id',
    create: { path: '/v1/webhooks' },
    /*
     * There is NO general PATCH on a webhook endpoint. The only field that
     * can change in place is the pinned schema version, through a `.strict()`
     * `{ schemaVersion }` body. No catch-all route is listed, so `diff.ts`
     * reports a change to `eventTypes` as un-appliable and says what it would
     * cost — which is the honest answer, and better than a PATCH that 404s.
     */
    update: [
      {
        method: 'PATCH',
        path: '/v1/webhooks/{id}/schema-version',
        fields: ['schemaVersion'],
      },
    ],
    updateBlocked:
      'a webhook endpoint is frozen at create except for its pinned schema version: `url`, ' +
      '`eventTypes`, `description` and `enabled` have no PATCH. Changing one means delete and ' +
      'recreate, which mints a NEW `whsec_` signing secret and breaks your verifier until you ' +
      'deploy it — so this CLI will not do it behind a diff. Change the url in the document ' +
      'instead: the new one is created and the old one is reported as an orphan.',
    // 200 with `{ ok: true }`. A hard delete.
    remove: { path: '/v1/webhooks/{id}' },
    /*
     * `secret` is never read back: the list selects six columns precisely to
     * exclude it, there is no reveal route and no rotate route. Lose it and
     * the only recovery is delete plus recreate.
     */
    opaque: ['secret'],
    secrets: ['secret'],
    unwritable: ['id', 'workspaceId', 'createdAt', 'updatedAt', 'missingEventTypes'],
  },
  {
    type: 'docsSources',
    label: 'documentation source',
    /*
     * `label`. The alternatives are worse: `provider` repeats, `spaceId` is
     * provider-specific, and the id is a uuid. It carries no constraint
     * (`docs_sources` has only a workspace index and a due index) and it
     * DEFAULTS to the generated collection name when omitted — so a document
     * must set it explicitly, and `keyEnforced: false` makes a duplicate a
     * refusal rather than a guess.
     */
    naturalKey: 'label',
    keySource: 'authored',
    keyEnforced: false,
    list: { path: '/v1/docs-sources', paged: false },
    idField: 'id',
    create: { path: '/v1/docs-sources' },
    /*
     * Six fields, and that is all. `provider`, `spaceId`, `organizationId`,
     * `includePaths` and `excludePaths` are create-only — a change to one is
     * reported rather than sent to a route that strips it and answers 200.
     */
    update: [
      {
        method: 'PATCH',
        path: '/v1/docs-sources/{id}',
        fields: ['label', 'status', 'publishOnSync', 'syncIntervalMinutes', 'token', 'baseUrl'],
      },
    ],
    updateBlocked:
      '`provider`, `spaceId`, `organizationId`, `includePaths` and `excludePaths` are fixed at ' +
      'create. Disconnect and reconnect the source (`chatly docs-sources delete <id>` keeps ' +
      'the articles it imported) or give the new one a different `label`.',
    // Disconnects the source and KEEPS the articles, re-labelled `manual`.
    // 200 with `{ kept: n }`. Safe enough to prune when asked.
    remove: { path: '/v1/docs-sources/{id}' },
    // The provider token is write-only; no DTO field carries it back.
    opaque: ['token'],
    secrets: [],
    unwritable: [
      'id',
      'spaceTitle',
      'spaceKind',
      'lastSyncedAt',
      'lastError',
      'lastArticleCount',
      'articleCount',
      'syncStatus',
      'unreadableCount',
      'staleCount',
      'webhookSubscribed',
      'webhookLastEventAt',
      'webhookCapable',
      'collectionId',
    ],
  },
  {
    type: 'channels',
    label: 'channel',
    /*
     * Server-owned. See the header: `publicId` is a GLOBALLY unique
     * reservation rather than a name, `type` and `publicId` are immutable,
     * `config` reads back redacted, and the create response carries
     * provider-webhook registration results a diff cannot model. A
     * `channels:` section is refused by `document.ts`. The row stays here so
     * the refusal can name the type, the routes and the reason.
     */
    naturalKey: 'publicId',
    keySource: 'server',
    keyEnforced: true,
    list: { path: '/v1/channels', paged: false },
    idField: 'id',
    create: null,
    update: [{ method: 'PATCH', path: '/v1/channels/{id}' }],
    // There IS a DELETE, on its own controller — 200 with
    // `{ deleted, id, type, detachedConversations }`.
    remove: { path: '/v1/channels/{id}' },
    opaque: ['config'],
    secrets: ['secret'],
    unwritable: [...SERVER_OWNED, 'type', 'publicId', 'originsRestricted', 'embed', 'brandId'],
  },
];

export const RESOURCE_TYPES: ReadonlyArray<string> = RESOURCES.map((r) => r.type);

const BY_TYPE = new Map(RESOURCES.map((r) => [r.type, r]));

export function resourceDef(type: string): ResourceDef | undefined {
  return BY_TYPE.get(type);
}
