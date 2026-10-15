/**
 * The scripted server, the frame fixture and the deps both relay specs drive.
 *
 * Extracted when `listen-relay.spec.ts` crossed the 650-line ceiling and had
 * to become two files. It is a FIXTURE module and not a spec: nothing here
 * asserts anything, and both specs' caveats live on them rather than here.
 *
 * ── The one thing worth repeating here ───────────────────────────────────
 *
 * The "server" is a fake `fetch` under the REAL `ChatlyClient`, so the SDK's
 * transport, retries and error mapping all run. What it CANNOT do is tell you
 * the server answers this way: `server()` answers what
 * `RELAY-SERVER-SPEC.md` says, which is the contract and not an observation.
 * A fake that agrees with whatever it is asked is how four mobile SDKs
 * shipped a realtime client that could not connect.
 *
 * (Original header follows.)
 *
 * `chatly listen --relay` — the CLI half, against a scripted server.
 *
 * ═══ WHAT THIS CAN AND CANNOT PROVE ═══════════════════════════════════════
 *
 * The server half is `apps/api/src/modules/relay/`, but this spec does not run
 * it: the "server" here is a fake `fetch` under the REAL `ChatlyClient` — the
 * SDK's transport, retries and error mapping all run — answering the routes
 * `RELAY-SERVER-SPEC.md` defines.
 * That proves what the CLI SENDS (the attach body, the answer it posts, the
 * request it makes to localhost and its signature) and how it reacts to each
 * answer the spec allows. It cannot prove the server will answer that way,
 * and nothing here should be read as evidence that a relay works end to end.
 *
 * Assertions are on the requests the CLI made, not on a canned response it
 * echoed: a fake that agrees with whatever it is asked is how four mobile
 * SDKs shipped a realtime client that could not connect.
 */
import { ChatlyClient } from '@chatlychat/sdk-node';


import {
  parseRelayOptions,
  type RelayFrame,
  type RelayOptions,
} from './listen-relay.js';
import { parseArgs } from '../args.js';

import type { ListenDeps } from './listen-core.js';

export const NOW_MS = 1_760_000_000_123;
export const SESSION = 'rs_1';
export const TOOL = 'tool_orders';
export const CARD = 'card_billing';
export const CANVAS = 'ch_web';
export const SECRET = 'tool-secret-from-the-form';

export interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
}

export function headersOf(init?: RequestInit): Record<string, string> {
  const h = init?.headers;
  if (h instanceof Headers) {
    return Object.fromEntries(h.entries());
  }
  return { ...((h ?? {}) as Record<string, string>) };
}

export function frame(over: Partial<RelayFrame> = {}): RelayFrame {
  return {
    id: 'fr_1',
    kind: 'ai_tool_call',
    targetId: TOOL,
    method: 'GET',
    path: '/orders/42?expand=items',
    headers: {
      'x-chatly-contact-external-id': 'u_7',
      'x-chatly-identity-verified': 'true',
      'x-chatly-conversation-id': 'c_1',
    },
    body: '',
    deadlineAt: new Date(NOW_MS + 30_000).toISOString(),
    ...over,
  };
}

export type Answer = { status: number; body?: unknown; code?: string };

/** A scripted relay server: attach, a queue of poll answers, answer + detach. */
export function server(opts: { attach?: Answer; polls?: ReadonlyArray<Answer> } = {}): {
  chatly: ChatlyClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  let poll = 0;
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    const method = init?.method ?? 'GET';
    calls.push({
      url: href,
      method,
      headers: headersOf(init),
      body: typeof init?.body === 'string' ? init.body : null,
    });
    const path = new URL(href).pathname;
    const reply = (a: Answer): Response => {
      if (a.status === 204) {
        return new Response(null, { status: 204 });
      }
      const body =
        a.code === undefined ? (a.body ?? {}) : { error: { code: a.code, message: a.code } };
      return new Response(JSON.stringify(body), {
        status: a.status,
        headers: { 'content-type': 'application/json' },
      });
    };
    if (method === 'POST' && path === '/v1/relay-sessions') {
      return reply(
        opts.attach ?? {
          status: 201,
          body: { id: SESSION, attachedBy: { displayName: 'key "laptop" (Ada)' } },
        },
      );
    }
    if (method === 'GET' && path === `/v1/relay-sessions/${SESSION}/frames`) {
      const list = opts.polls ?? [{ status: 200, body: { frames: [] } }];
      const a = list[Math.min(poll, list.length - 1)] ?? { status: 200, body: { frames: [] } };
      poll += 1;
      return reply(a);
    }
    if (method === 'POST' && path.startsWith(`/v1/relay-sessions/${SESSION}/frames/`)) {
      return reply({ status: 202, body: { accepted: true } });
    }
    if (method === 'DELETE' && path === `/v1/relay-sessions/${SESSION}`) {
      return reply({ status: 204 });
    }
    return reply({ status: 599, body: { unexpected: path } });
  }) as unknown as typeof fetch;

  return {
    chatly: new ChatlyClient({
      apiKey: 'ck_test',
      apiUrl: 'https://api.test',
      fetchFn,
      sleepFn: async () => undefined,
      retry: { attempts: 1 },
    }),
    calls,
  };
}

/** The local handler: records every forward, answers as scripted. */
export function harness(
  over: {
    respond?: (call: Call) => Response | Promise<Response>;
    now?: () => number;
    maxPolls?: number;
    signal?: AbortSignal;
  } = {},
): { deps: ListenDeps; forwards: Call[]; out: string[]; err: string[] } {
  const forwards: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: headersOf(init),
      body: typeof init?.body === 'string' ? init.body : null,
    };
    forwards.push(call);
    return over.respond === undefined
      ? new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      : over.respond(call);
  }) as unknown as typeof fetch;
  return {
    deps: {
      fetchFn,
      now: over.now ?? (() => NOW_MS),
      sleep: async () => undefined,
      signal: over.signal ?? new AbortController().signal,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      maxPolls: over.maxPolls ?? 1,
    },
    forwards,
    out,
    err,
  };
}

export function options(argv: string): RelayOptions {
  return parseRelayOptions(parseArgs(['listen', '--relay', ...argv.split(' ').filter(Boolean)]));
}

export const ALL = `--tool ${TOOL} --card ${CARD} --canvas ${CANVAS} --forward-to http://localhost:3000`;
