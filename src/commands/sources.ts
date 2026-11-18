/**
 * `chatly sources` — every knowledge source in the workspace, both tables.
 *
 * ═══ WHAT WAS MISSING, AND IT WAS NOT WHAT WAS REPORTED ═══════════════════
 *
 * The report (CH1, an integrator recheck) said no CLI command could list,
 * update or delete the source that platform provisioning had created.
 * `chatly docs-sources` has covered list, providers, discover, create,
 * update, sync, subscribe and delete since 0.9.0, so that half is refuted —
 * but the reporter was right that they could not see their source, and the
 * reason is that a knowledge source lives in one of TWO tables:
 *
 *   `docs_sources`       a documentation provider (Forumulate, GitBook, …),
 *                        and a sitemap `website` crawl declared through
 *                        `POST /v1/docs-sources`. Served by `/v1/docs-sources`.
 *   `kb_ingest_sources`  a URL crawl or an ingested PDF — which is what
 *                        `/v1/platform/.../knowledge_sources` provisioning
 *                        creates. Served by `/v1/kb-ingest/sources`.
 *
 * `GET /v1/docs-sources` lists the first table ONLY (its own description says
 * so), so `chatly docs-sources list` answered `(no results)` for a workspace
 * whose one source was a provisioned crawl, and `PATCH`/`DELETE
 * /v1/docs-sources/{id}` answered 404 for its id. Nothing in the CLI had ever
 * called `/v1/kb-ingest/sources` at all.
 *
 * So this group is not a second spelling of `docs-sources`. It is the one
 * list — `GET /v1/kb-ingest/sources?include=all`, which the API already
 * offers as the answer to "what is in my knowledge base and did it work" —
 * and the reads and writes dispatched to whichever route owns the id. A
 * person holding an id does not know which table it is in, and should not
 * have to.
 *
 * ═══ WHY A WRITE COSTS AN EXTRA GET ══════════════════════════════════════
 *
 * `sync`, `update` and `delete` read the row first, because the route to send
 * depends on its `kind`. That read is also what turns a wrong id into a 404
 * naming the resource instead of a 404 from whichever route was guessed.
 *
 * Verified against the handlers rather than any doc: `kb-ingest.controller.ts`
 * carries `@AllowApiKey()` on `GET sources`, `GET sources/:id` and
 * `POST sources/:id/ingest`, and on NOTHING else — see `crawlWritesRefused`.
 */
import { bool, type ParsedArgs } from '../args.js';
import { bodyFrom, need, queryFrom, showObject, showRows } from './common.js';

import type { ChatlyClient } from '@chatlychat/sdk-node';

/** The columns that answer "what is in my knowledge base and did it work". */
const COLUMNS = [
  'id',
  'kind',
  'label',
  'status',
  'syncStatus',
  'articleCount',
  'lastSyncedAt',
] as const;

const USAGE = `chatly sources — every knowledge source, crawls and documentation providers alike

  sources list                   All of them: URL crawls, PDFs and provider sources
  sources get <id>               One, either kind, with its last run's skip report
  sources sync <id> [--full]     Re-read it now. --full drops the incremental
                                 watermark first (provider sources only)
  sources update <id>            --file <path> | --body '{…}'   provider sources only
  sources delete <id>            Disconnect it. --articles keep|archive|delete
                                 (default keep)   provider sources only

Crawls and PDFs are created and edited through the dashboard or
POST /v1/kb-ingest/sources/url; this group reads them, and syncs them.
Use \`chatly docs-sources\` for the provider-shaped surface: providers,
discover, create, subscribe.
`;

/**
 * The row behind an id, from the one route that resolves BOTH kinds.
 *
 * `GET /v1/kb-ingest/sources/{id}` is documented as resolving a
 * documentation-provider id as well as a crawl or a PDF, and it is the only
 * route that does — `GET /v1/docs-sources/{id}` 404s a crawl.
 */
async function rowFor(chatly: ChatlyClient, id: string): Promise<{ kind: string; row: unknown }> {
  const row = await chatly.request<{ kind?: unknown }>(
    'GET',
    `/v1/kb-ingest/sources/${encodeURIComponent(id)}`,
  );
  // An unreadable `kind` must not pass for `docs_provider`: it is the value
  // every write below is dispatched on.
  return { kind: typeof row.kind === 'string' ? row.kind : 'unknown', row };
}

/**
 * Why a crawl's edit and delete are refused HERE rather than attempted.
 *
 * `PATCH /v1/kb-ingest/sources/{id}` and `DELETE /v1/kb-ingest/sources/{id}`
 * carry no `@AllowApiKey()`, so they answer 403 to every credential this CLI
 * can hold. Sending one anyway would earn `explain()`'s generic "the key is
 * valid but lacks a scope for this route" advice, which sends the reader to
 * `chatly whoami` to hunt for a scope that does not exist.
 *
 * This is a copy of a server-side decision and therefore stale-able: if
 * either route opens to API keys, delete this and dispatch them the way
 * `sync` already dispatches a crawl.
 */
function crawlWritesRefused(kind: string, verb: string): number {
  process.stderr.write(
    `That source is a ${kind}, and \`sources ${verb}\` can only ${verb} a documentation\n` +
      'provider. A crawl or a PDF is edited through the dashboard: ' +
      `${verb === 'delete' ? 'DELETE' : 'PATCH'} /v1/kb-ingest/sources/{id}\n` +
      'accepts a signed-in session only, never an API key, so no CLI command can drive it.\n' +
      '`chatly sources sync <id>` DOES work on a crawl.\n',
  );
  return 2;
}

export async function sources(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const sub = args.path[1] ?? 'list';
  switch (sub) {
    case 'list':
      /*
       * `?include=all` always, which is the whole point of this group: the
       * default list is crawls and PDFs only, and a workspace whose knowledge
       * comes entirely from providers gets `[]` plus an `x-chatly-list-hint`
       * header no CLI was reading.
       */
      return showRows(
        args,
        await chatly.request('GET', '/v1/kb-ingest/sources', { query: { include: 'all' } }),
        COLUMNS,
      );
    case 'get':
      return showObject((await rowFor(chatly, need(args, 2, 'a source id'))).row);
    case 'sync': {
      const id = need(args, 2, 'a source id');
      const { kind } = await rowFor(chatly, id);
      if (kind === 'docs_provider') {
        // `{ full? }` is one boolean, so it is a flag. `--full` re-reads every
        // page instead of asking the provider for a delta.
        return showObject(
          await chatly.request('POST', `/v1/docs-sources/${encodeURIComponent(id)}/sync`, {
            body: bool(args.flags, 'full') ? { full: true } : {},
          }),
        );
      }
      /*
       * A crawl has no incremental watermark to drop, so `--full` would be a
       * flag that silently did nothing — the "accepted, honoured nowhere"
       * shape this repo keeps finding. Said out loud instead.
       */
      if (bool(args.flags, 'full')) {
        process.stderr.write(
          `--full is a documentation-provider setting; a ${kind} re-reads every page anyway.\n`,
        );
      }
      return showObject(
        await chatly.request('POST', `/v1/kb-ingest/sources/${encodeURIComponent(id)}/ingest`),
      );
    }
    case 'update': {
      const id = need(args, 2, 'a source id');
      const body = bodyFrom(args, 'the fields to change');
      const { kind } = await rowFor(chatly, id);
      if (kind !== 'docs_provider') {
        return crawlWritesRefused(kind, 'update');
      }
      return showObject(
        await chatly.request('PATCH', `/v1/docs-sources/${encodeURIComponent(id)}`, { body }),
      );
    }
    case 'delete': {
      const id = need(args, 2, 'a source id');
      const { kind } = await rowFor(chatly, id);
      if (kind !== 'docs_provider') {
        return crawlWritesRefused(kind, 'delete');
      }
      /*
       * `--articles` passed through rather than validated here: the server's
       * `disconnectArticlesSchema` owns the three words, and a second copy of
       * an enum is a second thing to get wrong. Absent, the route's own
       * default (`keep`) applies.
       */
      return showObject(
        await chatly.request('DELETE', `/v1/docs-sources/${encodeURIComponent(id)}`, {
          query: queryFrom(args, [['articles', 'articles']]),
        }),
      );
    }
    case 'help':
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`Unknown: sources ${sub}\n\n`);
      process.stderr.write(USAGE);
      return 2;
  }
}
