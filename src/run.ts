/**
 * The CLI's behaviour, separated from the process it runs in.
 *
 * Dogfoods `@chatlychat/sdk-node`: every call here goes through the published
 * SDK, so the CLI and a customer's own integration exercise the same
 * transport, the same retry policy and the same error model. When the SDK's
 * errors are unhelpful, we feel it first.
 */
import { ChatlyApiError, ChatlyClient, ChatlyTransportError } from '@chatlychat/sdk-node';

import { bool, parseArgs, str } from './args.js';
import * as auth from './commands/auth.js';
import * as cmd from './commands/resources.js';
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
const VERSION = '0.1.3';

/** Commands that need no credential. Everything else resolves a key first. */
const UNAUTHENTICATED = new Set(['login', 'logout', 'help', 'version']);

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
    // Resolution order and the reason for it are in config.ts.
    const creds = resolveCredentials(str(args.flags, 'key'), str(args.flags, 'api-url'));
    const chatly = makeClient({
      apiKey: creds.apiKey,
      ...(creds.apiUrl === undefined ? {} : { apiUrl: creds.apiUrl }),
    });
    const json = bool(args.flags, 'json');

    switch (command) {
      case 'whoami':
        return auth.whoami(chatly, json);
      case 'conversations':
      case 'conversation':
        return cmd.conversations(chatly, args);
      case 'contacts':
      case 'contact':
        return cmd.contacts(chatly, args);
      case 'tickets':
      case 'ticket':
        return cmd.tickets(chatly, args);
      case 'search':
        return cmd.search(chatly, args);
      case 'kb':
        return cmd.kb(chatly, args);
      case 'events':
      case 'event':
        return cmd.events(chatly, args);
      case 'webhooks':
      case 'webhook':
        return cmd.webhooks(chatly, args);
      case 'reports':
      case 'report':
        return cmd.reports(chatly, args);
      case 'workspace':
        return cmd.workspace(chatly, args);
      case 'channels':
      case 'channel':
        return cmd.channels(chatly, args);
      case 'billing':
        return cmd.billing(chatly, args);
      case 'api':
        return cmd.api(chatly, args);
      default:
        process.stderr.write(`Unknown command "${command}". Run \`chatly --help\`.\n`);
        return 2;
    }
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
          ? '\nThe key is valid but lacks a scope for this route. `chatly whoami` lists what it has.'
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
