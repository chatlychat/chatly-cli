/**
 * Reading the live platform surface. Every call here is a GET.
 *
 * ═══ THE ONE DECISION THAT SHAPES THIS FILE ═══════════════════════════════
 *
 * **A platform document is a SUBSET of the tenants a credential owns, so a
 * workspace the file does not mention is not drift.**
 *
 * `wac/diff.ts`'s first rule says the same thing one level down — "a server
 * field the file says nothing about is unmanaged and is never mentioned" —
 * and the consequence here is bigger. A reseller with four hundred tenants
 * and a document describing one would otherwise get a plan whose first four
 * hundred lines are "on the server, not in this document", and a plan nobody
 * reads is worse than no plan because it gets approved. Worse, the shape
 * would invite `--prune` at a tenant, which is why `workspaces.remove` is
 * `null` as a second lock.
 *
 * So this reader filters the workspace list down to the slugs the document
 * names, and says in a WARNING how many it left alone. That is the honest
 * middle: the number is visible, and it is not presented as something to fix.
 *
 * It also bounds the request count. Children are nested under a workspace
 * id, so reading them for every tenant a credential owns is four reads per
 * tenant — twelve hundred GETs to plan a one-tenant document, against a
 * `platform-provision` throttle of 20/minute on the writes and no reason to
 * find out what the reads' limit is.
 *
 * ═══ WHICH SLUGS COUNT AS DECLARED ════════════════════════════════════════
 *
 * The union of the `workspaces:` section's keys AND every `workspace:` a
 * child row names. The second half matters: adopting an existing tenant —
 * adding a deploy key to a workspace somebody else created — is a document
 * with an `apiKeys` row and no `workspaces` row at all, and that is a shape
 * to support rather than refuse. The reference resolves against the live
 * list, and if the slug is not there `diff.ts` blocks the row with "neither
 * on the server nor created by this plan".
 *
 * ═══ WHY THE DETAIL ROUTE IS FETCHED ONCE ═════════════════════════════════
 *
 * `users` has no list route of its own: members come back as `users[]` on
 * `GET /v1/platform/workspaces/{id}`. If a second resource ever reads from
 * that same route, declaring it is enough — `GET`s are memoised by path
 * within one call, so two resources over one route cost one request.
 */

import { addressOf, type ResourceDef } from '../wac/resource-def.js';

import type { LiveSection } from '../wac/diff.js';
import type { WacDocument } from '../wac/document.js';
import type { ChatlyClient } from '@chatlychat/sdk-node';

/**
 * The cap `KbIngestService.list` applies, and the bound the two
 * `@PaginationExempt`-shaped credential lists sit behind.
 *
 * `wac/workspace-as-code.ts` uses the same number for the same reason: a bare
 * array that comes back at exactly its cap MAY be truncated, and a row past
 * the cap is invisible rather than absent — which would make it an orphan and
 * then, with `--prune`, a deletion. `diff.ts` refuses prune for a type in
 * that state.
 */
const EXEMPT_LIST_CAP = 200;

/** How many pages of `GET /v1/platform/workspaces` to walk before stopping. */
const PAGE_GUARD = 200;

export interface PlatformLive {
  readonly live: Map<string, LiveSection>;
  /** Observations about the surface, merged into the plan's own warnings. */
  readonly warnings: ReadonlyArray<string>;
}

/** Slug → the live workspace row, for the slugs this document names. */
type Workspaces = Map<string, Record<string, unknown>>;

function asRows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

/** Every workspace slug this document refers to, declared or referenced. */
export function declaredSlugs(doc: WacDocument): Set<string> {
  const out = new Set<string>();
  for (const section of doc.sections) {
    if (section.def.parent === undefined) {
      for (const row of section.rows) {
        out.add(row.key);
      }
      continue;
    }
    const { field } = section.def.parent;
    for (const row of section.rows) {
      /*
       * Off the ROW rather than off `row.refs`, because a row whose parent
       * field was missing or malformed never reaches here — `parseDocument`
       * throws before this is called. The ref map is keyed by the WIRE name
       * and holds the same value; reading the source field keeps this
       * readable against the document rather than against the request.
       */
      const named = (row.body as Record<string, unknown>)[field] ?? row.refs[field];
      const fromRefs = Object.values(row.refs).find((r) => r.type === section.def.parent?.type);
      const slug = typeof named === 'string' ? named : fromRefs?.key;
      if (typeof slug === 'string' && slug.length > 0) {
        out.add(slug);
      }
    }
  }
  return out;
}

/**
 * The live rows for every type the document mentions, and nothing else.
 *
 * All through `chatly.request` — the escape hatch `packages/sdk-spec/CONTRACT.md`
 * defines — so auth, retries and the typed errors are the same ones every
 * other command gets, and `apps/cli` still adds no HTTP of its own. There is
 * no SDK method for any of these: `surface.json` holds no `/v1/platform` path
 * at all, which the manifest's own note records.
 */
export async function readPlatformLive(
  chatly: ChatlyClient,
  doc: WacDocument,
): Promise<PlatformLive> {
  const warnings: string[] = [];
  const live = new Map<string, LiveSection>();
  const wanted = declaredSlugs(doc);

  const workspaces = await readWorkspaces(chatly, wanted, warnings);

  // Always set: a document with no `workspaces:` section still resolves its
  // children's `workspace:` against these rows. The command passes them to
  // `buildPlan` as `referenced` in that case, so they are never planned.
  live.set('workspaces', { rows: [...workspaces.values()] });

  /** `GET`s already made in this call, by path. See the header. */
  const fetched = new Map<string, unknown>();
  const get = async (path: string): Promise<unknown> => {
    const cached = fetched.get(path);
    if (cached !== undefined) {
      return cached;
    }
    const answer = await chatly.request<unknown>('GET', path);
    fetched.set(path, answer);
    return answer;
  };

  for (const section of doc.sections) {
    const { def } = section;
    if (def.parent === undefined) {
      continue;
    }
    const rows: Array<Record<string, unknown>> = [];
    let truncated = false;
    /*
     * A SINGLETON child — one per workspace, named by the workspace itself
     * (`settings`: `childKey` IS the parent field). Its key is `<slug>/<slug>`
     * on both sides, and it is read only for the workspaces this section
     * declares: a tenant's settings exist whether or not the file mentions
     * them, so reading the others would report each one as an orphan.
     */
    const singleton = def.parent.childKey === def.parent.field;
    for (const [slug, workspace] of workspaces) {
      const id = workspace['id'];
      if (typeof id !== 'string' || id.length === 0) {
        continue;
      }
      if (singleton && !section.rows.some((r) => r.key === addressOf(slug, slug))) {
        continue;
      }
      const path = def.list.path.replaceAll(`{${def.parent.wire}}`, encodeURIComponent(id));
      const answer = await get(path);
      const found = def.rowsFrom === undefined ? asRows(answer) : [...def.rowsFrom(answer)];
      if (def.rowsFrom === undefined && found.length >= EXEMPT_LIST_CAP) {
        truncated = true;
      }
      for (const row of found) {
        /*
         * The two stamps, and they are what let the shared engine plan a
         * nested surface without knowing about one.
         *
         * `address` is the synthetic natural key — `<slug>/<child>` — which
         * `indexLive` matches on and `diff.ts` never compares, because it
         * skips the natural key. `workspaceId` is the parent id a nested
         * write path needs; stamped onto every row so an ORPHAN, which has
         * no document row to resolve a reference from, still carries the id
         * its DELETE path requires.
         */
        rows.push({
          ...row,
          [def.naturalKey]: addressOf(
            slug,
            singleton ? slug : String(row[def.parent.childKey] ?? ''),
          ),
          [def.parent.wire]: id,
        });
      }
      warnings.push(...expiryWarnings(def, slug, found));
    }
    live.set(def.type, truncated ? { rows, possiblyTruncated: true } : { rows });
  }

  return { live, warnings };
}

/**
 * The workspace list, walked to the end, kept down to the declared slugs.
 *
 * Paged since 2026-10-23 — it was a bare array behind a `@PaginationExempt`
 * whose own schema docblock now calls the exemption unsound. Walked by hand
 * rather than through `autoPaginate` because the envelope matters: this one
 * answers `{ items, nextCursor, hasMore }` while its `@PaginationExempt`
 * neighbours on the same surface answer bare arrays, and conflating the two
 * is the bug CLAUDE.md records two SDKs shipping.
 *
 * `?status=` is deliberately NOT passed. Omitting it answers everything that
 * is not soft-deleted, suspended tenants included, which is the right set: a
 * suspended workspace exists and there is no platform route that un-suspends
 * it, so matching the document row to it and reporting `noop` is true. A
 * soft-deleted one is absent, so its document row is a `create` — and that
 * create 409s on the slug, which is a better answer than silently adopting a
 * tenant that is counting down to purge.
 */
async function readWorkspaces(
  chatly: ChatlyClient,
  wanted: ReadonlySet<string>,
  warnings: string[],
): Promise<Workspaces> {
  const out: Workspaces = new Map();
  let total = 0;
  let cursor: string | undefined;
  for (let guard = 0; guard < PAGE_GUARD; guard += 1) {
    const page = await chatly.request<{ items?: unknown; nextCursor?: unknown }>(
      'GET',
      '/v1/platform/workspaces',
      { query: cursor === undefined ? {} : { cursor } },
    );
    const items = asRows(page.items);
    total += items.length;
    for (const row of items) {
      const slug = row['slug'];
      if (typeof slug === 'string' && wanted.has(slug)) {
        out.set(slug, row);
      }
    }
    const next = page.nextCursor;
    if (typeof next !== 'string' || next.length === 0 || next === cursor) {
      break;
    }
    cursor = next;
  }

  const unmentioned = total - out.size;
  if (unmentioned > 0) {
    warnings.push(
      `${String(unmentioned)} workspace(s) this credential owns are not in this document. They ` +
        'are not listed below and are not drift: a platform document describes a SUBSET of a ' +
        "reseller's tenants, so `--prune` is never offered one — and `DELETE " +
        '/v1/platform/workspaces/{id}` soft-deletes every conversation in it.',
    );
  }
  return out;
}

/**
 * A credential in the list that has EXPIRED, named rather than matched on.
 *
 * `ignoreLive` drops a REVOKED key, because `revokedAt` is a fact on the row
 * and needs no clock. Expiry does need one, and `buildPlan` is pure — no
 * transport, no filesystem, no clock, which is half the proof that `plan`
 * writes nothing. Putting `Date.now()` inside it would buy a slightly better
 * match and spend that property, so the check lives here, in the reader,
 * which is already doing HTTP.
 *
 * The consequence is honest and stated: an expired key still MATCHES its
 * document row and still reports `noop`. The warning is what tells you the
 * row the plan called unchanged authenticates nothing. `expiresAt` is
 * readable, so a document that declares it sees the drift directly — this is
 * for the common case of a document that omits it and takes the route's
 * 365-day default.
 */
function expiryWarnings(
  def: ResourceDef,
  slug: string,
  rows: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<string> {
  if (!def.secrets.includes('token')) {
    return [];
  }
  const now = Date.now();
  const dead = rows
    .filter((row) => {
      if (def.ignoreLive?.(row) === true) {
        return false;
      }
      const at = row['expiresAt'];
      return typeof at === 'string' && Number.isFinite(Date.parse(at)) && Date.parse(at) <= now;
    })
    .map((row) => String(row['name'] ?? '(unnamed)'));
  if (dead.length === 0) {
    return [];
  }
  return [
    `${def.type}: ${dead.map((n) => `\`${slug}/${n}\``).join(', ')} ` +
      `${dead.length === 1 ? 'has' : 'have'} expired and ${dead.length === 1 ? 'is' : 'are'} ` +
      'still listed, so the plan below reports them as unchanged — the row exists and matches ' +
      'the document. They authenticate nothing. Rename them in the document to mint ' +
      'replacements and orphan these, or revoke them with ' +
      `\`chatly api DELETE ${def.remove?.path ?? ''}\`.`,
  ];
}
