# @chatlychat/cli — changelog

## 0.8.0 — 2026-10-27

- **`chatly login --staff`** (CHT-SI08, ADR 0082) — sign in with the OAuth 2.0
  Device Authorization Grant (RFC 8628) against an Atlas STAFF instance:
  `POST <issuer>/oauth2/device_authorization`, then poll
  `POST <issuer>/oauth2/token` honouring `authorization_pending` and
  `slow_down`. The issuer and client id are never baked in — pass `--issuer`
  and `--client-id` or set `CHATLY_STAFF_ISSUER` / `CHATLY_STAFF_CLIENT_ID`;
  `http://` is accepted for localhost only. The token is stored 0600 under
  `staff` in the config file and is sent only by a command run with `--staff`
  (`chatly api GET /v1/admin/platform-apps --staff`); an absent or expired one
  refuses locally. `chatly logout --staff` removes it and leaves the API key.

  **This entry was written under 0.5.2 on the branch that built it, and 0.5.2
  is published.** Merging carried it into a released section describing a
  feature that version does not contain — the same mis-attribution found in
  `@chatlychat/react-native`'s changelog earlier today, and the reason to read
  the registry rather than this file when the two disagree. Moved here, where
  it ships.

## 0.7.0 — 2026-10-26

- **`chatly api-keys create`** — the automatable step sealed delivery never had. `secret keypair` and `secret open` shipped earlier today and are both scripting tools; the step between them required a browser, because `POST /v1/api-keys` was closed to API keys. It is open now, bounded by the escalation check rather than by the guard (a key cannot confer a scope it does not hold), so the whole flow is scriptable: `chatly api-keys create --name <n> --scope <s> --recipient x25519:<publicKey>` returns a sealed blob and no plaintext. Repeatable `--scope`, or `--scope a,b`. The minting key needs `workspace:write` plus every scope it confers, so the first key in a workspace still comes from the dashboard.
- Exits 1 rather than 0 if a mint returns neither a token nor a sealed secret — unreachable today, but reporting success for a live credential nobody can use is the failure this mechanism exists to prevent.

## 0.6.0 — 2026-10-26

### Added

- **`chatly secret keypair` and `chatly secret open`** — the half of sealed
  credential delivery that had never shipped.

  `POST /v1/api-keys` and the other shown-once minters accept
  `X-Secret-Recipient: x25519:<base64>` and answer with `token: null` plus a
  `sealedSecret` only the holder of the private key can open. The format is
  documented down to the byte layout. **Nothing that shipped could open one**
  — a sweep of all eleven published packages and this CLI found exactly one
  mention outside the server, a line that PRINTS the blob. So the documented
  safe path ended in "now implement HKDF-SHA256 over X25519 and
  ChaCha20-Poly1305 yourself", and the practical advice an integrator got was
  to paste a live key into a message, which is the thing the mechanism exists
  to prevent.

  Both subcommands need **no credential**, and that is the point rather than a
  convenience: the person opening the blob is the integrator, who does not
  have a key yet because opening it is how they get one. Found by running the
  built binary — `resolveCredentials` throws before dispatch for everything in
  `COMMANDS`, so the first real invocation answered "No API key" while every
  unit test passed.

  `--key-file` is documented ahead of `--key` because a PEM on a command line
  is in the shell history of whoever ran it.

  The derivation is restated here because `@livechat/shared` is `private: true`
  and this package is published. `secret.spec.ts` seals with the REAL
  `sealSecret` and asserts this opens it — a round trip against our own opener
  would agree with any derivation, including a wrong one. That spec also
  covers a property the shared module's own docblock says it cannot test: a
  mutation to the HKDF `info` changes the Diffie-Hellman output too, so one
  implementation cannot separate the two effects, but two independent ones can.
  Verified by dropping both public keys from the `info`, which leaves the
  shared package's 20 specs green and turns 2 of these 6 red.

## 0.5.4 — 2026-10-26

**Byte-identical to 0.5.3 in behaviour.** Released so the repository and the
registry can be shown to agree.

0.5.3's first publish failed on `npm test` — `run.ts` still said
`VERSION = '0.5.2'` — so the constant was fixed in a LATER commit and the tag
re-cut. The artifact on npm is correct and contains the fix. But
`check-unreleased-package-changes.mjs` compares a package's files against the
commit that SET its version, and for 0.5.3 those were two different commits,
so it reported `run.ts` as an unreleased change for ever. It was right about
what it can see: nothing in the repository records that the re-cut tag is what
shipped.

The gate's model is that a version bump and its publish are one commit. That
is worth keeping — it is what makes "these changes cannot reach anyone"
checkable at all — so the answer is a release that satisfies it rather than an
exemption that hollows it out. Bump the constant and the manifest together,
in one commit, and this does not recur.

## 0.5.3 — 2026-10-26

**Published with npm provenance.** No code change.

`0.5.2` went out without an attestation — `npm view @chatlychat/cli
dist.attestations` was empty — while `core`, `world`, `react-native` and
`blocks` were all attested. An integrator who runs
`npx @chatlychat/cli@… plan/apply` against production with a workspace key
spotted it, and they were right to: of every package here, the one that
executes against a live workspace is the one most worth verifying.

The cause was the release path rather than a setting. Provenance requires a
CI publish, and this repository is private and out of Actions minutes, so
attested releases go out from the PUBLIC mirror's `publish.yml` on a tag
(ADR 0057). The CLI's mirror has had that workflow all along; 0.5.2 was
published from the maintainer's machine with `publish-packages.mjs`, which
cannot sign. An already-published version's attestations cannot be added
afterwards, so the fix is a release rather than a repair.

Its 0.5.2 entry said "Not yet published." That was wrong at the moment it was
written and stayed wrong after the publish; the version was live on the
registry the whole time.

## 0.5.2 — 2026-10-26

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

## 0.5.2 — 2026-10-26

Not yet published. Bumped in the commit that carries the code, so
`check-unreleased-package-changes` holds; a release is a separate step.

### Added

## 0.5.1 — 2026-10-25

Published, without provenance — see 0.5.3. This entry said "Not yet
published", which was true when it was written and was never updated when the
release happened; the registry has had it since 2026-10-25. Two consecutive
entries claiming that is why 0.5.3's note says to read the registry rather
than this file.

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
