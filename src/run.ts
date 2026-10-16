/**
 * The CLI's behaviour, separated from the process it runs in.
 *
 * Dogfoods `@chatlychat/sdk-node`: every call here goes through the published
 * SDK, so the CLI and a customer's own integration exercise the same
 * transport, the same retry policy and the same error model. When the SDK's
 * errors are unhelpful, we feel it first.
 */
import { ChatlyApiError, ChatlyClient, ChatlyTransportError } from '@chatlychat/sdk-node';

import { bool, parseArgs, str, type ParsedArgs } from './args.js';
import * as ai from './commands/ai.js';
import * as auth from './commands/auth.js';
import * as config from './commands/config.js';
import * as insights from './commands/insights.js';
import * as integrations from './commands/integrations.js';
import * as listenCmd from './commands/listen.js';
import * as cmd from './commands/resources.js';
import * as wac from './commands/workspace-as-code.js';
import { resolveCredentials } from './config.js';
import { HELP } from './help.js';

/**
 * Printed by `--version`, which is the first thing support asks for.
 *
 * A literal, not a runtime read of package.json: a CLI should not stat a file
 * to tell you its own version, and resolving a package-relative path from an
 * ESM bundle is a per-packager problem. The cost of a literal is that it
 * drifts — it said `0.1.0` while the published package was `0.1.2` — so
 * `cli.spec.ts` asserts the two agree and fails if they do not.
 */
const VERSION = '0.4.1';

/** Commands that need no credential. Everything else resolves a key first. */
const UNAUTHENTICATED = new Set(['login', 'logout', 'help', 'version']);

/**
 * Every authenticated command, by the word a person types.
 *
 * A table rather than a `switch`, for one reason that is worth the churn:
 * `cli.spec.ts` can now assert that every key here appears in `--help` and
 * that every command documented in `--help` is reachable. A command with no
 * help entry is a command nobody finds; a help entry with no command is a
 * promise the CLI breaks. The `switch` this replaced could be checked for
 * neither.
 *
 * Singular aliases are listed explicitly rather than derived by stripping an
 * `s`, so `kb`, `search`, `whoami` and `ai` cannot acquire a nonsense twin.
 */
export const COMMANDS: Readonly<
  Record<string, (c: ChatlyClient, a: ParsedArgs) => Promise<number>>
> = {
  // ── Core ──────────────────────────────────────────────────────────────
  whoami: async (c, a) => auth.whoami(c, bool(a.flags, 'json')),
  conversations: cmd.conversations,
  contacts: cmd.contacts,
  tickets: cmd.tickets,
  search: cmd.search,
  kb: cmd.kb,
  events: cmd.events,
  workspace: cmd.workspace,

  // ── Config as code ────────────────────────────────────────────────────
  bots: config.bots,
  'bot-routes': config.botRoutes,
  triggers: config.triggers,
  brands: config.brands,
  'email-templates': config.emailTemplates,
  macros: config.macros,
  'knowledge-gaps': config.knowledgeGaps,

  // ── Integrations ──────────────────────────────────────────────────────
  webhooks: integrations.webhooks,
  /*
   * `listen` sits beside `webhooks` rather than under it, because it is not a
   * CRUD verb on the same resource — it is the `stripe listen` equivalent, a
   * long-running tail, and it is what a developer types without reading
   * anything first. Read `commands/listen.ts`'s header before changing how it
   * gets its events: the three possible designs are enumerated there and two
   * of them are impossible with a `ck_` key.
   */
  listen: listenCmd.listen,
  'customer-cards': integrations.customerCards,
  'docs-sources': integrations.docsSources,
  channels: integrations.channels,

  // ── Workspace as code ─────────────────────────────────────────────────
  /*
   * `plan` and `apply` are TWO entries rather than one `config` group with
   * two subcommands, because `chatly plan` / `chatly apply` is what the
   * integrator asked for by name and what anybody who has used terraform
   * will type. Both read one JSON document and cover nine resource types; a
   * group word in front would only make the muscle memory wrong.
   */
  plan: wac.plan,
  apply: wac.apply,

  // ── AI ────────────────────────────────────────────────────────────────
  ai: ai.ai,

  // ── Numbers ───────────────────────────────────────────────────────────
  reports: insights.reports,
  billing: insights.billing,

  // ── Escape hatch ──────────────────────────────────────────────────────
  api: cmd.api,
};

/** Singular spellings, for the groups where typing one reads naturally. */
export const ALIASES: Readonly<Record<string, string>> = {
  conversation: 'conversations',
  contact: 'contacts',
  ticket: 'tickets',
  event: 'events',
  webhook: 'webhooks',
  report: 'reports',
  channel: 'channels',
  bot: 'bots',
  'bot-route': 'bot-routes',
  trigger: 'triggers',
  brand: 'brands',
  macro: 'macros',
  'email-template': 'email-templates',
  'customer-card': 'customer-cards',
  'docs-source': 'docs-sources',
  'knowledge-gap': 'knowledge-gaps',
};

/**
 * How a client is made. Injectable for tests ONLY.
 *
 * The CLI's whole value is that it goes through the published SDK, so a test
 * that stubs the SDK would prove nothing. This seam replaces `fetch`, one
 * level lower: the real `ChatlyClient`, the real transport, the real retry
 * policy and the real error mapping all run, and only the socket is fake.
 */
export type ClientFactory = (opts: { apiKey: string; apiUrl?: string }) => ChatlyClient;

const defaultFactory: ClientFactory = (opts) => new ChatlyClient(opts);

export async function run(
  argv: ReadonlyArray<string>,
  makeClient: ClientFactory = defaultFactory,
): Promise<number> {
  const args = parseArgs(argv);
  const command = args.path[0];

  /*
   * Version BEFORE the no-command branch.
   *
   * `chatly --version` parses to an empty command path with one flag, so a
   * `command === undefined` check placed first swallows it and prints the
   * help — which is what this did on its first run.
   */
  if (bool(args.flags, 'version') || command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (
    command === undefined ||
    bool(args.flags, 'help') ||
    bool(args.flags, 'h') ||
    command === 'help'
  ) {
    process.stdout.write(HELP);
    return 0;
  }

  if (command === 'login') {
    return auth.login(args);
  }
  if (command === 'logout') {
    return auth.logout();
  }

  if (!UNAUTHENTICATED.has(command)) {
    const name = ALIASES[command] ?? command;
    const handler = COMMANDS[name];
    if (handler === undefined) {
      process.stderr.write(`Unknown command "${command}". Run \`chatly --help\`.\n`);
      return 2;
    }
    // Resolution order and the reason for it are in config.ts.
    const creds = resolveCredentials(str(args.flags, 'key'), str(args.flags, 'api-url'));
    const chatly = makeClient({
      apiKey: creds.apiKey,
      ...(creds.apiUrl === undefined ? {} : { apiUrl: creds.apiUrl }),
    });
    return handler(chatly, args);
  }

  process.stdout.write(HELP);
  return 0;
}

/**
 * One place that turns an error into an exit code and a sentence.
 *
 * A CLI whose failure mode is a stack trace is a CLI people stop trusting.
 * The SDK's typed errors are the whole reason this can say something useful:
 * 401 and 403 need different advice, and a transport failure is not an API
 * failure at all.
 */
export function explain(err: unknown): { code: number; message: string } {
  if (err instanceof ChatlyApiError) {
    const id = err.requestId === null ? '' : `  (request ${err.requestId})`;
    const hint =
      err.status === 401
        ? '\nThe key was rejected. Check it with `chatly whoami`, or run `chatly login` again.'
        : err.status === 403
          ? '\nThe key is valid but lacks a scope for this route. `chatly whoami` lists what it ' +
            'has, and `chatly workspace key-scopes` lists every scope there is.'
          : err.status === 429
            ? `\nRate limited.${err.retryAfter === null ? '' : ` Retry after ${String(err.retryAfter)}s.`}`
            : '';
    return { code: 1, message: `${err.message}${id}${hint}` };
  }
  if (err instanceof ChatlyTransportError) {
    return {
      code: 1,
      message: `${err.message}\nThe request never reached Chatly — check the network and --api-url.`,
    };
  }
  return { code: 1, message: err instanceof Error ? err.message : String(err) };
}
