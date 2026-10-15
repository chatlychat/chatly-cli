/**
 * `chatly listen --relay` — receive Chatly's SYNCHRONOUS calls on localhost.
 *
 * ═══ WHY A LEDGER TAIL CANNOT DO THIS ═════════════════════════════════════
 *
 * `listen` and `listen --bot` tail delivery LOGS: the platform has already
 * made the request, and the CLI replays a copy. Three surfaces have no such
 * log and could not use one if they did — an AI tool call, a customer-card
 * fetch and a canvas step. Each is made INSIDE a visitor's request: Chatly
 * calls the configured URL and waits for the answer, which is the point of
 * the call (the tool result, the card's content, the next step). A copy that
 * arrives afterwards is useless, because by then the visitor has been shown
 * the configured URL's answer, or its timeout.
 *
 * So `--relay` opens an outbound session and, while it lives, the server
 * sends calls for the ids named on the command line to this process instead
 * of to the configured URL. The CLI forwards each to `--forward-to`, re-signed
 * (`listen-relay-sign.ts` says why the server does not sign), and posts the
 * answer back, and the server hands that answer to the waiting caller as if
 * the configured URL had given it.
 *
 * ═══ WHICH HALF OF THIS IS REAL ═══════════════════════════════════════════
 *
 * BOTH. The server half is `apps/api/src/modules/relay/` (shipped 2026-10-15),
 * built against `apps/cli/RELAY-SERVER-SPEC.md`, which stays the contract: if
 * the two disagree, the spec is right and this is the bug. The wire types are
 * `@livechat/shared/relay`, and `scripts/check-relay-protocol-parity.mjs`
 * checks the fields this file reads against them.
 *
 * `explainMissingServer` stays anyway. A CLI release reaches users before an
 * API deploy does, and a 404 on the first request is then the route being
 * absent, not a typo — it needs a sentence that says nothing was redirected,
 * rather than a bare "Not Found". (Chatly is a managed service, so there is no
 * older self-hosted API to blame; the window is the deploy ordering.)
 *
 * ═══ WHY LONG-POLL AND NOT A WEBSOCKET ════════════════════════════════════
 *
 * The CLI declares one dependency, the published SDK, and runs on Node 20,
 * which has no WebSocket client without a package. Server-Sent Events would
 * need a second channel for the answers anyway. A long-poll goes through the
 * SDK's own transport — auth, retries, typed errors — and its lease semantics
 * are the teardown rule: a session nobody has polled for 30 seconds is dead.
 * The poll waits 10 seconds because the SDK's request timeout is 15.
 *
 * ═══ THE TWO SAFETY RULES, AND WHERE THEY LIVE ════════════════════════════
 *
 *  1. **Explicit ids.** `--tool`, `--card`, `--canvas` — there is no
 *     "everything" form, because a relay takes PRODUCTION traffic. A frame
 *     for an id that was not asked for is answered with an error rather than
 *     forwarded: that would be a server bug routing a stranger's visitor to a
 *     developer's laptop, and the laptop is the last place it can be stopped.
 *  2. **10 minutes idle.** Enforced by the server (authoritative) AND here,
 *     so a forgotten terminal detaches itself and says so. It is not a flag:
 *     a longer one is how a relay gets forgotten.
 */
import { hostname, userInfo } from 'node:os';

import { ChatlyApiError, type ChatlyClient } from '@chatlychat/sdk-node';

import {
  secretFor,
  selectedFor,
  relayTargetUrl,
  readFrames,
  type RelayAnswer,
  type RelayFrame,
  type RelayOptions,
} from './listen-relay-options.js';
import { RELAY_OWNED_HEADERS, signRelayedRequest } from './listen-relay-sign.js';
import { printJson } from '../output.js';

import type { ListenDeps } from './listen-core.js';

export {
  parseRelayOptions,
  readFrames,
  relayOnlyFlagWithoutRelay,
  relayTargetUrl,
  type RelayAnswer,
  type RelayFrame,
  type RelayOptions,
  type RelaySecrets,
} from './listen-relay-options.js';

/** Detach after this long with no frame. See the header, rule 2. */
export const RELAY_IDLE_TIMEOUT_MS = 10 * 60_000;
/** Long-poll wait. Under the SDK transport's 15s request timeout. */
export const RELAY_POLL_WAIT_SECONDS = 10;
/** A local answer larger than this is refused rather than relayed. */
export const RELAY_MAX_RESPONSE_BYTES = 1_048_576;
/** The protocol version this CLI speaks, sent on attach. */
export const RELAY_PROTOCOL_VERSION = 1;
/**
 * `relayAnswerSchema` caps an error answer's `message` at 2,000 characters.
 * An `unreachable` message embeds the OS error and the URL, so a long one is
 * possible — and over the cap the server answers 422, the answer is never
 * recorded, and the visitor waits out the whole deadline instead of failing
 * fast. Clamped here rather than trusting the message to be short.
 */
const MAX_ERROR_MESSAGE_CHARS = 2_000;
/** Backoff ceiling for a poll that failed to reach the server. */
const MAX_BACKOFF_MS = 8_000;

export interface RelaySummary {
  readonly frames: number;
  readonly answered: number;
  readonly failed: number;
  readonly polls: number;
  /** Why the session ended, in the server's vocabulary where it has one. */
  readonly endReason: string;
}

/** The forward leg of `answerFrame`, before the message cap is applied. */
async function answerFrameUnclamped(
  opts: RelayOptions,
  deps: ListenDeps,
  frame: RelayFrame,
  signal: AbortSignal,
): Promise<RelayAnswer> {
  const started = deps.now();
  const elapsed = (): number => Math.max(0, deps.now() - started);

  if (!selectedFor(opts, frame.kind).includes(frame.targetId)) {
    return {
      error: 'not_selected',
      message: `this relay did not ask for ${frame.kind} ${frame.targetId}`,
      durationMs: 0,
    };
  }

  const url = relayTargetUrl(opts.forwardTo, frame.path);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(frame.headers)) {
    if (!RELAY_OWNED_HEADERS.has(name.toLowerCase())) {
      headers[name.toLowerCase()] = value;
    }
  }
  // Not a header Chatly sends; see listen-core.ts.
  headers['x-chatly-cli-forwarded'] = '1';

  const secret = secretFor(opts, frame.targetId);
  if (secret !== null) {
    const signed = signRelayedRequest({
      kind: frame.kind,
      method: frame.method,
      targetUrl: url,
      body: frame.body,
      secret,
      nowMs: deps.now(),
    });
    if (!signed.ok) {
      return {
        error: 'signing_failed',
        message: `the signature chatly listen minted does not verify (${signed.message})`,
        durationMs: 0,
      };
    }
    Object.assign(headers, signed.headers);
  }

  // Abort at the caller's deadline: after it, nobody is waiting for this.
  const budget = Date.parse(frame.deadlineAt) - deps.now();
  const ctrl = new AbortController();
  const onAbort = (): void => {
    ctrl.abort();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      ctrl.abort();
    },
    Math.max(0, budget),
  );
  try {
    const method = frame.method.toUpperCase();
    const res = await deps.fetchFn(url, {
      method,
      headers,
      ...(method === 'GET' || method === 'HEAD' ? {} : { body: frame.body }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > RELAY_MAX_RESPONSE_BYTES) {
      return {
        error: 'too_large',
        message: `your handler answered more than ${String(RELAY_MAX_RESPONSE_BYTES)} bytes`,
        durationMs: elapsed(),
      };
    }
    const contentType = res.headers.get('content-type');
    return {
      status: res.status,
      headers: contentType === null ? {} : { 'content-type': contentType },
      body: text,
      durationMs: elapsed(),
    };
  } catch (err) {
    if (timedOut) {
      return {
        error: 'timeout',
        message: `${url} did not answer before the caller's deadline (${frame.deadlineAt})`,
        durationMs: elapsed(),
      };
    }
    if (signal.aborted) {
      return { error: 'interrupted', message: 'the relay was stopped', durationMs: elapsed() };
    }
    return {
      error: 'unreachable',
      message: `${url} unreachable: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: elapsed(),
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Forward one frame to localhost and build the answer. Never throws: every
 * failure is an answer, because the server is holding a visitor's request
 * open until it gets one.
 */
export async function answerFrame(
  opts: RelayOptions,
  deps: ListenDeps,
  frame: RelayFrame,
  signal: AbortSignal,
): Promise<RelayAnswer> {
  const answer = await answerFrameUnclamped(opts, deps, frame, signal);
  return 'error' in answer && answer.message.length > MAX_ERROR_MESSAGE_CHARS
    ? { ...answer, message: `${answer.message.slice(0, MAX_ERROR_MESSAGE_CHARS - 1)}…` }
    : answer;
}

/** A promise that settles to `null` on abort, so Ctrl-C does not wait out a long-poll. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) {
    p.catch(() => undefined);
    return Promise.resolve(null);
  }
  return new Promise<T | null>((resolve, reject) => {
    const onAbort = (): void => {
      resolve(null);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** `relay_ended_<reason>` → `<reason>`, per RELAY-SERVER-SPEC.md §4. */
function endReasonFromCode(code: string | null): string {
  return code !== null && code.startsWith('relay_ended_')
    ? code.slice('relay_ended_'.length)
    : 'ended';
}

/**
 * The 404 a server without this feature answers, as a sentence.
 *
 * Exported for the spec. A CLI released ahead of the API deploy gets this, so
 * it has to say plainly that the route is missing rather than that the user
 * typed something wrong.
 */
export function explainMissingServer(err: unknown): Error | null {
  /*
   * 404 can only mean the ROUTE: the spec answers an unknown target id with
   * 422 `relay_target_not_found`, precisely so this branch cannot mistake a
   * typo'd id for a missing feature (RELAY-SERVER-SPEC.md §3.1).
   */
  if (err instanceof ChatlyApiError && (err.status === 404 || err.status === 405)) {
    return new Error(
      'This Chatly API has no relay route (POST /v1/relay-sessions answered ' +
        `${String(err.status)}). This API has not been deployed with the relay yet, or ` +
        'this CLI is newer than the API it talks to. Tool calls, card fetches and canvas steps still go to their configured ' +
        'URLs — nothing was redirected.',
    );
  }
  return null;
}

function attachLabel(): string {
  // `userInfo()` throws when the uid has no passwd entry (some containers).
  let user = 'unknown';
  try {
    user = userInfo().username;
  } catch {
    user = 'unknown';
  }
  return `chatly-cli ${user}@${hostname()}`;
}

interface SessionRow {
  readonly id: string;
  readonly attachedBy: string;
}

function readSession(value: unknown): SessionRow {
  const r = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  if (typeof r['id'] !== 'string') {
    throw new Error('POST /v1/relay-sessions answered without a session id; refusing to poll.');
  }
  const by = (
    typeof r['attachedBy'] === 'object' && r['attachedBy'] !== null ? r['attachedBy'] : {}
  ) as Record<string, unknown>;
  const who = typeof by['displayName'] === 'string' ? by['displayName'] : 'this API key';
  return { id: r['id'], attachedBy: who };
}

function banner(opts: RelayOptions, session: SessionRow, deps: ListenDeps): void {
  deps.out(`Relay ${session.id} attached as ${session.attachedBy}.`);
  deps.out('PRODUCTION calls for these targets now come to this terminal instead of their URLs:');
  for (const id of opts.tools) {
    deps.out(`  tool    ${id}`);
  }
  for (const id of opts.cards) {
    deps.out(`  card    ${id}`);
  }
  for (const id of opts.canvases) {
    deps.out(`  canvas  ${id}  (channel)`);
  }
  deps.out(`Forwarding to ${opts.forwardTo} (each call's own path is appended).`);
  const unsigned = [...opts.tools, ...opts.cards, ...opts.canvases].filter(
    (id) => secretFor(opts, id) === null,
  );
  if (unsigned.length > 0) {
    deps.out(
      `UNSIGNED for ${unsigned.join(', ')}: no --secret, so your handler's verifier will ` +
        'reject those calls and the visitor will see the failure.',
    );
  }
  deps.out(
    'The dashboard shows a banner while this is attached. Detaches after 10 minutes with no ' +
      'call, or on Ctrl-C.\n',
  );
}

/**
 * The relay loop. Exported for the spec, bounded by `deps.maxPolls` there.
 *
 * Frames are answered CONCURRENTLY: each one has its own caller waiting with
 * its own deadline, and a slow tool call must not make a card fetch behind it
 * time out.
 */
export async function relay(
  chatly: ChatlyClient,
  opts: RelayOptions,
  deps: ListenDeps,
): Promise<RelaySummary> {
  let created: unknown;
  try {
    created = await chatly.request<unknown>('POST', '/v1/relay-sessions', {
      body: {
        protocol: RELAY_PROTOCOL_VERSION,
        targets: { tools: opts.tools, customerCards: opts.cards, canvasChannels: opts.canvases },
        idleTimeoutSeconds: RELAY_IDLE_TIMEOUT_MS / 1000,
        label: attachLabel(),
      },
    });
  } catch (err) {
    throw explainMissingServer(err) ?? err;
  }
  const session = readSession(created);
  banner(opts, session, deps);

  const base = `/v1/relay-sessions/${encodeURIComponent(session.id)}`;
  const forwards = new AbortController();
  const stopForwards = (): void => {
    forwards.abort();
  };
  deps.signal.addEventListener('abort', stopForwards, { once: true });

  const inflight = new Set<Promise<void>>();
  let frames = 0;
  let answered = 0;
  let failed = 0;
  let polls = 0;
  let failures = 0;
  let lastActivity = deps.now();
  let endReason = 'interrupted';
  let endedByServer = false;

  const handle = async (frame: RelayFrame): Promise<void> => {
    const answer = await answerFrame(opts, deps, frame, forwards.signal);
    const line =
      'error' in answer
        ? `   ↳ ${answer.error}: ${answer.message}`
        : `   ↳ ${String(answer.status)} in ${String(answer.durationMs)}ms`;
    if ('error' in answer) {
      failed += 1;
      deps.err(`${line}\n`);
    } else {
      // A 4xx/5xx from the handler is still an ANSWER: it is relayed, and the
      // surface treats it exactly as it treats one from the configured url.
      answered += 1;
      if (answer.status >= 400) {
        deps.err(`${line}\n`);
      } else {
        deps.out(line);
      }
    }
    try {
      await chatly.request('POST', `${base}/frames/${encodeURIComponent(frame.id)}/response`, {
        body: answer,
      });
    } catch (err) {
      // 410: the deadline passed or the session ended first. The caller has
      // already been answered with the surface's own timeout.
      const why =
        err instanceof ChatlyApiError ? `${String(err.status)} ${err.code ?? ''}` : String(err);
      deps.err(`   ↳ the answer to ${frame.id} was not accepted (${why.trim()})\n`);
    }
  };

  try {
    for (;;) {
      if (deps.signal.aborted) {
        endReason = 'interrupted';
        break;
      }
      if (deps.maxPolls !== undefined && polls >= deps.maxPolls) {
        endReason = 'max_polls';
        break;
      }
      if (deps.now() - lastActivity >= RELAY_IDLE_TIMEOUT_MS) {
        endReason = 'idle';
        deps.out('No call for 10 minutes; detaching so this relay cannot be forgotten.');
        break;
      }
      polls += 1;

      let page: unknown;
      try {
        page = await raceAbort(
          chatly.request<unknown>('GET', `${base}/frames`, {
            query: { waitSeconds: RELAY_POLL_WAIT_SECONDS },
          }),
          deps.signal,
        );
      } catch (err) {
        if (err instanceof ChatlyApiError && (err.status === 410 || err.status === 404)) {
          endedByServer = true;
          endReason = err.status === 404 ? 'not_found' : endReasonFromCode(err.code);
          deps.err(`The server ended this relay (${endReason}).\n`);
          break;
        }
        /*
         * Network or 5xx after the SDK's own retries. Keep trying, with
         * backoff: if this outlasts the server's 30s lease the session is
         * torn down there and the next successful poll answers 410, which is
         * the exit. The CLI does not guess the lease itself.
         */
        failures += 1;
        deps.err(
          `poll failed (${err instanceof Error ? err.message : String(err)}); retrying. ` +
            'Calls for these targets fail until it recovers.\n',
        );
        await deps.sleep(Math.min(MAX_BACKOFF_MS, 500 * 2 ** (failures - 1)), deps.signal);
        continue;
      }
      if (page === null) {
        continue; // aborted mid-poll; the top of the loop sees it
      }
      failures = 0;

      const { frames: fresh, unreadable } = readFrames(page);
      if (unreadable > 0) {
        deps.err(
          `${String(unreadable)} frame(s) this CLI could not read and could not answer — a newer ` +
            'server protocol than this CLI speaks? Upgrade @chatlychat/cli.\n',
        );
      }
      for (const frame of fresh) {
        frames += 1;
        lastActivity = deps.now();
        if (opts.json) {
          printJson(frame);
        } else {
          deps.out(
            `${frame.kind}  ${frame.targetId}  ${frame.method.toUpperCase()} ${frame.path}  ${frame.id}`,
          );
        }
        const p = handle(frame).finally(() => {
          inflight.delete(p);
        });
        inflight.add(p);
      }
    }
  } finally {
    deps.signal.removeEventListener('abort', stopForwards);
    /*
     * In-flight forwards are NOT aborted on a graceful end (idle, the server
     * ending it): each has a caller waiting with its own deadline, and an
     * answer that arrives is better than an `interrupted` one. Ctrl-C aborts
     * them through `stopForwards`, which is the developer asking.
     */
    await Promise.allSettled([...inflight]);
    if (!endedByServer) {
      // Best effort: the server's lease tears it down anyway if this fails.
      try {
        await chatly.request('DELETE', base);
      } catch {
        deps.err('Could not detach cleanly; the server will drop the relay within 30s.\n');
      }
    }
  }

  return { frames, answered, failed, polls, endReason };
}
