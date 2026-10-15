/**
 * The flags and the wire shapes of `chatly listen --relay`.
 *
 * Split out of `listen-relay.ts` for the 650-line ceiling. What is parsed
 * here, and why each refusal exists, is documented on each function; the
 * protocol the shapes belong to is `apps/cli/RELAY-SERVER-SPEC.md`.
 */
import { RELAY_KINDS, type RelayKind } from './listen-relay-sign.js';
import { bool, str, type ParsedArgs } from '../args.js';

const ID_FLAGS = ['tool', 'card', 'canvas'] as const;

export interface RelaySecrets {
  /** `--secret <value>`: for every target without its own. */
  readonly fallback: string | null;
  /** `--secret <targetId>=<value>`. */
  readonly byTarget: ReadonlyMap<string, string>;
}

export interface RelayOptions {
  readonly forwardTo: string;
  readonly tools: readonly string[];
  readonly cards: readonly string[];
  readonly canvases: readonly string[];
  readonly secrets: RelaySecrets;
  readonly json: boolean;
}

/** One relayed call, as `GET /v1/relay-sessions/{id}/frames` renders it. */
export interface RelayFrame {
  readonly id: string;
  readonly kind: RelayKind;
  readonly targetId: string;
  readonly method: string;
  /** `pathname + search` of the CONFIGURED url. */
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Exactly the bytes the configured url would have received. `''` for none. */
  readonly body: string;
  /** When the waiting caller gives up. The CLI aborts the forward then. */
  readonly deadlineAt: string;
}

/** What the CLI posts back. Exactly one of the two arms. */
export type RelayAnswer =
  | {
      readonly status: number;
      readonly headers: Record<string, string>;
      readonly body: string;
      readonly durationMs: number;
    }
  | {
      readonly error:
        | 'unreachable'
        | 'timeout'
        | 'too_large'
        | 'not_selected'
        | 'signing_failed'
        | 'interrupted';
      readonly message: string;
      readonly durationMs: number;
    };

function listFlag(args: ParsedArgs, name: string): string[] {
  const raw = args.flags[name];
  if (raw === undefined || raw === true || raw === false) {
    return [];
  }
  return (Array.isArray(raw) ? raw : [String(raw)])
    .flatMap((v) => String(v).split(','))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** `--tool`, `--card` or `--canvas` on a command that is not `--relay`. */
export function relayOnlyFlagWithoutRelay(args: ParsedArgs): string | null {
  for (const name of ID_FLAGS) {
    if (args.flags[name] !== undefined) {
      return name;
    }
  }
  return null;
}

/** The ledger-tail flags, none of which mean anything on a relay. */
const LEDGER_ONLY_FLAGS = ['bot', 'endpoint', 'event', 'status', 'replay', 'interval', 'limit'];

function parseSecrets(args: ParsedArgs, ids: ReadonlySet<string>): RelaySecrets {
  const raw = args.flags['secret'];
  const values =
    raw === undefined || typeof raw === 'boolean' ? [] : Array.isArray(raw) ? raw : [raw];
  let fallback: string | null = null;
  const byTarget = new Map<string, string>();
  for (const value of values.map(String)) {
    /*
     * `<id>=<secret>` only when the left side IS one of the selected ids. A
     * secret is operator-chosen on a tool, so it may itself contain `=`
     * (standard base64 padding), and splitting every value on the first one
     * would turn that secret into a target id nobody asked for.
     */
    const eq = value.indexOf('=');
    const left = eq > 0 ? value.slice(0, eq) : '';
    if (left.length > 0 && ids.has(left)) {
      byTarget.set(left, value.slice(eq + 1));
      continue;
    }
    if (fallback !== null) {
      throw new Error(
        'Two bare --secret values. With more than one target, name which secret is whose:\n' +
          '  --secret <id>=<secret>   (repeatable)',
      );
    }
    fallback = value;
  }
  for (const secret of [fallback, ...byTarget.values()]) {
    if (secret === null) {
      continue;
    }
    /*
     * The two prefixes this product mints for OTHER surfaces. Neither signs
     * a tool call, a card fetch or a canvas step, and the symptom of passing
     * one is a 401 from your own handler that looks like a verifier bug.
     */
    if (secret.startsWith('whsec_') || secret.startsWith('chsec_')) {
      throw new Error(
        `--secret "${secret.slice(0, 6)}…" is a ${
          secret.startsWith('whsec_') ? 'webhook endpoint' : 'external agent'
        } secret, and it signs a different surface. A relay needs the secret configured on ` +
          "the tool, the customer card (or its endpoint), or the channel's canvas.",
      );
    }
  }
  return { fallback, byTarget };
}

/** Read the relay flags, refusing anything that cannot work, with the fix named. */
export function parseRelayOptions(args: ParsedArgs): RelayOptions {
  for (const name of LEDGER_ONLY_FLAGS) {
    if (args.flags[name] !== undefined) {
      throw new Error(
        `--${name} tails a delivery ledger and means nothing on --relay, which receives live ` +
          'calls instead of replaying logged ones.',
      );
    }
  }

  const tools = listFlag(args, 'tool');
  const cards = listFlag(args, 'card');
  const canvases = listFlag(args, 'canvas');
  if (tools.length + cards.length + canvases.length === 0) {
    throw new Error(
      '--relay needs at least one explicit target, because it takes PRODUCTION traffic:\n' +
        '  --tool <id>          an AI tool (chatly ai tools list)\n' +
        '  --card <id>          a customer card (chatly customer-cards list)\n' +
        "  --canvas <channelId> a channel's canvas endpoint\n" +
        'There is deliberately no form that relays everything.',
    );
  }

  const forwardTo = str(args.flags, 'forward-to') ?? null;
  if (forwardTo === null) {
    throw new Error(
      '--relay needs --forward-to. A relayed call is waiting for an answer, so there is no ' +
        'print-only mode:\n  chatly listen --relay --tool <id> --forward-to http://localhost:3000',
    );
  }
  let parsed: URL | null;
  try {
    parsed = new URL(forwardTo);
  } catch {
    parsed = null;
  }
  // `localhost:3000` parses, as the scheme `localhost:` — see listen-core.ts.
  if (parsed === null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw new Error(
      `--forward-to "${forwardTo}" is not an http(s) URL. Include the scheme:\n` +
        '  --forward-to http://localhost:3000',
    );
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    // The configured url's own query is appended (see relayTargetUrl), and
    // merging two query strings would sign one the handler does not receive.
    throw new Error(
      `--forward-to "${forwardTo}" has a query or fragment. Give an origin, optionally with a ` +
        "path prefix; each call's own path and query are appended to it.",
    );
  }

  const ids = new Set([...tools, ...cards, ...canvases]);
  return {
    forwardTo,
    tools,
    cards,
    canvases,
    secrets: parseSecrets(args, ids),
    json: bool(args.flags, 'json'),
  };
}

/**
 * Where one frame goes: `--forward-to`'s origin and path prefix, then the
 * CONFIGURED url's path and query.
 *
 * The path is preserved because for a tool call it IS the request —
 * `GET /orders/{{order_id}}` renders to `/orders/42`, and a handler that
 * cannot see the 42 cannot answer. Cards and canvases are kept the same way
 * so there is one rule, and a local server mounted under a prefix still works.
 */
export function relayTargetUrl(forwardTo: string, framePath: string): string {
  const base = new URL(forwardTo);
  const prefix = base.pathname.replace(/\/+$/, '');
  const rel = framePath.startsWith('/') ? framePath : `/${framePath}`;
  const q = rel.indexOf('?');
  const pathname = q === -1 ? rel : rel.slice(0, q);
  const search = q === -1 ? '' : rel.slice(q);
  return `${base.origin}${prefix}${pathname}${search}`;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'string')
  );
}

/**
 * The frames on one poll, and how many were unreadable.
 *
 * Hand-checked rather than zod, because this package declares the SDK as its
 * only dependency (CLAUDE.md §2: no new dependency without approval). An
 * unreadable frame is COUNTED, not silently dropped — the server is waiting
 * on it, and a relay that loses frames quietly reads as a slow handler.
 */
export function readFrames(value: unknown): { frames: RelayFrame[]; unreadable: number } {
  const list =
    typeof value === 'object' && value !== null
      ? (value as { frames?: unknown }).frames
      : undefined;
  if (!Array.isArray(list)) {
    return { frames: [], unreadable: 0 };
  }
  const frames: RelayFrame[] = [];
  let unreadable = 0;
  for (const f of list as unknown[]) {
    const r = (typeof f === 'object' && f !== null ? f : {}) as Record<string, unknown>;
    if (
      typeof r['id'] === 'string' &&
      typeof r['kind'] === 'string' &&
      (RELAY_KINDS as readonly string[]).includes(r['kind']) &&
      typeof r['targetId'] === 'string' &&
      typeof r['method'] === 'string' &&
      typeof r['path'] === 'string' &&
      isStringRecord(r['headers']) &&
      typeof r['body'] === 'string' &&
      typeof r['deadlineAt'] === 'string' &&
      !Number.isNaN(Date.parse(r['deadlineAt']))
    ) {
      frames.push(r as unknown as RelayFrame);
    } else {
      unreadable += 1;
    }
  }
  return { frames, unreadable };
}

/** Which selected set a frame's kind is checked against. */
export function selectedFor(opts: RelayOptions, kind: RelayKind): readonly string[] {
  return kind === 'ai_tool_call'
    ? opts.tools
    : kind === 'customer_card'
      ? opts.cards
      : opts.canvases;
}

export function secretFor(opts: RelayOptions, targetId: string): string | null {
  return opts.secrets.byTarget.get(targetId) ?? opts.secrets.fallback;
}
