/**
 * The CLI's behaviour, separated from the process it runs in.
 *
 * Dogfoods `@chatlychat/sdk-node`: every call here goes through the published
 * SDK, so the CLI and a customer's own integration exercise the same
 * transport, the same retry policy and the same error model. When the SDK's
 * errors are unhelpful, we feel it first.
 */
import {
  ChatlyApiError,
  ChatlyClient,
  ChatlyTransportError,
  type RetryNotice,
} from '@chatlychat/sdk-node';

import { bool, parseArgs, str, type ParsedArgs } from './args.js';
import * as ai from './commands/ai.js';
import * as apiKeysCmd from './commands/api-keys.js';
import * as auth from './commands/auth.js';
import * as config from './commands/config.js';
import * as deliveriesCmd from './commands/deliveries.js';
import * as doctorCmd from './commands/doctor.js';
import * as evalsCmd from './commands/evals.js';
import * as initCmd from './commands/init.js';
import * as insights from './commands/insights.js';
import * as integrations from './commands/integrations.js';
import * as listenCmd from './commands/listen.js';
import * as pac from './commands/platform-as-code.js';
import * as cmd from './commands/resources.js';
import * as secretCmd from './commands/secret.js';
import { isStaff, resolveStaffToken } from './commands/staff-login.js';
import * as wac from './commands/workspace-as-code.js';
import { readConfig, resolveCredentials } from './config.js';
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
const VERSION = '0.9.6';

/** Commands that need no credential. Everything else resolves a key first. */
const UNAUTHENTICATED = new Set(['login', 'logout', 'help', 'version', 'secret']);

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
  whoami: async (c, a) => auth.whoami(c, a),
  /*
   * Beside `whoami` because it is the other half of credential handling, and
   * because it is what makes `secret keypair` / `secret open` a usable pair
   * rather than two tools with no step between them. See `api-keys.ts`.
   */
  'api-keys': apiKeysCmd.apiKeys,
  conversations: cmd.conversations,
  contacts: cmd.contacts,
  tickets: cmd.tickets,
  search: cmd.search,
  kb: cmd.kb,
  events: cmd.events,
  workspace: cmd.workspace,

  // ── Config as code ────────────────────────────────────────────────────
  bots: config.bots,
  deliveries: deliveriesCmd.deliveries,
  'bot-routes': config.botRoutes,
  triggers: config.triggers,
  brands: config.brands,
  'email-templates': config.emailTemplates,
  macros: config.macros,
  'knowledge-gaps': config.knowledgeGaps,
  /*
   * Beside `bots` because a suite belongs to one bot's persona, and a group
   * word of its own because `chatly evals run` is what a CI step contains —
   * `bots eval` would bury it under a CRUD group. Exits non-zero on a failed
   * case, which is the whole reason it exists. See `commands/evals.ts`.
   */
  evals: evalsCmd.evals,

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
  /*
   * The data-rights executor (CHT-X03). Beside `webhooks` rather than under
   * `contacts`, because its caller is a PRIVACY PLATFORM's operator setting
   * up a fan-out, not somebody managing a contact — and `chatly privacy
   * executor-key` is the command they run once while filling in a
   * registration form.
   */
  privacy: integrations.privacy,

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
  /*
   * The same verbs over `/v1/platform/*` with a `cp_` credential (CHT-F04).
   * A group word here, unlike above, because the bare verbs are taken and a
   * platform document describes TENANTS — typing `platform` first is the
   * moment somebody notices which credential they are about to use.
   */
  platform: pac.platform,

  /*
   * The install health check (FormFlow, 2026-11-04). Beside `channels`
   * because it reads their `embed` block, and a verb of its own because what
   * it does is not a CRUD operation on a channel — it probes the deployed
   * install from OUTSIDE, the way a browser on a customer's page does, which
   * is the only vantage point from which the CORS and CSP-host defects it
   * exists for are visible at all. Exits non-zero on a failed check.
   */
  doctor: doctorCmd.doctor,

  // ── Install ───────────────────────────────────────────────────────────
  // Writes files into the current project from the web channel's own embed
  // block (CHT-F02). Read `commands/init.ts` for what it refuses to do.
  init: initCmd.init,

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
  delivery: 'deliveries',
  'bot-route': 'bot-routes',
  trigger: 'triggers',
  brand: 'brands',
  macro: 'macros',
  'email-template': 'email-templates',
  'customer-card': 'customer-cards',
  'docs-source': 'docs-sources',
  'knowledge-gap': 'knowledge-gaps',
  eval: 'evals',
};

/** `CHATLY_API_URL` or the saved `apiUrl`, for a `--staff` command (which has no API key to resolve). */
function resolveCredentialsUrl(): string | undefined {
  return process.env['CHATLY_API_URL'] ?? readConfig().apiUrl;
}

/**
 * How a client is made. Injectable for tests ONLY.
 *
 * The CLI's whole value is that it goes through the published SDK, so a test
 * that stubs the SDK would prove nothing. This seam replaces `fetch`, one
 * level lower: the real `ChatlyClient`, the real transport, the real retry
 * policy and the real error mapping all run, and only the socket is fake.
 */
export type ClientFactory = (opts: { apiKey: string; apiUrl?: string }) => ChatlyClient;

/**
 * Why a retry is announced on stderr.
 *
 * ForgeDeck's fifth report (2026-11-06, item 2): `chatly plan` and
 * `chatly apply` printed 0 bytes for 60 to 75 seconds against a rate-limited
 * API, which is indistinguishable from a hang — and the transport would sleep
 * for whatever `Retry-After` said, up to the 809 seconds they were sent. The
 * transport caps that at `MAX_ADVISED_DELAY_MS` now and hands the error back
 * past it; this is the other half, so the quiet is explained while it happens.
 *
 * stderr and not stdout: `chatly plan --json` is piped into tools, and a
 * progress line in the middle of a JSON document breaks them.
 */
function announceRetry(n: RetryNotice): void {
  const why = n.status === 429 ? 'rate limited' : `HTTP ${String(n.status ?? 0)}`;
  const advised =
    n.retryAfterSeconds === null ? '' : ` (server asked for ${String(n.retryAfterSeconds)}s)`;
  process.stderr.write(
    `${n.method} ${n.path}: ${why}${advised} — waiting ` +
      `${(n.delayMs / 1000).toFixed(1)}s, attempt ${String(n.attempt + 1)} of ` +
      `${String(n.attempts)}\n`,
  );
}

const defaultFactory: ClientFactory = (opts) =>
  new ChatlyClient({ ...opts, onRetry: announceRetry });

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
    return auth.logout(args);
  }
  /*
   * Sealed delivery's reader half, handled HERE because it needs no
   * credential — both subcommands are local crypto, and the person running
   * it is usually the integrator who does not have a key yet. See
   * `commands/secret.ts`.
   */
  if (command === 'secret') {
    return secretCmd.secret(args);
  }

  if (!UNAUTHENTICATED.has(command)) {
    const name = ALIASES[command] ?? command;
    const handler = COMMANDS[name];
    if (handler === undefined) {
      process.stderr.write(`Unknown command "${command}". Run \`chatly --help\`.\n`);
      return 2;
    }
    // Resolution order and the reason for it are in config.ts.
    /*
     * `--staff` swaps the credential for the stored staff sign-in (ADR 0082):
     * a short-lived Atlas token for the Operator API, never an API key. Only
     * when asked for, so a staff token cannot leak into an ordinary command,
     * and a missing or expired one refuses here instead of as a server 401.
     */
    const creds = isStaff(args)
      ? {
          apiKey: resolveStaffToken(),
          apiUrl: str(args.flags, 'api-url') ?? resolveCredentialsUrl(),
        }
      : resolveCredentials(str(args.flags, 'key'), str(args.flags, 'api-url'));
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
 * `error.details.reason` from a response body, or null. The SDK keeps only the
 * raw text, so this is the one place the envelope `{error:{details:{reason}}}`
 * is read; any non-JSON or differently-shaped body is simply "no reason".
 */
function errorReason(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    const error = (parsed as { error?: { details?: { reason?: unknown } } } | null)?.error;
    const reason = error?.details?.reason;
    return typeof reason === 'string' ? reason : null;
  } catch {
    return null;
  }
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
        ? // A right key of the wrong KIND: the server's message already names the route to use.
          errorReason(err.body) === 'wrong_credential_type'
          ? ''
          : '\nThe key was rejected. Check it with `chatly whoami`, or run `chatly login` again.'
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
