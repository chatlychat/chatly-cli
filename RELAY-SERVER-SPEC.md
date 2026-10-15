# `chatly listen --relay` — server specification

**Status: BUILT.** Server half: `apps/api/src/modules/relay/` (shipped 2026-10-15), with the wire types in `packages/shared/src/relay/`. The CLI half is `src/commands/listen-relay.ts`, `listen-relay-sign.ts` and their spec. On a 404 at attach (an API deployed before this CLI release), `chatly listen --relay` says the route is missing and that nothing was redirected.

This document is the contract. If the CLI and this file disagree, this file wins and the CLI has the bug. Protocol version: **1**.

---

## 1. What it is for

Three outbound surfaces are **synchronous**: Chatly calls a configured URL inside a visitor's request and waits for the answer.

| kind            | call site today (verified 2026-10-15)                                                                                              | method     | timeout today                                                     | target id        |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------- | ---------------- |
| `ai_tool_call`  | `dialCustomTool` in `packages/shared/src/ai-tools/dial.ts` (called from `apps/api` ai-approvals and three worker paths)            | the tool's | `tool.timeoutSeconds`, clamped to `MAX_TOOL_TIMEOUT_SECONDS` = 30 | the tool's id    |
| `customer_card` | `CustomerCardsFetcher.attempt()` in `apps/api/src/modules/customer-cards/customer-cards.fetcher.ts`                                | POST       | `CARD_TIMEOUT_MS` = 15 000, two attempts                          | the card's id    |
| `canvas_step`   | `WidgetCanvasService.callIntegrator()` in `apps/api/src/modules/widget/widget-canvas.service.ts` (from `submit` and `requestStep`) | POST       | the channel's `canvas.timeoutSeconds`, default 10, max 25         | the channel's id |

A developer cannot receive any of them on localhost, and the delivery-ledger tail that `listen` and `listen --bot` use cannot cover them: the response is the point, and a log row arrives after the visitor has been answered.

A **relay session** is an outbound connection from the CLI. While it lives, the server routes calls for the **explicitly selected** target ids in that workspace to the relay instead of the configured URL, waits for the CLI's answer, and treats that answer exactly as if the configured URL had given it.

## 2. Non-negotiables

1. **Explicit ids only.** No wildcard, no "all tools". An attach with zero targets is a 422.
2. **10 minutes idle** detaches the session, enforced server-side. The CLI also enforces it, but the server is authoritative — a CLI build that forgot must not be able to hold traffic.
3. **A dashboard banner** names who attached the relay, for as long as it is attached (§7).
4. **No fallback to the configured URL** for a relayed call that the relay fails to answer. The call fails with that surface's ordinary timeout or transport error. Falling back would run a side-effecting tool call twice, once on the laptop and once in production.
5. **No production-valid signature leaves the server** (§5).
6. **No operator-configured static header leaves the server** (§5). Tools and cards can carry `Authorization: Bearer <the customer's own API key>`.

## 3. Routes

All under `@Controller({ path: 'relay-sessions', version: '1' })`. Every route except §3.5 carries `@AllowApiKey()`. The class declares `@RequireIdempotencyKey()` and the handlers override it as noted. Run `scripts/check-idempotency-classified.mjs`.

### 3.1 `POST /v1/relay-sessions` — attach

Idempotency: **Required**. The SDK sends a key on every write, and a retried attach must not open two sessions.

Permission: the **write** permission of every surface named, checked per surface:

- `targets.tools` non-empty → `ai:write`
- `targets.customerCards` non-empty → `integrations:write`
- `targets.canvasChannels` non-empty → `channels:write`

The reasoning is that attaching a relay redirects a surface's traffic, which is the same power as editing its URL.

Request body (zod, in `packages/shared/src/relay/protocol.ts`, so the API and worker import one definition):

```ts
{
  protocol: z.literal(1),
  targets: z.object({
    tools: z.array(z.string().min(1)).max(20).default([]),
    customerCards: z.array(z.string().min(1)).max(20).default([]),
    canvasChannels: z.array(z.string().min(1)).max(20).default([]),
  }),
  idleTimeoutSeconds: z.number().int().min(60).max(600).default(600),
  label: z.string().max(200).optional(),
}
```

`label` is client-supplied (the CLI sends `chatly-cli <user>@<host>`). It is **display only** and never the authority for "who attached this" (§7).

Responses:

- **201** `{ id, workspaceId, targets, attachedBy: { kind: 'api_key', apiKeyId, apiKeyName, createdByMembershipId, displayName }, label, leaseSeconds: 30, idleTimeoutSeconds, maxLifetimeSeconds, createdAt, expiresAt }`. The CLI reads `id` and `attachedBy.displayName`.
- **422 `relay_target_not_found`** for an id that does not exist in this workspace, with the id named in `details`. It must not be a 404: the CLI reads a 404 or 405 on this route as "the server has no relay feature" and says so.
- **422 `relay_no_targets`** for an empty selection.
- **409 `relay_target_busy`** when another live session already holds one of the ids. Name the holder's `displayName` in the message. One relay per target, because two laptops answering the same tool call is a race nobody can debug.
- **422 `relay_target_not_relayable`** for a target with nothing to relay: a tool with no URL, a card with no URL, or a channel with no `canvas` endpoint. Same reasoning as `listen --bot` refusing an agent with no `webhookUrl`.

### 3.2 `GET /v1/relay-sessions/{id}/frames?waitSeconds=N` — long-poll

`waitSeconds` takes an integer from 0 to 10; the CLI sends 10, because the SDK transport's request timeout is 15s. The route holds the request for up to `waitSeconds` and returns as soon as at least one frame is queued.

- **200** `{ frames: RelayFrame[] }`. An empty array is a normal timeout.
- **410** with `error.code = relay_ended_<reason>`, where reason is `idle | detached | lease_expired | revoked | max_lifetime`. The CLI prints the reason and exits, and does not DELETE.
- **404** for a session id that is not this workspace's, or one that has never existed.

**Every poll renews the lease.** This route is the liveness signal (§6).

Only the API key that attached the session may poll it; any other key gets a 404. Without that rule, a second key in the same workspace could drain frames meant for someone else's laptop.

```ts
RelayFrame = {
  id: string,              // frame id, unique, the answer key
  kind: 'ai_tool_call' | 'customer_card' | 'canvas_step',
  targetId: string,        // tool id | card id | channel id — one of the session's targets
  method: string,          // the method the configured url would have received
  path: string,            // pathname + search of the CONFIGURED url, rendered
  headers: Record<string, string>,  // §5: Chatly-defined headers only
  body: string,            // exactly the bytes the configured url would have received; '' for none
  deadlineAt: string,      // ISO 8601; when the waiting caller gives up
  configuredUrl?: string,  // display only
}
```

`deadlineAt` is the waiting caller's deadline under that surface's existing timeout (§1), not a new one. A relay must not make a tool call wait longer than it would wait for the real URL.

Customer-card **groups**: the fetcher sends one request per URL group containing several cards. When a group contains a selected card, split it. The selected cards become one relayed frame and the rest go to the configured URL as usual. A non-selected card's data must never reach the relay.

### 3.3 `POST /v1/relay-sessions/{id}/frames/{frameId}/response` — answer

Idempotency: **Optional** (`@OptionalIdempotency()`). The frame id already makes the answer naturally idempotent: the first answer wins.

Body: exactly one of (the range was `100..599` in this document's first version; a 1xx is an
interim response the CLI can never produce from a real HTTP reply, and
`new Response(body, { status: 101 })` throws — so accepting one would have turned a CLI bug
into a transport failure the call site reports as the operator's endpoint failing)

```ts
{ status: number(200..599), headers: Record<string,string>, body: string, durationMs: number }
{ error: 'unreachable'|'timeout'|'too_large'|'not_selected'|'signing_failed'|'interrupted', message: string, durationMs: number }
```

The CLI caps `body` at 1 MiB and sends `too_large` above that. The server applies **the same response-size cap it applies to the configured URL** on that surface, on top of this one.

- **202** `{ accepted: true }`.
- **409 `relay_frame_answered`** for a second answer.
- **410 `relay_frame_expired`** once `deadlineAt` has passed. The caller has already failed with the surface's timeout.

How the server applies an answer:

- **status arm**: build a `Response` from `status`, `headers['content-type']` and `body`, and hand it to the call site's existing response handling, unchanged. A 500 from the developer's handler is handled exactly like a 500 from production, including the card fetcher's retry rule (its second attempt becomes a second frame **while the session is still alive** — if it ended in between, the retry fails as a transport error and does NOT reach the configured URL, because a side-effecting call run once on a laptop and once in production is what §2.4 forbids).
- **error arm**: map it to the same failure the call site records for a transport error or timeout. Store `message` in the call's trace or log, and **never show it to the visitor** (it contains a localhost URL).
- `not_selected` means the server routed a frame for an id the CLI did not ask for. That is a server bug. Log it at error level with the session and target ids.

### 3.4 `DELETE /v1/relay-sessions/{id}` — detach

Idempotency: **Optional**. Returns **204**, including for a session that has already ended. The CLI calls it on Ctrl-C, on idle, and on any exit except a 410.

### 3.5 `GET /v1/relay-sessions` — list live sessions (the banner)

Agent session auth, so the dashboard can call it, plus `@AllowApiKey()` so the CLI or ops can see who holds a target. Permission: **`workspace:read`** — this document said `integrations:read`, and that defeated §7: `restricted` and `light_agent` do not hold it, so the banner was hidden from exactly the teammate §7 says it exists for, who meanwhile sees customer cards served from a laptop. Every seated role holds `workspace:read`. The disclosure that buys — key names, the creating member's name, target names, timings — is recorded in ADR 0058. Returns `{ items: RelaySessionView[] }` with **no pagination** (`@PaginationExempt`). It is bounded by the per-workspace cap in §8.

`RelaySessionView` has the same fields as the attach response, plus `lastPolledAt`,
`lastFrameAt`, `framesRelayed` and `targetViews`.

`targetViews` is `{ kind, id, name }[]` — the same ids as `targets`, flattened and NAMED by the
server. This document originally left the banner to resolve names itself, and the dashboard did:
three extra requests on every page (the banner is in the shell), and it degraded by ROLE, so the
teammate without `ai:read` got "an AI tool" where the name was the whole point. `name` is null
when the target was deleted while the relay held it, which is a real state the banner still has
to describe truthfully.

### 3.6 `DELETE /v1/relay-sessions/{id}` from the dashboard — revoke

The same route as §3.4, which also accepts an agent session with the permission in §3.1. This is how a teammate kills a forgotten relay from the banner. The CLI's next poll then gets `410 relay_ended_revoked`.

## 4. Error codes

All of them extend `AppError` (CLAUDE.md §4). The CLI parses `relay_ended_<reason>` by its prefix, so a new reason needs no CLI release.

| code                         | status |
| ---------------------------- | ------ |
| `relay_no_targets`           | 422    |
| `relay_target_not_found`     | 422    |
| `relay_target_not_relayable` | 422    |
| `relay_target_busy`          | 409    |
| `relay_ended_<reason>`       | 410    |
| `relay_frame_answered`       | 409    |
| `relay_frame_expired`        | 410    |

## 5. Signatures and headers: the server sends neither

**Frames are unsigned.** The server holds every surface's real secret, and signing the frame would let the CLI forward byte-for-byte. That design was rejected: a frame with a production-valid signature is a replayable credential delivered to every holder of a `ck_` key with the relay permission. Customer-card and canvas signatures cover `<ts>.<body>` only, with no path, so the same bytes are accepted by the operator's **real** endpoint for the next five minutes.

The CLI re-signs each frame with the secret the developer passes in `--secret`, using the surface's own construction, and self-checks the result with `verifyChatlySignature` before sending. The frame **must not** carry `x-chatly-signature`, `x-chatly-signature-v2`, `x-chatly-timestamp`, `x-chatly-canvas-signature` or `x-chatly-canvas-ts`. The CLI strips them defensively; do not rely on that.

**Frames carry Chatly-defined headers only**:

- `ai_tool_call`: `x-chatly-contact-external-id`, `x-chatly-identity-verified`, `x-chatly-conversation-id` (the identity headers `dialCustomTool` adds), and `content-type` when there is a body.
- `customer_card`: `content-type`, `accept`, `x-chatly-workspace-id`, the card secret-scope header and `x-chatly-card-id` exactly as `attempt()` sets them.
- `canvas_step`: `content-type`.

The operator's configured static headers (`card.headers`, the tool's headers) are **never** included. They exist to authenticate Chatly to the operator's own backend, and handing them to a laptop is handing over that credential.

## 6. Liveness, teardown and the idle rule

State lives in Redis, which the API and the worker both reach, because tool calls are dialled from the worker:

- `relay:{workspaceId}:target:{kind}:{targetId}` → `sessionId`, set NX on attach (that NX is the `relay_target_busy` check).
- `relay:session:{sessionId}` → JSON session record, TTL = `leaseSeconds`, **refreshed on every poll**.
- `relay:session:{sessionId}:frames` → list. The poll route does `BLPOP` on it with a **dedicated** connection, never the shared client: a blocking command on a shared connection stalls every other caller on it.
- `relay:frame:{frameId}:answer` → list. The waiting call site does `BLPOP` until `deadlineAt`.

Use a Chatly-owned key prefix and account for the shared Redis instance's memory limit (see the shared-Redis OOM history). Frames are small and short-lived, but they cost memory, and the per-workspace cap in §8 bounds them.

**The route at a call site.** Each of the three call sites first asks `relayRouter.lookup(workspaceId, kind, targetId)`, which costs one Redis `GET` on the target key and one `EXISTS` on the session key. A miss means the call goes to the configured URL exactly as today, so the hot path pays two Redis reads and nothing else. A hit means: enqueue the frame, wait on the answer list until `deadlineAt`, then apply §3.3. Put the router in `packages/shared/src/relay/` so the API and the worker import the same one.

**A dead socket tears the relay down within 30 s.** No poll for `leaseSeconds` (30) expires the session key. From then on `lookup` misses, so new calls go back to the configured URL and nothing is stuck. Frames already queued are failed as timeouts by their own deadlines, so no extra code is needed for them. A sweeper (a BullMQ repeatable job, `attempts: 1`, see the retry-pileup history) clears target keys whose session key has expired and stamps `ended_at` / `end_reason = 'lease_expired'` on the Postgres row.

**Idle.** No frame enqueued for `idleTimeoutSeconds` (default and maximum 600) ends the session with `idle`. Check it on poll and in the sweeper.

**Max lifetime.** 4 hours from attach ends the session with `max_lifetime`, whatever its activity. **This item is a recommendation and not part of the ask**: it stops a relay that receives one call every 9 minutes from living forever. Product decides whether to keep it.

**On any end:** delete the target keys, delete the session key, fail queued frames immediately, stamp the Postgres row, and emit `relay_session.ended` (§7).

## 7. The banner's data source

**Postgres is the authority; Redis is the routing.** New table `relay_sessions` (one migration, RLS per workspace, CLAUDE.md §4):

```
id uuid v7, workspace_id, api_key_id (FK), created_by_membership_id (nullable FK: the key's creator),
label text, targets jsonb, created_at, updated_at, last_polled_at, last_frame_at,
frames_relayed int, ended_at, end_reason text
```

The banner shows rows with `ended_at IS NULL AND last_polled_at > now() - interval '30 seconds'`. The second condition keeps the banner correct even if the sweeper is down: a row whose lease expired drops off the banner without anyone stamping it. Update `last_polled_at` at most once every 10 s per session, not on every poll.

**"Who attached it"** comes from server data only: the API key's name and the member who created the key, e.g. `key "laptop" (created by Ada Lovelace)`. The CLI's `label` shows as secondary text. A banner that trusts `label` lets anyone with a key write whatever name they like there.

**Live updates.** The dashboard fetches §3.5 on load. Realtime events `relay_session.attached` and `relay_session.ended` (typed envelope, durable-then-deliver: write the row, then publish) refresh it. The banner names each target by its display name ("AI tool _Order lookup_"), and its "Detach" button calls §3.6.

**Where it renders:** across the top of the dashboard on every page, not only on the tool, card or channel page. The failure it exists to prevent is a teammate who never opens those pages.

## 8. Limits

- At most 20 ids per surface per session, and at most 5 live sessions per workspace.
- At most 100 queued frames per session. Past that, a new call fails immediately as that surface's transport error, so a stalled laptop cannot build a backlog in Redis.
- Rate limiting: the poll route falls under the API key's normal limit. One poll every 10 s per session is negligible.

## 9. Tests the server half must ship with

- Each call site: a relayed target gets a frame and **no** request to the configured URL; a non-selected target is untouched.
- A missing answer leads to the surface's ordinary timeout failure, and **no fallback request** goes to the configured URL (assert zero requests to it).
- No poll for 30 s: the next call goes to the configured URL and the banner query no longer returns the row.
- Assert on what the server SENDS in a frame: no signature header, no operator static header, the card group split.
- `relay_target_busy`, `relay_target_not_found` (422, not 404), the permission per surface, and a different key's poll answering 404.
- Integration tier against real Redis, because `BLPOP` on a dedicated connection is the part a mock will agree with.
- An app-di spec for every new Nest provider.

## 10. What the CLI does, for reference

`chatly listen --relay --tool <id> --card <id> --canvas <channelId> --forward-to http://localhost:3000 [--secret <s> | --secret <id>=<s> …] [--json]`

1. `POST /v1/relay-sessions`, then prints a banner that says PRODUCTION calls are coming to this terminal.
2. Loops on `GET …/frames?waitSeconds=10`. Each frame is handled concurrently: it is forwarded to `--forward-to` origin + prefix + the frame's own `path`, re-signed per kind, and aborted at `deadlineAt`. Then it `POST …/frames/{id}/response`.
3. Detaches with `DELETE` on Ctrl-C or after 10 minutes with no frame. Exits on 410 without a DELETE. Retries a failed poll with backoff and leaves the lease decision to the server.
