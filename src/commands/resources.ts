import type { ChatlyClient } from '@chatlychat/sdk-node';

import { bool, num, str, type ParsedArgs } from '../args.js';
import { itemsOf, nextCursorOf, printJson, printTable } from '../output.js';

/** Shared list behaviour: one page, or every page with `--all`. */
async function renderList(
  args: ParsedArgs,
  columns: ReadonlyArray<string>,
  onePage: (query: Record<string, string | number>) => Promise<unknown>,
  everyPage?: () => AsyncGenerator<unknown, void, void>,
): Promise<number> {
  const json = bool(args.flags, 'json');
  if (bool(args.flags, 'all')) {
    if (everyPage === undefined) {
      process.stderr.write('--all is not available for this command (it is not cursor-paginated).\n');
      return 1;
    }
    const rows: unknown[] = [];
    for await (const row of everyPage()) {
      rows.push(row);
    }
    if (json) {
      printJson(rows);
    } else {
      printTable(rows, columns);
    }
    return 0;
  }

  const query: Record<string, string | number> = {};
  const limit = num(args.flags, 'limit');
  if (limit !== undefined) {
    query['limit'] = limit;
  }
  const cursor = str(args.flags, 'cursor');
  if (cursor !== undefined) {
    query['cursor'] = cursor;
  }
  const page = await onePage(query);
  if (json) {
    printJson(page);
    return 0;
  }
  printTable(itemsOf(page), columns);
  const next = nextCursorOf(page);
  if (next !== null) {
    process.stdout.write(`next page: --cursor ${next}   (or --all)\n`);
  }
  return 0;
}

/** `--prop key=value`, repeatable, into an object. */
function props(args: ParsedArgs): Record<string, string> | undefined {
  const raw = args.flags['prop'];
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [String(raw)];
  if (list.length === 0) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const pair of list) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      throw new Error(`--prop expects key=value, got "${pair}"`);
    }
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

function need(args: ParsedArgs, index: number, what: string): string {
  const value = args.path[index];
  if (value === undefined) {
    throw new Error(`Missing ${what}. See \`chatly --help\`.`);
  }
  return value;
}

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
    case 'unattended': {
      const res = await chatly.conversations.unattended();
      if (json) {
        printJson(res);
        return 0;
      }
      printTable(itemsOf(res), ['id', 'status', 'channel', 'waitingSince']);
      return 0;
    }
    default:
      throw new Error(`Unknown: conversations ${sub}`);
  }
}

export async function contacts(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const sub = args.path[1] ?? 'list';
  const json = bool(args.flags, 'json');
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
        throw new Error('Nothing to upsert. Pass at least one of --email --name --phone --external-id.');
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
      const res = await chatly.contacts.journey(need(args, 2, 'a contact id'));
      if (json) {
        printJson(res);
        return 0;
      }
      printTable(itemsOf(res), ['type', 'at', 'summary'], 70);
      return 0;
    }
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
    default:
      throw new Error(`Unknown: tickets ${sub}`);
  }
}

export async function search(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const query = args.path.slice(1).join(' ');
  if (query.length === 0) {
    throw new Error('Nothing to search for. `chatly search "refund policy"`.');
  }
  const res = await chatly.search.query(query);
  if (bool(args.flags, 'json')) {
    printJson(res);
    return 0;
  }
  printTable(itemsOf(res), ['kind', 'id', 'title', 'snippet'], 60);
  return 0;
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

export async function webhooks(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const sub = args.path[1] ?? 'deliveries';
  switch (sub) {
    case 'deliveries':
      return renderList(
        args,
        ['id', 'event', 'status', 'responseStatus', 'attempts', 'createdAt'],
        (q) => chatly.webhooks.list(q),
        () => chatly.webhooks.listAll(),
      );
    case 'delivery':
      printJson(await chatly.webhooks.delivery(need(args, 2, 'a delivery id')));
      return 0;
    case 'redeliver': {
      const id = need(args, 2, 'a delivery id');
      printJson(await chatly.webhooks.redeliver(id));
      return 0;
    }
    default:
      throw new Error(`Unknown: webhooks ${sub}`);
  }
}

export async function reports(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const sub = args.path[1] ?? 'overview';
  const range: Record<string, string> = {};
  const from = str(args.flags, 'from');
  if (from !== undefined) {
    range['from'] = from;
  }
  const to = str(args.flags, 'to');
  if (to !== undefined) {
    range['to'] = to;
  }
  switch (sub) {
    case 'overview':
      printJson(await chatly.reports.overview(range));
      return 0;
    case 'agents':
      printJson(await chatly.reports.agents(range));
      return 0;
    case 'sla':
      printJson(await chatly.reports.sla(range));
      return 0;
    case 'conversations-by-day':
      printJson(await chatly.reports.conversationsByDay(range));
      return 0;
    default:
      throw new Error(`Unknown: reports ${sub}`);
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
    default:
      throw new Error(`Unknown: workspace ${sub}`);
  }
}

export async function channels(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const sub = args.path[1] ?? 'list';
  if (sub === 'get') {
    printJson(await chatly.channels.get(need(args, 2, 'a channel id')));
    return 0;
  }
  const res = await chatly.channels.list();
  if (bool(args.flags, 'json')) {
    printJson(res);
    return 0;
  }
  printTable(itemsOf(res), ['id', 'publicId', 'type', 'name', 'status']);
  return 0;
}

export async function billing(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const sub = args.path[1] ?? 'usage';
  if (sub === 'plans') {
    printJson(await chatly.billing.plans());
    return 0;
  }
  printJson(await chatly.billing.usage());
  return 0;
}

/**
 * The raw passthrough — `gh api` for Chatly.
 *
 * 85 of the 140 key-accessible routes have no named command here, and adding
 * one for each would be a worse CLI. This keeps every route reachable with
 * the same auth, idempotency key, retry policy and typed errors.
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
  const rawBody = str(args.flags, 'body');
  let body: unknown;
  if (rawBody !== undefined) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new Error(`--body is not valid JSON: ${rawBody.slice(0, 60)}`);
    }
  }
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(args.flags)) {
    if (k.startsWith('q-') && typeof v === 'string') {
      query[k.slice(2)] = v;
    }
  }
  const res = await chatly.request(
    method as 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path,
    { query, ...(body === undefined ? {} : { body }) },
  );
  printJson(res ?? { ok: true });
  return 0;
}
