/**
 * The integration surface: webhooks, customer cards, documentation sources
 * and channels.
 *
 * All four are config-as-code in the same sense `config.ts` describes, and
 * three of them mint a secret that is shown exactly once — so each command
 * that rotates one prints the whole response rather than a summary line.
 */
import { bool, str, type ParsedArgs } from '../args.js';
import { itemsOf, printJson, printTable } from '../output.js';
import { bodyFrom, need, renderList, showObject, showRows } from './common.js';

import type { ChatlyClient } from '@chatlychat/sdk-node';

export async function webhooks(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const sub = args.path[1] ?? 'deliveries';
  switch (sub) {
    case 'deliveries':
      return renderList(
        args,
        ['id', 'event', 'status', 'responseStatus', 'attempts', 'createdAt'],
        /*
         * `deliveries`, not `list`. On the extended surface `webhooks.list`
         * is the SUBSCRIPTION list (`GET /v1/webhooks`) and the delivery log
         * is `deliveries`/`deliveriesAll` — this called `list`/`listAll` and
         * would have rendered subscriptions under delivery column headings.
         */
        (q) => chatly.webhooks.deliveries(q),
        () => chatly.webhooks.deliveriesAll(),
      );
    case 'delivery':
      return showObject(await chatly.webhooks.delivery(need(args, 2, 'a delivery id')));
    case 'redeliver':
      return showObject(await chatly.webhooks.redeliver(need(args, 2, 'a delivery id')));
    /*
     * `endpoints`, not `list`.
     *
     * `chatly webhooks` with no subcommand has always meant deliveries, so
     * calling the endpoint list `list` would leave two names for two
     * different things one word apart. The subscriptions are endpoints; the
     * traffic through them is deliveries.
     */
    case 'endpoints':
      return showRows(args, await chatly.request('GET', '/v1/webhooks'), [
        'id',
        'url',
        'eventTypes',
        'enabled',
        'schemaVersion',
        'description',
      ]);
    case 'events': {
      /*
       * The subscribable event catalogue — what may go in `--event`. Answers
       * `{ eventTypes: [...] }`, an object wrapping a string array, so there
       * are no columns worth inventing: print the names one per line.
       */
      const res = await chatly.request<{ eventTypes?: ReadonlyArray<string> }>(
        'GET',
        '/v1/webhooks/events',
      );
      if (bool(args.flags, 'json')) {
        return showObject(res);
      }
      for (const name of res.eventTypes ?? []) {
        process.stdout.write(`${name}\n`);
      }
      return 0;
    }
    case 'schema-versions':
      return showObject(await chatly.request('GET', '/v1/webhooks/schema-versions'));
    case 'create': {
      /*
       * Flags rather than a JSON document, because the body really is three
       * scalars and a list — and the names are read off `createSchema`:
       * `url`, `eventTypes`, `description`, `schemaVersion`.
       *
       * `--event` is repeatable and maps to `eventTypes`. At least one is
       * required by the schema (`.min(1)`), so refuse here rather than send a
       * body that cannot succeed.
       */
      const url = str(args.flags, 'url') ?? args.path[2];
      const raw = args.flags['event'];
      const eventTypes = raw === undefined ? [] : Array.isArray(raw) ? raw : [String(raw)];
      if (url === undefined || eventTypes.length === 0) {
        throw new Error(
          'Give a URL and at least one event:\n' +
            '  chatly webhooks create --url https://… --event conversation.created ' +
            '--event message.created\n' +
            '`chatly webhooks events` lists the subscribable names.',
        );
      }
      const description = str(args.flags, 'description');
      const schemaVersion = str(args.flags, 'schema-version');
      // Shown once: the response carries the `whsec_` signing secret.
      return showObject(
        await chatly.request('POST', '/v1/webhooks', {
          body: {
            url,
            eventTypes,
            ...(description === undefined ? {} : { description }),
            ...(schemaVersion === undefined ? {} : { schemaVersion }),
          },
        }),
      );
    }
    case 'pin': {
      /*
       * Pin an endpoint to a dated schema version. The body is
       * `{ schemaVersion }` and the schema is `.strict()`, so a misspelled
       * key is a 400 here rather than a silent no-op — which is the lucky
       * case, and not one to rely on elsewhere.
       *
       * The response's `missingEventTypes` names what this pin does not yet
       * cover, so it is printed whole.
       */
      const id = need(args, 2, 'an endpoint id');
      const version = args.path[3] ?? str(args.flags, 'schema-version');
      if (version === undefined) {
        throw new Error(
          'Give a version: `chatly webhooks pin <endpoint-id> <schema-version>`.\n' +
            '`chatly webhooks schema-versions` lists the pinnable ones.',
        );
      }
      return showObject(
        await chatly.request('PATCH', `/v1/webhooks/${encodeURIComponent(id)}/schema-version`, {
          body: { schemaVersion: version },
        }),
      );
    }
    default:
      throw new Error(`Unknown: webhooks ${sub}`);
  }
}

export async function customerCards(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const sub = args.path[1] ?? 'list';
  switch (sub) {
    case 'list':
      // Header NAMES only, never their values — the card's secret headers are
      // write-only by design.
      return showRows(args, await chatly.request('GET', '/v1/customer-cards'), [
        'id',
        'key',
        'title',
        'url',
        'enabled',
        'position',
        'ttlSeconds',
      ]);
    case 'create':
      // Answers with the signing secret, once.
      return showObject(
        await chatly.request('POST', '/v1/customer-cards', {
          body: bodyFrom(args, 'the card'),
        }),
      );
    case 'update':
      // An absent field is unchanged; `headers: {}` clears them. That
      // distinction is the schema's, so the body goes through verbatim.
      return showObject(
        await chatly.request(
          'PATCH',
          `/v1/customer-cards/${encodeURIComponent(need(args, 2, 'a card id'))}`,
          { body: bodyFrom(args, 'the fields to change') },
        ),
      );
    case 'rotate-secret':
      // Update your endpoint BEFORE running this: the old secret stops
      // verifying immediately and the new one is shown once.
      return showObject(
        await chatly.request(
          'POST',
          `/v1/customer-cards/${encodeURIComponent(need(args, 2, 'a card id'))}/rotate-secret`,
        ),
      );
    case 'delete':
      return showObject(
        await chatly.request(
          'DELETE',
          `/v1/customer-cards/${encodeURIComponent(need(args, 2, 'a card id'))}`,
        ),
      );
    default:
      throw new Error(`Unknown: customer-cards ${sub}`);
  }
}

export async function docsSources(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const sub = args.path[1] ?? 'list';
  switch (sub) {
    case 'list':
      return showRows(args, await chatly.request('GET', '/v1/docs-sources'), [
        'id',
        'provider',
        'label',
        'status',
        'syncStatus',
        'articleCount',
        'lastSyncedAt',
      ]);
    case 'providers':
      // Which providers this deployment can connect at all. Four are live;
      // read this before writing a `provider` into a create body.
      return showObject(await chatly.request('GET', '/v1/docs-sources/providers'));
    case 'discover':
      /*
       * The spaces a token can reach — the connect picker's data, and the way
       * to find the `organizationId` and `spaceId` a create needs. Takes
       * `{ provider, token, baseUrl? }` and creates nothing.
       */
      return showObject(
        await chatly.request('POST', '/v1/docs-sources/discover', {
          body: bodyFrom(args, 'the provider and token'),
        }),
      );
    case 'create':
      // The first sync is enqueued before this returns, so the source comes
      // back `syncStatus: 'queued'` with no counts yet.
      return showObject(
        await chatly.request('POST', '/v1/docs-sources', {
          body: bodyFrom(args, 'the source'),
        }),
      );
    case 'update':
      return showObject(
        await chatly.request(
          'PATCH',
          `/v1/docs-sources/${encodeURIComponent(need(args, 2, 'a source id'))}`,
          { body: bodyFrom(args, 'the fields to change') },
        ),
      );
    case 'sync':
      /*
       * Enqueues the same job the scheduler runs. The body is `{ full? }` —
       * one boolean, so it is a flag: `--full` re-reads every page instead of
       * skipping spaces whose revision has not moved.
       */
      return showObject(
        await chatly.request(
          'POST',
          `/v1/docs-sources/${encodeURIComponent(need(args, 2, 'a source id'))}/sync`,
          { body: bool(args.flags, 'full') ? { full: true } : {} },
        ),
      );
    case 'subscribe':
      /*
       * Subscribe the source to its provider's change events, so edits push
       * instead of waiting for the next poll.
       *
       * A REFUSAL IS A SUCCESS HERE: a read-only token cannot manage
       * webhooks, which is the common case and a fact to report rather than
       * an error status. Read the response — a 201 does not mean subscribed.
       */
      return showObject(
        await chatly.request(
          'POST',
          `/v1/docs-sources/${encodeURIComponent(need(args, 2, 'a source id'))}/webhook`,
        ),
      );
    case 'delete':
      // Disconnects the source and KEEPS the articles it created.
      return showObject(
        await chatly.request(
          'DELETE',
          `/v1/docs-sources/${encodeURIComponent(need(args, 2, 'a source id'))}`,
        ),
      );
    default:
      throw new Error(`Unknown: docs-sources ${sub}`);
  }
}

export async function channels(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const sub = args.path[1] ?? 'list';
  switch (sub) {
    case 'get':
      return showObject(await chatly.channels.get(need(args, 2, 'a channel id')));
    case 'adapters': {
      /*
       * Which channel types this deployment can connect — a bare array of
       * type names, so print them one per line rather than inventing a
       * column. The web widget is in the list and has no inbound adapter by
       * design; the registry alone once reported it unsupported.
       */
      const res = await chatly.request<ReadonlyArray<string>>('GET', '/v1/channels/adapters');
      if (bool(args.flags, 'json')) {
        return showObject(res);
      }
      for (const type of res) {
        process.stdout.write(`${type}\n`);
      }
      return 0;
    }
    case 'create':
      return showObject(
        await chatly.request('POST', '/v1/channels', { body: bodyFrom(args, 'the channel') }),
      );
    case 'update':
      return showObject(
        await chatly.request(
          'PATCH',
          `/v1/channels/${encodeURIComponent(need(args, 2, 'a channel id'))}`,
          { body: bodyFrom(args, 'the fields to change') },
        ),
      );
    case 'rotate-secret':
      // The inbound webhook signing secret, shown once.
      return showObject(
        await chatly.request(
          'POST',
          `/v1/channels/${encodeURIComponent(need(args, 2, 'a channel id'))}/secret/rotate`,
        ),
      );
    case 'list': {
      const res = await chatly.channels.list();
      if (bool(args.flags, 'json')) {
        printJson(res);
        return 0;
      }
      /*
       * `originsRestricted` is in the table on purpose. An empty `origins`
       * array means ANY origin, which is invisible in the JSON — the flag is
       * the only field that distinguishes "locked to these sites" from "open
       * to every site".
       */
      printTable(itemsOf(res), ['id', 'publicId', 'type', 'name', 'status', 'originsRestricted']);
      return 0;
    }
    default:
      throw new Error(`Unknown: channels ${sub}`);
  }
}
