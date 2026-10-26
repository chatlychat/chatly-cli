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
import {
  bodyFrom,
  need,
  queryFrom,
  renderList,
  showObject,
  showRows,
  type FlagSpec,
} from './common.js';

import type { ChatlyClient } from '@chatlychat/sdk-node';

/** The delivery log's filters: `--trace`, `--endpoint`, `--status`. */
const DELIVERY_FILTERS: ReadonlyArray<FlagSpec> = [
  ['trace', 'trace'],
  ['endpoint', 'endpointId'],
  ['status', 'status'],
];

export async function webhooks(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const sub = args.path[1] ?? 'deliveries';
  switch (sub) {
    case 'deliveries':
      return renderList(
        args,
        /*
         * The API's own field names. This read `event`, `responseStatus` and
         * `attempts` — none of which `GET /v1/webhooks/deliveries` sends — so
         * three of six columns printed blank on every row. `trace` is the
         * `X-Chatly-Trace` each attempt carried (CHT-SI13).
         */
        ['id', 'eventType', 'status', 'httpStatus', 'attempt', 'trace', 'createdAt'],
        /*
         * `deliveries`, not `list`. On the extended surface `webhooks.list`
         * is the SUBSCRIPTION list (`GET /v1/webhooks`) and the delivery log
         * is `deliveries`/`deliveriesAll` — this called `list`/`listAll` and
         * would have rendered subscriptions under delivery column headings.
         */
        /*
         * `--trace <ulid>` answers "what did Chatly send because of this
         * chain?" from the id a partner product logged. `--endpoint` and
         * `--status` are the two filters the route already had and this
         * command never forwarded.
         */
        (q) => chatly.webhooks.deliveries({ ...q, ...queryFrom(args, DELIVERY_FILTERS) }),
        () => chatly.webhooks.deliveriesAll(queryFrom(args, DELIVERY_FILTERS)),
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

/**
 * `chatly privacy …` — the data-rights executor's own commands (CHT-X03).
 *
 * ═══ WHY THE EXECUTOR KEY NEEDS A CLI COMMAND AT ALL ══════════════════════
 *
 * Because without one, `POST /v1/privacy/executor-key` had no caller.
 * `check-api-route-callers` flagged it, and CLAUDE.md §5 is explicit that the
 * fix is a caller and NOT an allow-list entry: an endpoint nothing can reach
 * is a feature nobody can use, which is how the Gmail and Outlook mailbox
 * sign-in shipped complete and unreachable.
 *
 * It is a good fit rather than a box-tick. The route exists to be run ONCE,
 * by an operator, while they are filling in a privacy platform's executor
 * registration form — exactly the shape of thing a CLI is for, and exactly
 * the shape of thing that does not deserve a dashboard screen. The response
 * is three fields a human pastes.
 *
 * ═══ WHY IT PRINTS A WARNING AND NOT JUST THE OBJECT ══════════════════════
 *
 * The secret is shown ONCE. `showObject` on a shown-once credential is the
 * ergonomic trap every key-minting surface here has: the value scrolls past
 * in a terminal somebody then closes. So the human-readable form labels it,
 * says it will not be shown again, and names the sealed alternative — while
 * `--json` stays exactly the API response, because that is what a script
 * pipes into `jq`.
 */
export async function privacy(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const sub = args.path[1] ?? 'help';
  switch (sub) {
    case 'executor-key': {
      /*
       * `@RequireIdempotencyKey()` on the route, so a key is MANDATORY: a
       * retried POST without one answers 428 in production. The SDK mints one
       * per write, which is why this is a plain `request` and not a special
       * case — see `packages/sdk-spec/CONTRACT.md`.
       */
      const res = await chatly.request<{
        id: string;
        workspaceId: string;
        executorUrl: string;
        scopes: readonly string[];
        token: string | null;
        sealedSecret: string | null;
        sealedScheme: string | null;
        note: string;
      }>('POST', '/v1/privacy/executor-key');
      if (bool(args.flags, 'json')) {
        return showObject(res);
      }
      process.stdout.write(
        `Executor URL   ${res.executorUrl}\n` +
          `Workspace      ${res.workspaceId}\n` +
          `Scopes         ${res.scopes.join(', ')}\n` +
          `Key id         ${res.id}\n`,
      );
      if (res.token !== null) {
        process.stdout.write(
          `Secret         ${res.token}\n` +
            '\nThe secret is shown ONCE and is not recoverable. Register the three\n' +
            'values above with your privacy platform now.\n' +
            'To receive it encrypted instead, send an X-Secret-Recipient header\n' +
            '(see /docs/api-rest, "Never printing a key").\n',
        );
      } else {
        process.stdout.write(
          `Sealed secret  ${res.sealedSecret ?? '(none)'}\n` +
            `Sealed scheme  ${res.sealedScheme ?? '(none)'}\n` +
            '\nSealed to the public key you sent. Decrypt it with the matching\n' +
            'private key; refuse a scheme you do not recognise rather than\n' +
            'guessing from the length.\n',
        );
      }
      return 0;
    }
    case 'lookup':
      /*
       * Resolve a subject. A POST rather than a GET because an OIDC issuer is
       * a URL and a subject claim is arbitrary text, neither of which survives
       * a query string reliably — the route's own header makes the argument.
       */
      return showObject(
        await chatly.request('POST', '/v1/privacy/lookup', {
          body: bodyFrom(args, 'the subject (issuer/subject, externalId or emails)'),
        }),
      );
    case 'request':
      return showObject(
        await chatly.request('POST', '/v1/privacy/requests', {
          body: bodyFrom(args, 'the request (caseId, type and subject)'),
        }),
      );
    case 'status':
      return showObject(
        await chatly.request(
          'GET',
          `/v1/privacy/requests/${encodeURIComponent(need(args, 2, 'a request id'))}`,
        ),
      );
    case 'cancel':
      return showObject(
        await chatly.request(
          'DELETE',
          `/v1/privacy/requests/${encodeURIComponent(need(args, 2, 'a request id'))}`,
        ),
      );
    default:
      process.stderr.write(
        'Usage: chatly privacy <executor-key|lookup|request|status|cancel>\n' +
          '  executor-key            mint the credential a privacy platform registers\n' +
          '  lookup --body <json>    resolve a person to a stable subjectId\n' +
          '  request --body <json>   file a data-rights request\n' +
          '  status <id>             read one back\n' +
          '  cancel <id>             withdraw one that has not run\n',
      );
      return 2;
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
    case 'set-key':
      // Adopt an existing channel into config-as-code: `chatly.json` matches channels on `key`.
      return showObject(
        await chatly.request(
          'PATCH',
          `/v1/channels/${encodeURIComponent(need(args, 2, 'a channel id'))}`,
          { body: { key: need(args, 3, 'a key (^[a-z][a-z0-9-]{0,63}$)') } },
        ),
      );
    case 'brand': {
      /*
       * A DTCG `brand.json` (CHT-SI14). With `--url` or `--file`/`--body`
       * it APPLIES the document; with neither it reads back the resolved
       * mapping — each role's value and which layer it came from, because
       * `brand.json` ranks below the workspace theme and the channel's own
       * settings and "why didn't my accent change?" is answered by `source`.
       */
      const path = `/v1/channels/${encodeURIComponent(need(args, 2, 'a channel id'))}/brand`;
      const url = str(args.flags, 'url');
      const hasDocument =
        str(args.flags, 'file') !== undefined || str(args.flags, 'body') !== undefined;
      if (url !== undefined && hasDocument) {
        throw new Error('Pass --url or a document (--file/--body), not both.');
      }
      if (url !== undefined) {
        return showObject(await chatly.request('PUT', path, { body: { brandUrl: url } }));
      }
      if (hasDocument) {
        return showObject(
          await chatly.request('PUT', path, {
            body: { brand: bodyFrom(args, 'the brand document') },
          }),
        );
      }
      return showObject(await chatly.request('GET', path));
    }
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
      printTable(itemsOf(res), [
        'id',
        'key',
        'publicId',
        'type',
        'name',
        'status',
        'originsRestricted',
      ]);
      return 0;
    }
    default:
      throw new Error(`Unknown: channels ${sub}`);
  }
}
