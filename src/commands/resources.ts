/**
 * The conversational core: threads, people, tickets, search, the KB, events,
 * workspace reads, and the raw passthrough.
 *
 * `renderList`, `need` and `props` moved to `common.ts` when the command
 * surface grew past what one file could hold under the 650-line ceiling.
 * Config-as-code lives in `config.ts` and `integrations.ts`, AI in `ai.ts`,
 * and reports and billing in `insights.ts`.
 */
import { bool, str, type ParsedArgs } from '../args.js';
import { itemsOf, printJson, printTable } from '../output.js';
import { bodyFrom, need, props, queryFrom, renderList, showObject, showRows } from './common.js';

import type { ChatlyClient } from '@chatlychat/sdk-node';

export async function conversations(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const sub = args.path[1] ?? 'list';
  const json = bool(args.flags, 'json');
  switch (sub) {
    case 'list':
      return renderList(
        args,
        ['id', 'status', 'channel', 'contactId', 'lastMessageAt'],
        (q) => chatly.conversations.list(q),
        () => chatly.conversations.listAll(),
      );
    case 'get': {
      printJson(await chatly.conversations.get(need(args, 2, 'a conversation id')));
      return 0;
    }
    case 'messages': {
      const page = await chatly.conversations.messages(need(args, 2, 'a conversation id'));
      if (json) {
        printJson(page);
        return 0;
      }
      printTable(itemsOf(page), ['id', 'authorType', 'kind', 'body', 'createdAt'], 60);
      return 0;
    }
    case 'send': {
      const id = need(args, 2, 'a conversation id');
      const body = args.path.slice(3).join(' ') || str(args.flags, 'body');
      if (body === undefined || body.length === 0) {
        throw new Error('Nothing to send. `chatly conversations send <id> "your reply"`.');
      }
      const sent = await chatly.conversations.send({ conversationId: id, body });
      if (json) {
        printJson(sent);
      } else {
        process.stdout.write('sent\n');
      }
      return 0;
    }
    case 'unattended':
      // Cursor-paginated, so `--all` works here like any other list.
      return renderList(
        args,
        ['id', 'status', 'channel', 'waitingSince'],
        (q) => chatly.conversations.unattended(q),
        () => chatly.conversations.unattendedAll(),
      );
    case 'return-to-bot':
      /*
       * Hand an open thread back to an assistant, after a human took it.
       *
       * `<bot-id>` is required and deliberately not defaulted to whoever
       * owned it before: a thread three assistants have touched has no
       * obvious "the" bot, and guessing wrong puts the visitor in front of
       * the returns agent to ask about a size exchange. `chatly bots list`
       * has the ids.
       *
       * Printed whole rather than as a line, because the answer carries the
       * bot's NAME — which is what you check to confirm you handed it to the
       * one you meant.
       */
      return showObject(
        await chatly.conversations.returnToBot(need(args, 2, 'a conversation id'), {
          botId: need(args, 3, 'a bot id — `chatly bots list` has them'),
        }),
      );
    default:
      throw new Error(`Unknown: conversations ${sub}`);
  }
}

export async function contacts(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const sub = args.path[1] ?? 'list';
  switch (sub) {
    case 'list':
      return renderList(
        args,
        ['id', 'name', 'email', 'phone', 'externalId'],
        (q) => chatly.contacts.list(q),
        () => chatly.contacts.listAll(),
      );
    case 'get':
      printJson(await chatly.contacts.get(need(args, 2, 'a contact id')));
      return 0;
    case 'upsert': {
      const input = {
        ...(str(args.flags, 'email') === undefined ? {} : { email: str(args.flags, 'email') }),
        ...(str(args.flags, 'name') === undefined ? {} : { name: str(args.flags, 'name') }),
        ...(str(args.flags, 'phone') === undefined ? {} : { phone: str(args.flags, 'phone') }),
        ...(str(args.flags, 'external-id') === undefined
          ? {}
          : { externalId: str(args.flags, 'external-id') }),
      };
      if (Object.keys(input).length === 0) {
        throw new Error(
          'Nothing to upsert. Pass at least one of --email --name --phone --external-id.',
        );
      }
      printJson(await chatly.contacts.upsert(input));
      return 0;
    }
    case 'tag': {
      const id = need(args, 2, 'a contact id');
      const tag = need(args, 3, 'a tag');
      await chatly.contacts.addTags(id, tag);
      process.stdout.write(`tagged ${id} with "${tag}"\n`);
      return 0;
    }
    case 'journey': {
      const id = need(args, 2, 'a contact id');
      return renderList(
        args,
        ['type', 'at', 'summary'],
        (q) => chatly.contacts.journey(id, q),
        () => chatly.contacts.journeyAll(id),
      );
    }
    case 'mood':
      /*
       * Weekly sentiment buckets, `?days`. Answers an EMPTY `buckets` array
       * when there is not enough signal — which is not the same as a neutral
       * mood, and the only way to tell is that the array is empty.
       */
      return showObject(
        await chatly.request(
          'GET',
          `/v1/contacts/${encodeURIComponent(need(args, 2, 'a contact id'))}/mood`,
          { query: queryFrom(args, [['days', 'days', true]]) },
        ),
      );
    case 'cards':
      /*
       * A READ, despite being a POST.
       *
       * `POST /v1/contacts/{id}/cards` fetches this contact's customer cards
       * LIVE from the operator's own backend — it creates nothing. It is here
       * because it is the one way to answer "is my card endpoint actually
       * answering, and with what" without a browser, which is the whole
       * debugging loop for `chatly customer-cards`.
       *
       * The body is `{ conversationId? }`, strict.
       */
      return showObject(
        await chatly.request(
          'POST',
          `/v1/contacts/${encodeURIComponent(need(args, 2, 'a contact id'))}/cards`,
          {
            body: (() => {
              const conversationId = str(args.flags, 'conversation-id');
              return conversationId === undefined ? {} : { conversationId };
            })(),
          },
        ),
      );
    default:
      throw new Error(`Unknown: contacts ${sub}`);
  }
}

export async function tickets(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const sub = args.path[1] ?? 'list';
  switch (sub) {
    case 'list':
      return renderList(
        args,
        ['id', 'number', 'subject', 'status', 'priority', 'assigneeId'],
        (q) => {
          const extra: Record<string, string | number> = { ...q };
          const status = str(args.flags, 'status');
          if (status !== undefined) {
            extra['status'] = status;
          }
          const queue = str(args.flags, 'queue');
          if (queue !== undefined) {
            extra['queue'] = queue;
          }
          return chatly.tickets.list(extra);
        },
        () => chatly.tickets.listAll(),
      );
    case 'comments':
      printJson(await chatly.tickets.comments(need(args, 2, 'a ticket id')));
      return 0;
    case 'queues':
      printJson(await chatly.tickets.queues());
      return 0;
    case 'conversations':
      // Every conversation this ticket covers, origin first — how an agent
      // sees the fifty customers who wrote in about one outage.
      return showRows(
        args,
        await chatly.request(
          'GET',
          `/v1/tickets/${encodeURIComponent(need(args, 2, 'a ticket id'))}/conversations`,
        ),
        ['id', 'subject', 'status', 'channel'],
      );
    case 'status-history':
      // Oldest first, with time spent in each status. `truncated` is what
      // distinguishes a capped timeline (500 rows) from a short one.
      return showObject(
        await chatly.request(
          'GET',
          `/v1/tickets/${encodeURIComponent(need(args, 2, 'a ticket id'))}/status-history`,
        ),
      );
    case 'lineage':
      // Split and follow-up relationships, both directions of both.
      return showObject(
        await chatly.request(
          'GET',
          `/v1/tickets/${encodeURIComponent(need(args, 2, 'a ticket id'))}/lineage`,
        ),
      );
    case 'time':
      // Logged time with a total.
      return showObject(
        await chatly.request(
          'GET',
          `/v1/tickets/${encodeURIComponent(need(args, 2, 'a ticket id'))}/time`,
        ),
      );
    default:
      throw new Error(`Unknown: tickets ${sub}`);
  }
}

export async function search(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const query = args.path.slice(1).join(' ');
  if (query.length === 0) {
    throw new Error('Nothing to search for. `chatly search "refund policy"`.');
  }
  // `--all` walks the cursor; the single page keeps `facets` and `tier`,
  // which a hits-only view would discard.
  return renderList(
    args,
    ['kind', 'id', 'title', 'snippet'],
    (q) => chatly.search.query(query, q),
    () => chatly.search.queryAll(query),
  );
}

export async function kb(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const sub = args.path[1] ?? 'articles';
  switch (sub) {
    case 'articles':
      return renderList(
        args,
        ['id', 'slug', 'title', 'status', 'updatedAt'],
        (q) => chatly.kb.list(q),
        () => chatly.kb.listAll(),
      );
    case 'article':
      printJson(await chatly.kb.article(need(args, 2, 'an article slug')));
      return 0;
    case 'collections':
      printJson(await chatly.kb.collections());
      return 0;
    default:
      throw new Error(`Unknown: kb ${sub}`);
  }
}

export async function events(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const sub = args.path[1] ?? 'list';
  switch (sub) {
    case 'track': {
      const contactId = need(args, 2, 'a contact id');
      const name = need(args, 3, 'an event name');
      const properties = props(args);
      await chatly.events.track({ contactId, name, ...(properties ? { properties } : {}) });
      process.stdout.write(`tracked "${name}" for ${contactId}\n`);
      return 0;
    }
    case 'list':
      return renderList(
        args,
        ['id', 'name', 'contactId', 'createdAt'],
        (q) => {
          const extra: Record<string, string | number> = { ...q };
          const contactId = str(args.flags, 'contact-id');
          if (contactId !== undefined) {
            extra['contactId'] = contactId;
          }
          return chatly.events.list(extra);
        },
        () => chatly.events.listAll(),
      );
    default:
      throw new Error(`Unknown: events ${sub}`);
  }
}

export async function workspace(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const sub = args.path[1] ?? 'settings';
  const json = bool(args.flags, 'json');
  const show = (value: unknown, columns: ReadonlyArray<string>): number => {
    if (json) {
      printJson(value);
    } else {
      printTable(itemsOf(value), columns);
    }
    return 0;
  };
  switch (sub) {
    case 'settings':
      printJson(await chatly.workspace.settings());
      return 0;
    case 'labels':
      return show(await chatly.workspace.labels(), ['id', 'name', 'color']);
    case 'inboxes':
      return show(await chatly.workspace.inboxes(), ['id', 'name', 'channelId']);
    case 'team-members': {
      const teamId = args.path[2];
      if (teamId === undefined) {
        throw new Error(
          'Give a team id: `chatly workspace team-members <team-id>`.\n' +
            'There is no key-accessible route that lists teams — take the id from a ' +
            "conversation's teamId or an inbox's routingTeamId.",
        );
      }
      return show(await chatly.workspace.teamMembers(teamId), ['id', 'name', 'email', 'role']);
    }
    case 'skills':
      printJson(await chatly.workspace.agentSkills());
      return 0;
    case 'key-scopes':
      /*
       * Every scope a key CAN hold, grouped by prefix — static, and the
       * companion to `chatly whoami`, which lists the ones this key DOES
       * hold. Together they answer "why did that 403" without reading docs.
       */
      return showRows(args, await chatly.request('GET', '/v1/api-keys/scopes'), ['group', 'value']);
    default:
      throw new Error(`Unknown: workspace ${sub}`);
  }
}

/**
 * The raw passthrough — `gh api` for Chatly.
 *
 * 142 routes are key-accessible and this CLI names a command for the ones a
 * person runs by hand. The rest — one-off reads that only make sense inside a
 * larger program, and anything added to the API since this release — stay
 * reachable here with the same auth, idempotency key, retry policy and typed
 * errors.
 *
 * `--body` takes JSON; `--q-<name> <value>` becomes a query parameter, under
 * the name you type. Take that name from the handler's zod schema: an object
 * schema STRIPS a key it does not know, so a misspelling is a 200 that did
 * something else.
 */
export async function api(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const method = (args.path[1] ?? 'GET').toUpperCase();
  if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) {
    throw new Error(`Unsupported method "${method}". Use GET, POST, PATCH, PUT or DELETE.`);
  }
  const path = args.path[2];
  if (path === undefined || !path.startsWith('/')) {
    throw new Error('Give a path: `chatly api GET /v1/feature-flags`.');
  }
  /*
   * `--file` works here too, for the same reason it works on every config
   * write: a body big enough to matter does not belong on a command line.
   */
  const body =
    str(args.flags, 'body') === undefined && str(args.flags, 'file') === undefined
      ? undefined
      : bodyFrom(args, 'the request body');
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(args.flags)) {
    if (k.startsWith('q-') && typeof v === 'string') {
      query[k.slice(2)] = v;
    }
  }
  const res = await chatly.request(method as 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path, {
    query,
    ...(body === undefined ? {} : { body }),
  });
  printJson(res ?? { ok: true });
  return 0;
}
