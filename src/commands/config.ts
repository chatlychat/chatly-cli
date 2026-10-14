/**
 * Config-as-code: the surface an integrator keeps in a repository.
 *
 * Bots, routing rules, triggers, brands, transactional email copy and macros
 * are all workspace CONFIGURATION — the things a team wants reviewed in a
 * pull request and applied from CI, not clicked through a settings screen.
 * That is the reason the SDK manifest grew from 55 routes to 142, and it is
 * the reason these are commands rather than `chatly api` calls.
 *
 * ── One idiom for every write ─────────────────────────────────────────────
 *
 * Writes take a JSON document (`--file`, `--file -`, or `--body`), not a flag
 * per field. These bodies are nested — a bot carries guardrails, a KB scope
 * and an escalation-rule array — and `bodyFrom` explains why a flag per field
 * would be both a worse CLI and a second place for a key name to be wrong.
 *
 * ── Transport ─────────────────────────────────────────────────────────────
 *
 * Through `ChatlyClient.request`, the escape hatch the SDK contract defines
 * for key-accessible routes with no typed method. It is the same auth, the
 * same `Idempotency-Key` per write, the same retry policy and the same typed
 * errors a named method would get — `apps/cli` adds no HTTP of its own.
 */
import { bool, str, type ParsedArgs } from '../args.js';
import { bodyFrom, need, pagedVia, queryFrom, renderList, showObject, showRows } from './common.js';

import type { ChatlyClient } from '@chatlychat/sdk-node';

export async function bots(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const sub = args.path[1] ?? 'list';
  switch (sub) {
    case 'list': {
      // A real cursor page, and the only one on this file's surface.
      const pages = pagedVia(chatly, '/v1/bots');
      return renderList(
        args,
        ['id', 'name', 'slug', 'status', 'model'],
        pages.onePage,
        pages.everyPage,
      );
    }
    case 'get':
      return showObject(
        await chatly.request('GET', `/v1/bots/${encodeURIComponent(need(args, 2, 'a bot id'))}`),
      );
    case 'create':
      /*
       * `type: "external"` creates a customer's own push-delivered agent and
       * answers with a signing secret and a `cb_` token, EACH SHOWN ONCE.
       * There is no route that reads them back, so this prints the whole
       * response rather than a summary line.
       */
      return showObject(
        await chatly.request('POST', '/v1/bots', { body: bodyFrom(args, 'the bot') }),
      );
    case 'update':
      return showObject(
        await chatly.request('PATCH', `/v1/bots/${encodeURIComponent(need(args, 2, 'a bot id'))}`, {
          body: bodyFrom(args, 'the fields to change'),
        }),
      );
    case 'update-external':
      return showObject(
        await chatly.request(
          'PATCH',
          `/v1/bots/${encodeURIComponent(need(args, 2, 'a bot id'))}/external`,
          { body: bodyFrom(args, "the external agent's webhook, timeout or fallback copy") },
        ),
      );
    case 'rotate-secret':
      // Shown once, and the old secret stops working the moment this returns.
      return showObject(
        await chatly.request(
          'POST',
          `/v1/bots/${encodeURIComponent(need(args, 2, 'a bot id'))}/external/rotate-secret`,
        ),
      );

    /* ── An external agent's delivery ledger ──────────────────────────── */
    case 'deliveries': {
      /*
       * The columns an integrator reading this is actually looking for.
       *
       * `status` first because it answers the question — `failed` will be
       * retried, `dead` will not — and `httpStatus` beside it because the
       * pair is the diagnosis: `dead` with a 401 is their signature check,
       * `dead` with a null is a timeout or DNS, `failed` with a 503 is their
       * load balancer and will fix itself.
       *
       * The signed `payload` is deliberately not a column and is not on a
       * list row at all: `bots delivery <bot> <delivery>` serves it.
       */
      const botId = need(args, 2, 'a bot id');
      const status = str(args.flags, 'status');
      const pages = pagedVia(
        chatly,
        `/v1/bots/${encodeURIComponent(botId)}/deliveries`,
        status === undefined ? {} : { status },
      );
      return renderList(
        args,
        ['id', 'status', 'attempt', 'httpStatus', 'durationMs', 'createdAt', 'error'],
        pages.onePage,
        pages.everyPage,
      );
    }
    case 'delivery':
      // With `payload` — the exact object that was serialised and signed.
      return showObject(
        await chatly.request(
          'GET',
          `/v1/bots/${encodeURIComponent(need(args, 2, 'a bot id'))}/deliveries/` +
            encodeURIComponent(need(args, 3, 'a delivery id')),
        ),
      );
    case 'redeliver':
      /*
       * The RECORDED payload, same `eventId`, from attempt 0.
       *
       * Which means a receiver's own dedupe will discard it if they already
       * processed that id — correct behaviour on their side, and the reason
       * this is for deliveries that never got through rather than for
       * re-running one.
       */
      return showObject(
        await chatly.request(
          'POST',
          `/v1/bots/${encodeURIComponent(need(args, 2, 'a bot id'))}/deliveries/` +
            `${encodeURIComponent(need(args, 3, 'a delivery id'))}/redeliver`,
        ),
      );
    case 'test-delivery':
      /*
       * Signs a rehearsal payload with the real secret, POSTs it to the real
       * URL, and prints the response — so a 401 from your own verifier
       * arrives here rather than in a log twenty minutes later.
       *
       * Printed WHOLE: `signature` and `payload` are the two fields worth
       * having, because they are the exact header value and the exact object
       * whose serialisation was signed, which is what you need to debug a
       * verifier offline.
       *
       * Writes nothing, so it does not appear under `bots deliveries`.
       */
      return showObject(
        await chatly.request(
          'POST',
          `/v1/bots/${encodeURIComponent(need(args, 2, 'a bot id'))}/test-delivery`,
        ),
      );
    default:
      throw new Error(`Unknown: bots ${sub}`);
  }
}

export async function botRoutes(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const sub = args.path[1] ?? 'list';
  switch (sub) {
    case 'list':
      // A bare array in evaluation order — not a cursor page, so no `--all`.
      return showRows(args, await chatly.request('GET', '/v1/bot-routes'), [
        'id',
        'name',
        'botId',
        'priority',
        'enabled',
        'evaluate',
      ]);
    case 'resolve':
      /*
       * The dry-run. `--body` carries the hypothetical visitor:
       *
       *   chatly bot-routes resolve --body '{"page":{"path":"/shop/checkout"},
       *     "context":{"verified":{"audience":"buyer"}}}'
       *
       * Printed WHOLE rather than as a table. The answer is three things —
       * which route won, why each other route lost, and the event object the
       * conditions were evaluated against — and the third is where you find
       * out that a field path resolves to nothing, which is half of every
       * routing bug.
       */
      return showObject(
        await chatly.request('POST', '/v1/bot-routes/resolve', {
          body: args.flags['body'] === undefined ? {} : bodyFrom(args, 'the hypothetical visitor'),
        }),
      );
    case 'fields':
      // The condition vocabulary. Read this before authoring a rule: a
      // condition naming a field that is not here is rejected on the write.
      return showObject(await chatly.request('GET', '/v1/bot-routes/fields'));
    case 'create':
      return showObject(
        await chatly.request('POST', '/v1/bot-routes', {
          body: bodyFrom(args, 'the routing rule'),
        }),
      );
    case 'update':
      return showObject(
        await chatly.request(
          'PATCH',
          `/v1/bot-routes/${encodeURIComponent(need(args, 2, 'a route id'))}`,
          { body: bodyFrom(args, 'the fields to change') },
        ),
      );
    case 'delete':
      return showObject(
        await chatly.request(
          'DELETE',
          `/v1/bot-routes/${encodeURIComponent(need(args, 2, 'a route id'))}`,
        ),
      );
    default:
      throw new Error(`Unknown: bot-routes ${sub}`);
  }
}

export async function triggers(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const sub = args.path[1] ?? 'list';
  switch (sub) {
    case 'list': {
      const pages = pagedVia(chatly, '/v1/triggers');
      return renderList(
        args,
        ['id', 'name', 'eventType', 'enabled', 'priority'],
        pages.onePage,
        pages.everyPage,
      );
    }
    /*
     * `upsert`, not `create`.
     *
     * The manifest calls this route `triggers.create`, but `POST /v1/triggers`
     * is an UPSERT: the handler is named `upsert`, it answers 201 on both
     * arms, and a body carrying an existing trigger's identity replaces it.
     * `create` is kept as an alias so the manifest's name works, but the
     * documented verb is the one the route performs — a CLI that calls this
     * "create" invites someone to run it twice expecting a second trigger.
     */
    case 'upsert':
    case 'create':
      return showObject(
        await chatly.request('POST', '/v1/triggers', { body: bodyFrom(args, 'the trigger') }),
      );
    case 'delete':
      // 200 with `{ ok: true }`, not a 204.
      return showObject(
        await chatly.request(
          'DELETE',
          `/v1/triggers/${encodeURIComponent(need(args, 2, 'a trigger id'))}`,
        ),
      );
    default:
      throw new Error(`Unknown: triggers ${sub}`);
  }
}

export async function brands(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const sub = args.path[1] ?? 'list';
  switch (sub) {
    case 'list':
      return showRows(args, await chatly.request('GET', '/v1/brands'), [
        'id',
        'name',
        'slug',
        'domain',
        'isDefault',
      ]);
    case 'create':
      return showObject(
        await chatly.request('POST', '/v1/brands', { body: bodyFrom(args, 'the brand') }),
      );
    case 'update':
      return showObject(
        await chatly.request(
          'PATCH',
          `/v1/brands/${encodeURIComponent(need(args, 2, 'a brand id'))}`,
          { body: bodyFrom(args, 'the fields to change') },
        ),
      );
    case 'delete':
      // A soft delete that answers 200 with `{ id }` — that id is the only
      // confirmation, so print it rather than saying "deleted".
      return showObject(
        await chatly.request(
          'DELETE',
          `/v1/brands/${encodeURIComponent(need(args, 2, 'a brand id'))}`,
        ),
      );
    default:
      throw new Error(`Unknown: brands ${sub}`);
  }
}

export async function emailTemplates(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const sub = args.path[1] ?? 'list';
  switch (sub) {
    case 'list':
      /*
       * All five kinds, always — this is the CATALOGUE, not the rows. A kind
       * the workspace has not customised comes back with `override: null`,
       * which is the field to read to tell a customised kind from a built-in
       * one.
       */
      return showRows(args, await chatly.request('GET', '/v1/email-templates'), [
        'kind',
        'label',
        'audience',
        'whenSent',
        'override',
      ]);
    case 'set':
      // A PUT: it REPLACES this workspace's copy, it does not merge into it.
      return showObject(
        await chatly.request(
          'PUT',
          `/v1/email-templates/${encodeURIComponent(need(args, 2, 'a template kind'))}`,
          { body: bodyFrom(args, 'the subject, html and text') },
        ),
      );
    /*
     * `reset`, with `delete` as an alias.
     *
     * `DELETE /v1/email-templates/{kind}` does not delete a template — it
     * drops the workspace's OVERRIDE and puts the built-in copy back, and it
     * answers 200 with `{ restored: false }` when there was nothing to drop.
     * Printing that flag is the only way to tell "I just reverted your copy"
     * from "there was nothing to revert".
     */
    case 'reset':
    case 'delete':
      return showObject(
        await chatly.request(
          'DELETE',
          `/v1/email-templates/${encodeURIComponent(need(args, 2, 'a template kind'))}`,
        ),
      );
    default:
      throw new Error(`Unknown: email-templates ${sub}`);
  }
}

export async function macros(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const sub = args.path[1] ?? 'list';
  switch (sub) {
    case 'list': {
      /*
       * NOT cursor-paginated: `@PaginationExempt`, a bare array capped at 200
       * and ordered by usage rank. The shared manifest flagged this `paged`
       * for a day and two SDKs built a paginator over it.
       *
       * `--query`, not `--q`. The handler's schema names it `query`, and zod
       * would strip `q` without a word — the search would run unnarrowed and
       * answer 200.
       */
      if (bool(args.flags, 'all')) {
        process.stderr.write(
          '--all is not available for macros (the route is not cursor-paginated; it ' +
            'answers a bare array capped at 200 rows).\n',
        );
        return 1;
      }
      const rows = await chatly.request('GET', '/v1/macros', {
        query: queryFrom(args, [
          ['scope', 'scope'],
          ['team', 'team'],
          ['query', 'query'],
          ['language', 'language'],
        ]),
      });
      return showRows(args, rows, ['id', 'name', 'shortCode', 'scope', 'language', 'usageCount']);
    }
    case 'get':
      return showObject(
        await chatly.request(
          'GET',
          `/v1/macros/${encodeURIComponent(need(args, 2, 'a macro id'))}`,
        ),
      );
    case 'actions':
      // The action registry a macro's `actions` array may reference. A macro
      // naming an action that is not here is a 422 at RUN time, not at save
      // time, so this is the list to check before writing one.
      return showObject(await chatly.request('GET', '/v1/macros/actions'));
    case 'templates':
      return showObject(await chatly.request('GET', '/v1/macros/templates'));
    case 'template':
      return showObject(
        await chatly.request(
          'GET',
          `/v1/macros/templates/${encodeURIComponent(need(args, 2, 'a template slug'))}`,
        ),
      );
    case 'create':
      return showObject(
        await chatly.request('POST', '/v1/macros', { body: bodyFrom(args, 'the macro') }),
      );
    case 'update':
      return showObject(
        await chatly.request(
          'PATCH',
          `/v1/macros/${encodeURIComponent(need(args, 2, 'a macro id'))}`,
          { body: bodyFrom(args, 'the fields to change') },
        ),
      );
    case 'delete': {
      // The only real 204 on the whole SDK surface: no body comes back, so
      // there is nothing to print but a confirmation.
      const id = need(args, 2, 'a macro id');
      await chatly.request('DELETE', `/v1/macros/${encodeURIComponent(id)}`);
      if (bool(args.flags, 'json')) {
        return showObject({ deleted: id });
      }
      process.stdout.write(`deleted ${id}\n`);
      return 0;
    }
    default:
      throw new Error(`Unknown: macros ${sub}`);
  }
}

/**
 * Knowledge gaps: the questions the KB could not answer, and the loop that
 * closes them.
 *
 * `list` → pick the most-asked → `draft` → the article exists → `triage` it
 * resolved. That whole loop is a terminal job, which is why it is a command.
 */
export async function knowledgeGaps(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const sub = args.path[1] ?? 'list';
  switch (sub) {
    case 'list':
      /*
       * `--limit` here is a plain row cap, NOT a page size: the route is
       * `@PaginationExempt` and the recorder caps a workspace at 200 open
       * gaps, so there is no cursor to follow and `--all` is not offered.
       */
      return showRows(
        args,
        await chatly.request('GET', '/v1/knowledge-gaps', {
          query: queryFrom(args, [
            ['status', 'status'],
            ['limit', 'limit', true],
          ]),
        }),
        ['id', 'question', 'occurrences', 'status', 'lastSeenAt', 'articleId'],
      );
    case 'triage':
    case 'update': {
      const id = need(args, 2, 'a gap id');
      // `{ status }`, strict — one of open / drafted / resolved / dismissed.
      const status = args.path[3] ?? str(args.flags, 'status');
      if (status === undefined) {
        throw new Error(
          'Give a status: `chatly knowledge-gaps triage <id> <status>`.\n' +
            'One of: open, drafted, resolved, dismissed.',
        );
      }
      return showObject(
        await chatly.request('PATCH', `/v1/knowledge-gaps/${encodeURIComponent(id)}`, {
          body: { status },
        }),
      );
    }
    case 'draft':
      // Creates a DRAFT article from the gap — 201, and nothing is published.
      return showObject(
        await chatly.request(
          'POST',
          `/v1/knowledge-gaps/${encodeURIComponent(need(args, 2, 'a gap id'))}/draft`,
        ),
      );
    default:
      throw new Error(`Unknown: knowledge-gaps ${sub}`);
  }
}
