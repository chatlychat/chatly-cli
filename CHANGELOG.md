# @chatlychat/cli — changelog

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
