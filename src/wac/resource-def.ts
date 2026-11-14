/**
 * The SHAPE of a resource definition, and the helpers that read one.
 *
 * Split out of `resources.ts` only because the two together ran past the
 * 650-line ceiling (`scripts/check-file-size.mjs`). The division is the
 * useful one anyway: this file is the vocabulary, `resources.ts` is the nine
 * answers written in it, and reading one does not require reading the other.
 * `resources.ts` re-exports everything here, so every importer sees one
 * module.
 */

/** The verbs a document can cause. */
export type Action = 'create' | 'update' | 'noop' | 'orphan' | 'blocked';

export interface ResourceRef {
  /** The resource type the value names. */
  readonly type: string;
  /** The field the API actually reads, which the ref resolves into. */
  readonly wire: string;
  /**
   * The resolved id fills a `{wire}` placeholder in the ROUTE PATH rather
   * than a field in the body.
   *
   * Every workspace-level resource here is reached at a flat collection path
   * and names its parent in the body (`botRoutes` sends `botId`). The
   * Platform API is the opposite shape: a user, a key, a bot credential and a
   * knowledge source all live under
   * `/v1/platform/workspaces/{workspaceId}/…`, and the workspace id is a path
   * segment that no request body accepts.
   *
   * It matters that these are different rather than interchangeable. zod
   * strips an unknown key, so sending `workspaceId` in the body of
   * `POST /v1/platform/workspaces/{id}/users` would be dropped in silence and
   * the route would answer 201 — the failure mode CLAUDE.md names twice. A
   * path ref is therefore excluded from the body AND excluded from the diff:
   * the live row has no such field, so comparing it would report a change on
   * every single run.
   */
  readonly pathParam?: boolean;
}

export interface UpdateRoute {
  /**
   * `POST` is here for one shape only: a route whose POST ADOPTS an existing
   * resource and merges into it rather than creating a second one.
   * `POST /v1/platform/workspaces/{id}/widget_channel` is the instance —
   * `created: false` is its normal answer. A POST that creates is `create`,
   * not an update route.
   */
  readonly method: 'PATCH' | 'PUT' | 'POST';
  /** `{id}` is replaced with the encoded live id. */
  readonly path: string;
  /**
   * The ONLY fields this route can change. Omitted means "anything not
   * claimed by a more specific route" — the catch-all. A resource with no
   * catch-all can only change the fields its routes name, and a diff on any
   * other field is reported as un-appliable instead of being sent somewhere
   * that will strip it and answer 200.
   */
  readonly fields?: ReadonlyArray<string>;
}

export interface ResourceDef {
  /** The key under `resources:` and the word in every plan line. */
  readonly type: string;
  /** Singular, for a sentence. */
  readonly label: string;
  /** The field holding the natural key, in the document and on the live row. */
  readonly naturalKey: string;
  readonly keySource: 'authored' | 'server';
  /** True when the database enforces the key. False when only this file does. */
  readonly keyEnforced: boolean;
  /** A shape the authored key must have, checked at parse time rather than on a 400 at apply. */
  readonly keyPattern?: RegExp;
  /** Appended to the "rows with no key" warning: how to give an existing row one. */
  readonly keylessHint?: string;
  /** The server's own normalisation, applied to both sides before matching. */
  readonly normalizeKey?: (key: string) => string;
  /**
   * ONE row per workspace, no id, no create, no delete (CH-24).
   *
   * The section in the document is an OBJECT, not an array, and the author
   * writes no natural key: `parseSection` stamps `SINGLETON_KEY` on, and
   * `rowsFrom` stamps the same value onto the live answer. Everything
   * downstream then works on a row set of one, unchanged.
   *
   * The alternative was making the author write `"key": "default"` into
   * every file, which is a magic string with no meaning to the person typing
   * it and one more thing to get wrong in a document that is already the
   * thing standing between them and production.
   */
  readonly singleton?: boolean;
  /**
   * The API-key scopes this resource's LIST route and its WRITE routes
   * require (CH-17).
   *
   * Beside the routes they gate, not in a table of their own, because that is
   * the only placement a new resource cannot forget: a def has to say both or
   * `wac/scopes.spec.ts` fails. A separate `command -> scopes` table is the
   * thing FormFlow is actually complaining about — "nothing says whether the
   * eight scopes our CI key holds are minimal or complete" — and a
   * hand-maintained answer to that goes stale the first time a route moves.
   *
   * Read off the handlers in `apps/api/src/modules/**`, never off the route's
   * name, which is the rule the rest of this table is built on. Several do
   * not match what you would guess: `GET /v1/bots` requires
   * `triggers:read` and its writes require `ai:configure`; a documentation
   * source reads on `kb:read` and writes on `kb:write:sources`; brands,
   * email templates and business hours all sit on plain `workspace:*`.
   *
   * Optional ONLY because the Platform API's resources speak a different
   * scope vocabulary (`platform:*`, on a `cp_` credential) and `chatly
   * whoami --for` does not answer for them.
   */
  readonly readScope?: string;
  readonly writeScope?: string;
  readonly list: { readonly path: string; readonly paged: boolean };
  /**
   * Which rows of the list route actually EXIST.
   *
   * The model assumes a list route returns the set that exists, and
   * `/v1/privacy/partners` does not: it enumerates the whole provider
   * REGISTRY and marks each `enabled: true|false`. Without this, every
   * provider the document does not name looks like an orphan `--prune`
   * should delete, and a provider it does name looks like it already exists.
   *
   * Filtered at the fetch, not in the diff, so `plan`, `apply` and `--prune`
   * cannot disagree about what is there.
   */
  readonly existsWhen?: (row: Readonly<Record<string, unknown>>) => boolean;
  /** The field on a live row that identifies it in a write path. */
  readonly idField: string;
  readonly create: {
    readonly path: string;
    /** POST is an upsert keyed on the body's `id`, not a plain create. */
    readonly upsert?: boolean;
    /**
     * `PUT` for a resource whose create and update are ONE route keyed on the
     * natural key, as `/v1/privacy/partners/{provider}` is. `{id}` in the
     * path is filled from the authored key, which such a resource knows
     * before the server has seen it; POST (the default) fills it with ''.
     *
     * Only valid with `keySource: 'authored'` — a server-assigned key does
     * not exist yet at create time, so there would be nothing to PUT to.
     */
    readonly method?: 'POST' | 'PUT';
  } | null;
  /** Empty means there is no way to change one in place. */
  readonly update: ReadonlyArray<UpdateRoute>;
  /** Said when a changed field matches no update route. */
  readonly updateBlocked?: string;
  /**
   * The write REPLACES the resource: a field the document omits reverts to
   * its default. `plan` says so on every change to one of these.
   */
  readonly fullReplace?: boolean;
  /** `null` when `--prune` cannot delete one; `removeBlocked` says why. */
  readonly remove: { readonly path: string } | null;
  readonly removeBlocked?: string;
  /**
   * Object fields the server MERGES into what it holds (`settings`'
   * `businessHours`, `routing`, `widgetChannel`): compared on the keys the
   * document names, recursively, because a key it omits is kept as stored.
   */
  readonly mergeFields?: ReadonlyArray<string>;
  /**
   * Fields that are never readable back, so a diff must not claim they
   * changed. Half the answer; the other half is the `__redacted__` sentinel,
   * detected at runtime in `diff.ts`.
   */
  readonly opaque: ReadonlyArray<string>;
  /**
   * Fields a CREATE answers with exactly once. A floor, not a fence:
   * `apply.ts` also sweeps every response for anything that looks like a
   * credential, so a field added next month is surfaced rather than dropped.
   */
  readonly secrets: ReadonlyArray<string>;
  /**
   * Fields THIS ROW supplies that the route accepts and throws away, because
   * of another field's value — field name to the reason, which `plan` prints.
   *
   * `droppedFields` already answers the unconditional case from the route's
   * own allowed set. This is the conditional one, which no generated table
   * can hold: `webhookUrl` is a real field on `POST /v1/bots` and is kept
   * only for `type: "external"`, and `preset`/`url` on an AI tool are an
   * install instruction that expands into other columns. Both read back as
   * absent, so diffing one makes a row no `apply` can settle and that writes
   * to production on every run (ForgeDeck 2026-11-07 items 2 and 4).
   *
   * `live` is the matched server row, or `undefined` on a create. The rules
   * live in `resource-conditionals.ts`.
   */
  readonly discards?: (
    body: Readonly<Record<string, unknown>>,
    live: Readonly<Record<string, unknown>> | undefined,
  ) => Readonly<Record<string, string>>;
  /**
   * Returned on a read and accepted by NO write path. A document declaring
   * one is refused at parse time: zod would strip it and answer 200, and the
   * author would never find out.
   */
  readonly unwritable: ReadonlyArray<string>;
  /**
   * Fields the write route requires, as a non-empty value.
   *
   * ForgeDeck 2026-11-05 item 4: a document omitting `cbid`, and one setting
   * it to `""`, both planned as `create` and exited 0; `apply` then failed
   * with `cbid: Required` and `String must contain at least 1 character(s)`.
   * `plan` exists to answer that question before anything is written, and it
   * had the whole document in hand.
   *
   * This is a declared list rather than the route's own zod schema because the
   * CLI is a published package that cannot import `apps/api`. It is the same
   * shape of hardcode as `unwritable` and `opaque` beside it, and it drifts the
   * same way — a field becoming required server-side makes this list short, and
   * a short list under-warns rather than refusing a valid document, which is
   * the right direction to be wrong in.
   */
  readonly requiredFields?: ReadonlyArray<string>;
  /**
   * A row that cannot be CREATED by any write this CLI can send, because
   * something outside the document has to happen first — the reason, or
   * undefined for every row that is fine.
   *
   * One resource needs it (CH-10). A `docsSources` row declaring
   * `provider: forumulate` and no `token` is the shape the customer asked
   * for: the credential is obtained by an approved connection rather than
   * pasted, and `POST /v1/docs-sources/connect/forumulate` needs a live
   * Atlas SESSION token out of an operator's browser, which a CLI holding an
   * API key does not have and cannot mint. So the write is impossible here —
   * not refused, not drifted, impossible — and the only honest `apply` is one
   * that writes nothing and says what the human has to do once.
   *
   * It is `blockedCreate` and not `requiredFields` or an `extraWarnings` line
   * because both of those WARN and let `apply` send the body anyway: it would
   * answer 400 (`token: Required`), which is a failure the operator cannot
   * act on and which reads as a broken document rather than a pending
   * approval. `blocked` is the existing action for "this CLI will not send
   * it", it skips the row, and it exits non-zero — which is the point. A
   * tokenless source must never be reported as applied while a person still
   * has to click something.
   *
   * CREATE only. Once the approval has happened the live row exists, its
   * credential is stored, and the document matches it — the next `plan` is a
   * `noop` and the pipeline is green with no second rule.
   */
  readonly blockedCreate?: (body: Readonly<Record<string, unknown>>) => string | undefined;
  /**
   * Rules only this resource has, checked against the live rows.
   *
   * A hook rather than more declarative fields on every def: the two rules
   * that wanted it (a `completionsUrl` host allow-list, and the URL needing a
   * secret) belong beside the resource that has them, and encoding them here
   * would add fields no other resource sets. Returns warning lines; it must
   * only OBSERVE, like everything else in `diff-warnings.ts`.
   */
  /**
   * Resource-specific `plan` warnings: the rules the server enforces that no
   * generic check can see.
   *
   * `liveRows` is the list route's UNFILTERED answer — before `existsWhen`.
   * That matters and was wrong first: the privacy resource reads the server's
   * host allow-list off a live row, and on a first create the only row that
   * carries it is the unbound one `existsWhen` removes, so every rule keyed on
   * it silently did nothing on exactly the call that needed it most.
   */
  /**
   * Replaces the generic `fullReplace` sentence, for a resource where "every
   * omitted field reverts to its default" is not what the server does.
   *
   * `fullReplace` governs what `apply` SENDS; this governs what `plan` SAYS
   * will happen. They came apart on `privacyPartners`, where the flag is
   * required (a PUT without the mandatory `cbid` is a 400) and the sentence
   * was false (the service keeps what the caller omitted).
   */
  readonly fullReplaceNote?: string;
  /**
   * Fields whose wrong-type warning this resource issues ITSELF, so the
   * generic one must not also fire.
   *
   * `privacyPartners` printed each one twice (ForgeDeck 2026-11-06 item 3,
   * reproduced twice): the generic check began running on every resource
   * while `resources-privacy.ts` kept its own. The resource's copy is the one
   * kept, because it is worded by whether the row is SENT — on an unchanged
   * live pair it says "nothing is sent on this run" where the generic one
   * would claim a refusal that never happens, and that distinction is itself
   * a fix from the report before this one.
   */
  readonly ownTypeChecks?: ReadonlyArray<string>;

  readonly extraWarnings?: (
    rows: ReadonlyArray<{ key: string; body: Record<string, unknown> }>,
    liveRows: ReadonlyArray<Record<string, unknown>>,
    /*
     * Whether `apply` will SEND this row, by document key (normalized for
     * you). A rule that predicts a server refusal has to know this, because
     * an unchanged row is never sent and so is never refused: ForgeDeck's
     * seventh report, 2026-11-06 item 2, reproduced twice — a warning said
     * "the server refuses it" about a row `apply` exits 0 on without
     * contacting the server. It is the same mistake the SIXTH report's item 1
     * found in the refusal COUNT; the count was fixed and the wording beside
     * it was left saying the old thing.
     *
     * Note `--write-only` flips it: credentials are sent then, so the row
     * does change and the server does refuse it. That is why this is the real
     * plan action and not "does the row differ from live".
     */
    willSend: (key: string) => boolean,
  ) => ReadonlyArray<string>;
  /**
   * The live row is itself in a BAD STATE — not different from the document,
   * broken (CH-05).
   *
   * Every other thing in this file answers "does the server match the file".
   * This answers "is the thing the file describes working", and the two are
   * independent: FormFlow's `chatly plan` printed `0 to create, 0 to change,
   * 4 unchanged` and exited 0 while two of three knowledge sources had failed
   * their last sync. Every field the document declares DID match; nobody had
   * looked at `syncStatus`.
   *
   * `note` goes on the plan line. `failed` makes `plan` exit 3 and stops
   * `apply`'s read-back saying "everything matches the document" — because it
   * does match, and the thing is still broken, and printing only the first
   * half is how a deploy gate goes green over a dead knowledge base.
   *
   * It must only OBSERVE: it is called on a row `plan` has already read, and
   * it never changes what is written.
   */
  readonly liveState?: (
    live: Readonly<Record<string, unknown>>,
  ) => { readonly note: string; readonly failed: boolean } | undefined;
  /** The live row, reshaped into the vocabulary the document writes. */
  readonly project?: (row: Record<string, unknown>) => Record<string, unknown>;
  /** Document-only keys naming another resource by ITS natural key. */
  readonly references?: Readonly<Record<string, ResourceRef>>;
  /**
   * The rows out of a list response that is not itself the array.
   *
   * Every workspace-level list route answers either a bare array or
   * `{ items, nextCursor }`, which `readLive` handles directly. The Platform
   * API has one list that is neither: a workspace's MEMBERS come back as
   * `users` on `GET /v1/platform/workspaces/{id}` — the detail route — because
   * there is no `…/users` list route at all. Declared rather than special-cased
   * in the reader so the reader stays one loop.
   */
  readonly rowsFrom?: (response: unknown) => ReadonlyArray<Record<string, unknown>>;
  /**
   * A live row this document can never match, and must not be matched to.
   *
   * `GET /v1/platform/workspaces/{id}/api_keys` keeps a REVOKED key in the
   * list with `revokedAt` set, and so does the bot-credential list. A
   * revoked credential is not a credential: matching a document row to one
   * would report `noop` for a key that authenticates nothing, which is the
   * worst possible answer — the plan would say the workspace matches the file
   * while the deploy pipeline it describes is locked out. Filtered out, so
   * the document's row is a `create` and `apply` mints a live one.
   *
   * It is NOT the same thing as an orphan: a filtered row is invisible, so
   * `--prune` never offers to delete it either, which is right for a row the
   * DELETE route would answer `revoked: false` to.
   */
  readonly ignoreLive?: (row: Record<string, unknown>) => boolean;
  /**
   * The resource that OWNS this one, for a type whose list route is nested
   * under a parent's id.
   *
   * Present only on the Platform API's resources. Its consequence is that
   * `naturalKey` is a SYNTHETIC field — the parent's key and the child's,
   * joined — because `a@b.c` identifies a user inside one workspace and
   * nothing at all across a document that describes four of them. The reader
   * stamps that field onto every live row it fetches; the parser composes the
   * same value from the document. Neither side ever diffs it, because
   * `diff.ts` skips the natural key.
   */
  readonly parent?: {
    /** The owning resource type. */
    readonly type: string;
    /** The document key that names the parent (`workspace`). */
    readonly field: string;
    /** The path placeholder the parent's id fills (`workspaceId`). */
    readonly wire: string;
    /** The field that names the child within its parent (`email`, `name`). */
    readonly childKey: string;
  };
}

/** The synthetic natural key of a parented resource: `<parent>/<child>`. */
export function addressOf(parentKey: string, childKey: string): string {
  return `${parentKey}/${childKey}`;
}

/** The server's spelling of a key, for matching. */
/**
 * Every natural key in a list answer, normalised, skipping rows that have none.
 *
 * Used on the UNFILTERED answer of an `existsWhen` resource, so the plan can
 * tell "the server has no such thing" from "the server has it and nobody has
 * opted in" — two outcomes `existsWhen` deliberately collapses into one.
 */
export function naturalKeys(
  def: ResourceDef,
  rows: ReadonlyArray<Record<string, unknown>>,
): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const key = row[def.naturalKey];
    if (typeof key === 'string' && key.length > 0) {
      out.push(normalizedKey(def, key));
    }
  }
  return out;
}

export function normalizedKey(def: ResourceDef, key: string): string {
  return def.normalizeKey === undefined ? key : def.normalizeKey(key);
}

/** The live row in the vocabulary the document writes. */
export function projected(def: ResourceDef, row: Record<string, unknown>): Record<string, unknown> {
  return def.project === undefined ? row : def.project(row);
}

/**
 * Which update route owns a field, or `undefined` if none does.
 *
 * A route with no `fields` is the catch-all and is tried last, so a field a
 * specific route claims (`webhookUrl` → `/v1/bots/{id}/external`) is never
 * swept into the general PATCH.
 */
export function routeForField(def: ResourceDef, field: string): UpdateRoute | undefined {
  return (
    def.update.find((r) => r.fields?.includes(field) === true) ??
    def.update.find((r) => r.fields === undefined)
  );
}

/**
 * Anything that reads like a credential, by NAME.
 *
 * `secrets` on each definition is a hand-written list, and a hand-written
 * list goes stale — the failure CLAUDE.md names twice, where a gate's green
 * line counts what it managed to parse rather than what exists. So `apply`
 * also runs every write response through this, and a field called
 * `webhookToken` that nobody told this file about is still surfaced to the
 * operator instead of being dropped on the floor. False positives are cheap:
 * the cost is one extra line of output.
 */
export function looksLikeCredential(field: string): boolean {
  return /secret|token|password|credential|privatekey|apikey/i.test(field);
}
