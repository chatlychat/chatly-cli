# @chatlychat/cli — changelog

## 0.5.2 — 2026-10-26

Not yet published.

### Added

- **YAML documents** — `chatly plan` / `apply` (and `platform plan` / `apply`)
  read `.yaml` / `.yml` as well as JSON; `--file -` sniffs the content. Parsed
  strictly (duplicate keys and custom tags are refused, errors carry line and
  column) and validated exactly as JSON is. New runtime dependency: `yaml`.
- **`aiTools` in `chatly plan` / `chatly apply`** — AI tools (`/v1/ai/tools`) are
  a resource, keyed on `name`. `secretHeaders` and `signingSecret` are
  write-only and never diffed.
- **`channels` in `chatly plan` / `chatly apply`** — channels are a resource,
  matched on a new `key` you choose (`^[a-z][a-z0-9-]{0,63}$`, workspace-unique;
  API: `channels.key`, `GET /v1/channels?key=`). Created when absent, updated
  when changed, diffed normally so drift shows. `publicId` is an output, printed
  after `apply`, never an input. Credentials inside `config` (identity
  verification secrets and the like) are write-only per leaf: not diffed, left
  alone unless `--write-only`. `--prune` never deletes a channel (no API-key
  DELETE). `type` is fixed at create. Existing channels have no key: adopt one
  with the new `chatly channels set-key <id> <key>`.
- **`chatly apply` reads back** — after its writes it re-reads the workspace and
  re-plans, exits `1` unless every row matches, and `--json` carries
  `verified` and `mismatches`. `chatly platform apply` already did this.
- **`chatly deliveries list | show | replay <event-id> --bot <id>`** — an
  external agent's delivery log by the `eventId` its endpoint saw; `replay`
  re-sends the original body under the original id. Same routes as
  `bots deliveries | delivery | redeliver`.

## 0.5.1 — 2026-10-25

Not yet published. Bumped in the commit that carries the code, so
`check-unreleased-package-changes` holds; a release is a separate step.

### Added

- **`chatly privacy`** (CHT-X03) — the data-rights executor's five commands.
  `executor-key` is the one that matters: it mints the credential a privacy
  platform registers and answers with the executor URL, the workspace id and
  the secret in one response, because those are the three fields a
  registration form asks for and they otherwise had to be assembled by hand
  from three places. The secret is shown ONCE, and the human-readable output
  says so rather than letting it scroll past; `--json` is exactly the API
  response. Send `X-Secret-Recipient` to receive it sealed instead.

  The key carries exactly `privacy:execute`, which reaches `/v1/privacy/*`
  and nothing else in the product — narrower than the
  `contacts:export` + `contacts:delete` + `contacts:write` an executor needed
  before, each of which also reaches the full-transcript export, the
  irreversible erase or contact merge.

  `lookup`, `request`, `status` and `cancel` round out the surface. They are
  reachable by a privacy platform directly and had no first-party caller at
  all, so an operator could file a request through a platform and had no way
  to check on one by hand.

- **`chatly platform plan` / `chatly platform apply`** (CHT-F04) — the Platform
  API as a file. A `chatly.platform.json` describes workspaces, members,
  workspace API keys, bot credentials and knowledge sources across several
  tenants, against a `cp_` platform credential. `plan` reads only, and reads
  only the tenants the document names. `apply` re-reads afterwards and exits
  `1` unless every row matches — so a write the server accepted and did not
  keep fails the run. A `settings` row per tenant plans its business hours,
  routing and widget-channel config (IDV mode included) against the new
  `GET`/`POST /v1/platform/workspaces/{id}/settings`; all three are merged by
  the server, so they are compared only on the keys the document writes.
  `loginLinks` is refused by name — a link is a mint, not a declaration — and
  the old top-level `widgetChannel` / `businessHours` / `routing` keys point
  at `settings`. A whole `cp_` token in the file's `platform.prefix` guard is
  refused.

- **`chatly init next|remix|astro|express`** (CHT-F02) — scaffolds the
  widget into an existing project from the web channel's own `embed` block:
  the identity route (HMAC, or `--identity atlas` for Next and Remix), the launcher or
  snippet, `chatly.csp.mjs` with a `withChatly()` merge helper, and a
  privacy-policy table of every key the widget stores. Writes nothing if any
  target exists (`--force` to overwrite), never edits the project's own files
  and never writes a secret. No e2e
  fixture is generated because `@chatlychat/widget-testing` is not on npm.

### Fixed

- **A row of a type with no update route planned as "cannot apply" even when
  nothing had changed.** `plan` refused before comparing a single field.
  No workspace-level type was affected (each has an update route or is an
  upsert); every platform type would have been, so a matching tenant could
  never print "everything matches".

## 0.4.1 — 2026-10-16

### Fixed

- **`chatly --version` printed `0.3.0` in 0.4.0.** `run.ts` carries the
  version as a constant and the 0.4.0 bump missed it, so the one string a user
  quotes in a bug report was a release behind. The package's own contract test
  catches this — it reads `package.json` rather than hard-coding the
  expectation, after an earlier release shipped `0.1.0` while the package was
  `0.1.2` — and it caught it here too, in the mirror CI, because the local
  verification run that preceded the release did not include this package.
  `scripts/check-version-constants.mjs` now checks every such constant against
  its manifest, so the next one fails before a publish rather than after.

## 0.4.0 — 2026-10-16

Released because the code below was in the repository and not on npm — the
same drift a customer caught in `@chatlychat/sdk-node`, found here by the gate
that drift produced.

### Added

- **`chatly listen --relay`** — the server half shipped, so the flag now has
  something to talk to. It routes an AI tool call, a customer-card fetch or a
  canvas step for explicitly selected target ids to your terminal and hands
  your answer back to the caller that is still waiting, which the delivery
  ledgers cannot do: a copy of the request that arrives after the visitor has
  been answered is useless.
- Three rules it will not bend, because they are properties of the protocol
  rather than of a service: a frame is never signed (the server holds every
  surface's real secret, and the card and canvas constructions cover
  `<ts>.<body>` with no path, so a production-valid signature in a frame would
  be a replayable credential); no operator-configured header leaves the server;
  and there is no fallback to the configured URL, because falling back would
  run a side-effecting tool call twice.

## 0.3.0 — 2026-10-15

### Added

- **`chatly listen --bot <id>` — the same thing for an external agent's push
  deliveries.** It polls `GET /v1/bots/{id}/deliveries` (the ledger behind
  `chatly bots deliveries`), reads each payload from the per-delivery route,
  and POSTs it to `--forward-to` with the five `x-chatly-*` headers a real
  delivery carries — `x-chatly-event: agent.<kind>`, `x-chatly-bot`
  (`slug ?? id`, as the worker sends it), `x-chatly-attempt`,
  `x-chatly-delivery-id` and the signature. The payload is forwarded as the
  whole body, with no `{id,type,payload}` envelope around it, because that is
  what the external-agent protocol POSTs: wrapping it would make a handler
  that works against this CLI fail against production.
- `--secret` now takes the AGENT's `chsec_` secret in `--bot` mode and
  refuses a `whsec_` one, with the mirror refusal in webhook mode. The two
  surfaces have different secrets from different routes and neither verifies
  the other's traffic; crossing them produces a 401 from your own handler
  that looks exactly like a verifier bug.
- `--status` is validated in `--bot` mode against `pending | delivered |
failed | dead`, because that route answers a **400** on a word outside the
  four rather than an empty page.
- **Every forward now also carries `x-chatly-signature-v2`** —
  `t=<unix seconds>,v1=<hex>` over `<t>.<METHOD>.<path>.<rawBody>`, the
  unified construction from C-02 — beside the surface's legacy header. The
  platform does not send it on either surface yet, which is the point: a
  developer can write and test the verifier they will need before the sender
  moves. `path` is the local `--forward-to` path, because that is the request
  line the receiver verifies. Both headers are checked with the SDK's own
  `verifyChatlySignature` before the request goes out, and a forward whose own
  signature does not verify is refused rather than sent.

- **`chatly listen --relay` — the CLI half of receiving the three
  SYNCHRONOUS surfaces on localhost**: AI tool calls (`--tool <id>`),
  customer-card fetches (`--card <id>`) and canvas steps
  (`--canvas <channelId>`). It attaches a relay session, long-polls for
  calls, forwards each to `--forward-to` with the call's own path appended,
  re-signs it with that surface's construction (`t=…,v1=…` over
  `t.METHOD.path.body` for a tool; `sha256=` over `<ms>.<body>` with
  `x-chatly-timestamp` for a card and `x-chatly-canvas-ts` for a canvas)
  plus `x-chatly-signature-v2`, self-checks each with `verifyChatlySignature`,
  and posts the answer back. Ids are required — there is no form that relays
  everything, because this takes production traffic — and a call for an id
  that was not asked for is refused rather than forwarded. It detaches after
  10 minutes with no call, and on Ctrl-C.
- `--secret <id>=<secret>` (repeatable) for a relay over several targets with
  different secrets. `whsec_` and `chsec_` are refused there: they sign other
  surfaces.
- `--tool`, `--card` and `--canvas` without `--relay` are refused instead of
  being silently ignored by a ledger tail.

### Not done, and why

- **`--relay` has no server yet.** No `/v1/relay-sessions` route exists, so
  today the attach answers 404 and the command says that the server half has
  not shipped and nothing was redirected. The protocol — routes, auth,
  framing, timeouts, the dashboard banner's data source, and teardown when
  the connection dies — is specified in `RELAY-SERVER-SPEC.md` beside this
  file. The CLI half is tested against a scripted server under the real SDK
  transport; that proves what the CLI sends and how it reacts, not that a
  relay works end to end.

## 0.2.0 — 2026-10-14

### Added

- **`chatly listen` — the `stripe listen` equivalent.** Tails this
  workspace's webhook deliveries and POSTs each one to a local URL, so a
  handler can be developed against real events without a public tunnel.
  `--forward-to`, `--secret`, `--endpoint`, `--event`, `--status`, `--replay`,
  `--interval`, `--limit`.
- **It registers nothing on the server**, and that is a constraint rather
  than a preference. `POST /v1/webhooks` accepts a `ck_` key but
  `DELETE /v1/webhooks/{id}` does not — it is the one route on that
  controller with no `@AllowApiKey()` — and there is no key-accessible
  enable/disable either. A CLI that created a temporary subscription could
  therefore never remove it, so it would leak one into the customer's
  workspace on every run. The command tails existing subscriptions instead
  and says so in its banner.
- **The signature it attaches is minted locally, with `--secret`, and the
  command is loud about it.** Chatly signs each delivery from the endpoint's
  secret at send time and stores neither the signature nor the signed bytes —
  `webhook_deliveries.payload` is `jsonb`, which does not preserve key order,
  and the signed envelope's `id` is not the delivery row's `id`. So the
  original bytes are unreconstructable, and what gets forwarded is re-signed
  with the same construction and then **verified with the SDK's own
  `verifyChatlySignature` before it is sent**. If that self-check ever fails
  the forward is refused, because a signer and a verifier drifting on the
  base string or the timestamp unit is a bug this product has shipped before.
- Relaying production's own signature needs a server-side surface that does
  not exist yet: either `GET /v1/webhooks/tail` as SSE, or two columns
  (`signed_body`, `signature`) on `webhook_deliveries` returned from the
  delivery read. `commands/listen.ts`'s header records both shapes.

## 0.1.7 — 2026-10-14

- **Fixes a CLI that could not start.** 0.1.6 installed cleanly and then threw
  on `--version`, because it depends on `@chatlychat/sdk-node@0.3.0` and
  imports `ATTRIBUTION_DIMENSIONS`, which that published version does not
  export. Depends on `@chatlychat/sdk-node@0.3.1` now.
- Found by RUNNING the installed binary. The publish script's probe installed
  it and stopped there, so a broken ESM import graph passed as published —
  the probe now executes the bin.

## 0.1.6 — 2026-10-13

- Installed but did not run; see 0.1.7. Carries workspace-as-code.

## 0.1.5 — 2026-10-13

- Release note: this is the version ON npm. `0.1.6` was accepted by npm and
  never completed — "staged" — so it is unusable and can never be published;
  the next release skips it.

- **`chatly plan` and `chatly apply` actually ship.** Workspace-as-code was
  written, tested and documented in full on the `sdk-cli` docs page, and the
  version on npm answered `Unknown command "plan"`. The code landed without a
  version bump, so the published 0.1.4 tarball contained no `wac/` directory
  at all — the page described a command nobody could run. An integrator found
  it. Nine resource types, `--prune`, and a diff before it writes.
- Test files are no longer shipped to customers. `files` was `["dist", …]`, so
  the 0.1.4 tarball carried `cli.spec.js` and its source map. Now excluded,
  matching the widget packages.

## 0.1.4 — 2026-10-12

- Not installable as documented: see 0.1.5. Published before the
  workspace-as-code commands existed.
