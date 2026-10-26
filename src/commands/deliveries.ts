/**
 * `chatly deliveries list | show | replay` — an external agent's delivery log,
 * addressed by the `eventId` its endpoint saw.
 *
 * The same three routes as `chatly bots deliveries | delivery | redeliver`,
 * under the name people reach for when debugging an agent rather than managing
 * a bot, and with the bot as a flag because the thing you have in hand is an
 * event id from your own logs. The delivery id IS the `eventId` (there is no
 * second column), so `show` and `replay` take it verbatim.
 *
 * `replay` re-sends the ORIGINAL body with the ORIGINAL eventId, so an agent
 * that dedupes on it sees a repeat. Bodies are kept 7 days; a purged one is
 * refused by the server with a message saying so.
 */
import { str, type ParsedArgs } from '../args.js';
import { need, pagedVia, renderList, showObject } from './common.js';

import type { ChatlyClient } from '@chatlychat/sdk-node';

function botId(args: ParsedArgs): string {
  const bot = str(args.flags, 'bot');
  if (bot === undefined) {
    throw new Error('Pass the external agent with --bot <bot-id>.');
  }
  return encodeURIComponent(bot);
}

const botPath = (args: ParsedArgs): string => `/v1/bots/${botId(args)}/deliveries`;

export async function deliveries(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const sub = args.path[1] ?? 'list';
  switch (sub) {
    case 'list': {
      const status = str(args.flags, 'status');
      const pages = pagedVia(chatly, botPath(args), status === undefined ? {} : { status });
      return renderList(
        args,
        ['id', 'status', 'attempt', 'httpStatus', 'durationMs', 'createdAt', 'error'],
        pages.onePage,
        pages.everyPage,
      );
    }
    case 'show':
      // With `payload` (or `{ purged: true }`) and the agent's `replies`.
      return showObject(
        await chatly.request(
          'GET',
          `${botPath(args)}/${encodeURIComponent(need(args, 2, 'an event id'))}`,
        ),
      );
    case 'replay': {
      // A literal path, so `check-api-route-callers` can see this is the
      // route's caller.
      const eventId = encodeURIComponent(need(args, 2, 'an event id'));
      return showObject(
        await chatly.request('POST', `/v1/bots/${botId(args)}/deliveries/${eventId}/replay`),
      );
    }
    default:
      throw new Error(`Unknown deliveries command "${sub}". Try: list, show, replay.`);
  }
}
