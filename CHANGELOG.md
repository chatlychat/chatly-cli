# @chatlychat/cli — changelog

## 0.13.0 — 2026-11-13

- **`chatly init next` and `init remix` write the CSP variant they actually
  scaffold** (CH-13). Both generate `<ChatlyLauncher>` from
  `@chatlychat/widget-react` — a package install that runs no inline script —
  and both wrote `chatly.csp.mjs` with the inline snippet's four
  `'sha256-…'` sources in `script-src`, plus a comment telling the reader to
  find a nonce or a hash for an inline script the scaffold never emits. The
  integrator who reported CH-13 ran `chatly init next` and ended on
  `'unsafe-inline'`, which re-admits every inline script on their own page.
  `init astro` and `init express` do paste the snippet, so they keep the
  hashes — without them a browser refuses the snippet and there is no widget
  at all.

- **The refresh command the generated file prints now reproduces the file**
  (CH-13). It read `chatly csp --format next > chatly.csp.mjs` whatever the
  variant, and `--format next` defaults to `--install snippet` — so the
  documented refresh of a hash-free module put the hashes back. A build step
  that silently changes the policy is worse than no build step. A react
  module now prints `chatly csp --install react > chatly.csp.mjs`.

- **The generated react module says what `'strict-dynamic'` does to it.** Under
  Next's own recommended `script-src`, the browser ignores every host source —
  `'self'` and the widget host `withChatly` appends included — and reaches the
  loader through the nonce chain instead. Without that line the reader debugs a
  missing widget by adding hosts to `script-src`, which cannot help.

- **`chatly doctor --origin` no longer fails a correct `'strict-dynamic'`
  policy, and no longer prints advice that cannot work.** `csp.site` compared
  every published `script-src` host against the page's policy without noticing
  the keyword — which makes the browser ignore host sources and `'self'` in
  that directive entirely — so a Next app that had correctly dropped the
  redundant widget host was told its policy was broken, and told to add the
  host back. Measured before the fix: that policy returned
  `[{"directive":"script-src","source":"https://widget.chatlychat.com"}]`. It
  was the one false FAILURE left in a check whose own header says every
  simplification errs towards PASS, because a false failure is how a command
  stops being believed.

  **`script-src` only**, including through a `default-src` fallback, because
  that is what a browser does. `connect-src`, `img-src` and `media-src` are
  untouched by the keyword and are still compared — absolving those would
  blind the half of this check that found a real integrator's missing upload
  host on 2026-11-03. The pass line now names the half it cannot verify: a
  nonce that never reaches the widget is a broken page this check cannot see
  from outside, and a bare `pass` would read as "the policy is fine".

- No behaviour change to `chatly csp`'s flags. `hostsOnly` moved into
  `init/shared.ts` so the command and the scaffold filter with one function
  rather than two.

## 0.12.0 — 2026-11-13

A **minor**, and most of it is the 2026-11-13 FormFlow round, which was
written and never released: they rechecked against 0.11.1 and found every item
open, because 0.11.1 is where the code was not. Read the exit-code change
first — it is the one that can turn a green pipeline red, and that is the
point of it.

- **`chatly plan` exits 3 for a document the server will refuse, with no
  `--exit-code`** (CH-16). It printed the refusal, named the field, listed the
  key under `refused` — and exited 0, so a deploy gate that runs `chatly plan`
  reported success over a file the API answers 400 for. A refusal is not
  drift: it is this CLI predicting a rejection, and `--exit-code` exists to
  opt into DRIFT reporting, not into being told the file is broken. `unhealthy`
  (CH-05) already worked this way and the argument is the same one — a gate
  that has to be opted into is a gate that was off on the day it mattered.
  A BLOCKED row is unchanged: 3 with `--exit-code`, 1 without.

- **A typo one level down is caught before `apply` sends it** (CH-16). The
  enum table was keyed by top-level field name and read against that field's
  own value, so `config` being an object hid every closed set inside it:
  `identityVerification.tokenProvider: "atlsa"` planned as a clean change.
  `nestedEnums` is keyed by dotted path, generated from the served OpenAPI
  document, enums only and only where no `anyOf`/`oneOf`/`allOf` sits anywhere
  on the path — 33 paths on `PATCH /v1/channels/{}` alone. The warning names
  the full path, the value and the accepted set.

- **`members:` in `chatly.yaml`** (CH-08). Natural key `email`, matched
  case-insensitively against `GET /v1/invites?status=all` — the INVITATION
  list, not the member list, because a member row does not exist until the
  person accepts and matching on members would re-invite (and re-email) every
  teammate on every deploy. A changed `role` plans as `blocked` rather than as
  a write: `PATCH /v1/memberships/{id}/role` takes no API key. `--prune` never
  removes anybody. **This needs the matching API build**: until
  `POST /v1/invites` accepts a flat entry beside the batch, a `members:`
  section answers 400 with `invites: Required`.

- **`chatly csp [--format next|header|json] [--install react]`** (CH-13). The
  refresh command `chatly init` never had: `chatly csp --format next >
chatly.csp.mjs` in `prebuild` and the policy cannot go stale. `--format
header` emits DIRECTIVES to merge, never a whole header — two
  `Content-Security-Policy` headers intersect rather than extend, so a second
  one blocks the host's own scripts. `--install react` drops the
  `'sha256-…'` sources, which are hashes of the inline embed snippet that a
  `@chatlychat/widget-react` or `<chatly-widget>` install never runs: an
  integrator reading hashes in a policy their widget appears to violate
  reaches for `'unsafe-inline'`, which is a real weakening caused by a list
  describing a different install. The default KEEPS them, because an unmatched
  hash is inert while a missing one blocks the snippet outright.

- **The generated `chatly.csp.mjs` names its own refresh command.** It said
  "Re-run `chatly init`", and `init` never overwrites a file it has written —
  so the one sentence in it about staying current pointed at a dead end. It
  now says `chatly csp --format next > chatly.csp.mjs`.

- **`chatly plan` exits 3 over a knowledge source that failed its last sync**
  (CH-05), whether or not `--exit-code` was passed, and `apply` no longer
  prints `Read back: everything matches the document.` while one is failing.
  A plan can be entirely `=` and still be bad news.

- **`chatly whoami --for plan|apply|doctor`** (CH-17) names the EXACT scope a
  command is missing, from one read of the credential's own `whoami` — it
  never probes a write. Scope implication is honoured (`kb:write` covers
  `kb:write:sources`), and a key expiring inside 60 days is called out, which
  the server's own `key_expiry` check does not do.

## 0.11.1 — 2026-11-12

A **patch**: one wrong warning, and a file that was never in the tarball.

- **`wac plan` stopped calling every healthy docs source stale** (CH-31). The
  conditional skipped `syncStatus === 'ok'`, and `ok` is not a member of the
  API's enum — the values are `queued`, `synced`, `synced_empty`,
  `synced_partial`, `failed` and `paused`. So a source reading `synced`, which
  is the normal healthy state, fell through to "its articles may be stale or
  missing". The test fixture used `'ok'`, which is why a suite that had a
  `is silent on a healthy source` case passed against the bug for its whole
  life; the fixture is now a value the server can actually send, and the four
  statuses nobody had graded each have a case. `queued` and `paused` get
  accurate sentences of their own rather than the stale-or-missing one.

- **`CHANGELOG.md` is in the published tarball** (CH-33). `npm pack` shipped
  `dist`, `README.md`, `LICENSE` and `package.json`, so the one file that says
  what changed between two versions was readable on GitHub and nowhere a
  consumer installs from. Four of the eleven published packages were in that
  state — this one, `@chatlychat/mcp`, the React Native SDK and
  `@chatlychat/widget-testing` — and `check-sibling-peer-ranges.mjs` now fails
  the build on a package whose `files` omits it.

## 0.11.0 — 2026-11-12

A **minor**: `chatly atlas-verify` is the half of the Atlas event-receiver
story that a customer can run, and the server grew a route beside it.

- **`GET /v1/atlas-receiver/fingerprint` exists** for the comparison this CLI
  cannot make for you (CH-28). It publishes the first eight hex characters of
  `sha256(eventsSecret)`, so the value Chatly stored can be compared with the
  one Atlas's dashboard shows without either side being read. `atlas-verify`
  deliberately does not call it: that command HOLDS the secret in order to
  sign with it, so it can compute the same eight characters locally, and a
  request would be a round trip for a value already in the process.
- **Atlas on your own domain now receives events at all.** A path-mounted
  Atlas (`https://example.com/atlas`) writes its instance id nowhere, so every
  arm of the receiver's resolver matched nothing and every delivery was
  refused with a 401 before a secret was read — `candidates=0`, 126 times
  running for one customer. Migration 0708 adds a last-resort candidate set.
  Nothing in this package changed for it; `doctor` reads the server's
  `atlas.receiver` verdict as it already did.

## 0.10.10 — 2026-11-08

ForgeDeck's follow-up to the fourteenth report's item 1, after the server
half shipped as a clean 400: `plan` did not predict it, so the only way to
find out that a macro cannot move to team scope was to run `apply`.

- **`plan` now warns before a macro is moved to `scope: "team"` with no
  team.** It has everything needed to say so: the live macro is already read
  and `teamId` is `nullable()` on the response schema, so one with no team
  reads back as `null`. It refuses the row rather than warning, because the
  write really will be refused.
- **The second door is covered too** — `teamId: null` with no `scope` on a
  macro that is already team-scoped — mirroring the one guard the service
  needed for both.
- **`scope: "team"` on a macro that already HAS a team stays silent.** The
  service writes `body.teamId ?? stored.teamId`, so that patch is legitimate,
  and a refusal there is the false-refusal shape that cost the eighth report
  a run on a valid file. It is the case that made this rule look create-only.

  0.10.7 shipped it create-only on the argument that `POST /v1/macros` carries
  `.refine(scope !== 'team' || teamId)` and the PATCH schema does not. That
  read the wrong file: `macros.service.ts` enforces the pair itself, against
  the row it reads back from the database. Whether a rule is create-only is
  decided by what the SERVER does with an omitted field, not by which schema
  carries the refine.

## 0.10.9 — 2026-11-08

ForgeDeck's fourteenth report. The CLI half is their item 4: both halves of
it are 0.10.7's own fix being wrong at its edges, and both are the same
mistake — a rule that knew the row was an UPDATE was applied to creates too.

- **A preset `aiTools` row being CREATED is no longer told to delete what it
  needs.** `preset` and `url` are required by the preset arm of
  `POST /v1/ai/tools`, and every new row was getting `` `preset` is an install
INSTRUCTION… Remove it from the document. `` Following that advice leaves an
  invalid custom tool with no `urlTemplate` and no `parameters`. Advice that
  is wrong is worse than silence, because somebody acts on it.
- **A `url` change on an INSTALLED preset now says what happens to it.**
  Excluding `url` from the comparison is still right — it reads back as
  `urlTemplate` — but the consequence was that changing the endpoint gave
  `= unchanged` and `plan=0` while the old endpoint went on being called,
  with nothing saying so. The warning now states it is not applied and names
  `urlTemplate`, which the PATCH does accept.
- **The generic "Remove it from the document." suffix is gone.** What to do
  about a discarded field depends on the field, so each reason carries its
  own advice. A Chatly bot's `webhookUrl` still says to remove it or set
  `type: "external"`, and still warns on the create — there the route really
  does accept the field and throw it away, which is the asymmetry with the
  preset case.

Server-side in the same sweep, deployed with the API rather than this
package: a macro patched to `scope: "team"` with no team, a brand slug
conflict on create or rename, recreating a deleted brand's slug, and a
customer-card `key` conflict on update ALL answered 500 — which this CLI
reads as transient and retried three times. All four are 4xx now.

## 0.10.8 — 2026-11-07

**0.10.7's item-4 fix was live for one `plan` and then stopped.** A Chatly bot
carrying `webhookUrl`, `timeoutSeconds` or `fallbackMessage` still never
settled: the warnings showed on the first run and never again.

`typeof null === 'object'`. The rule proved "this bot is external" with
`typeof live?.['externalAgent'] === 'object'`, and `toBotView` answers
`externalAgent: null` for a Chatly bot — so every bot that already existed was
read as an external agent, the fields were never excluded from the comparison,
and the row went on being written on every run. A create has no live row to
misread, which is why the first `plan` looked right.

It uses `asRecord` now, the test the rest of this package already uses, moved
to `resource-shared.ts` so there is one copy with the reason on it.

Reported by ForgeDeck. Nothing here could have caught it: `LIVE_BOT` in
`wac-report13.spec.ts` OMITTED the key rather than carrying production's
`null`, so 21 tests agreed with the bug — the second fixture in that one
session to invent a shape the server does not send.

## 0.10.7 — 2026-11-07

ForgeDeck's thirteenth report: five plan defects, four of them one cause.

Every check in `field-rules-checks.ts` reads ONE field against the route's
declared rules for that field, and the rules these rows broke are about a
PAIR — which no generated table can hold, because the OpenAPI document does
not state them. They are hand-written now, in `resource-conditionals.ts`.

- **A preset AI tool row now settles.** `preset` and `url` are an install
  instruction, not columns: the route expands them into `name`,
  `description`, `parameters` and `endpointUrl` and the read carries neither
  field back. So `plan` showed `preset: (unset) -> …` and `url: (unset) -> …`
  on every run and `apply` wrote on every run — for ever. Both are left out
  of the comparison on an update (and still SENT on the create that needs
  them), with a line saying so.
- **And a preset row keyed as anything but the preset's tool name is
  refused.** The preset arm ignores `name`, so a row keyed `fd_t5` with
  `preset: order_lookup` created a tool called `order_lookup`, `fd_t5` never
  appeared on the server, and the next `apply` hit the duplicate-name
  failure below.
- **An update row is checked against the UPDATE route's rules.** `rulesFor`
  returned the POST route's for both, and on `POST /v1/bots` — a union body
  — `systemPrompt`'s `minLength` lives inside the arms, not the merged
  table. A bot update to `systemPrompt: "short"` planned clean and `apply`
  answered `String must contain at least 20 character(s)`. The generated
  table had `'PATCH /v1/bots/{}': systemPrompt: { min: 20, max: 20000 }` the
  whole time and nothing read it. Resolved PER FIELD, because an update
  row's fields do not all go to one route.
- **A Chatly bot carrying `webhookUrl` now settles.** It is an external
  agent's delivery config: the chatly arm of `POST /v1/bots` discards it and
  the read emits no `externalAgent`, so the row never closed. Warned and
  left out of the comparison, along with `timeoutSeconds` and
  `fallbackMessage`. An external bot is unaffected — proven by `type` and,
  independently, by `externalAgent` on the read, because the failure
  directions are not symmetric.
- **Two conditional requirements are predicted:** a macro with
  `scope: "team"` and no `teamId`, and a `referral_answers` install with no
  `signingSecret`. Both are create-only, because both PATCH schemas
  deliberately omit the refine.
- **One warning for one mistake.** `name: ""` on a macro printed two lines —
  required-and-empty, then must-hold-at-least-1-character. The required one
  names the fix, so the length rule yields to it.
- Server-side, in the same sweep: `POST /v1/ai/tools` answered **500** for a
  tool name that already exists, which this CLI read as transient and
  retried three times. It is a **409** naming `name` now, on create and on a
  rename. Deployed with the API, not with this package.

## 0.10.6 — 2026-11-07

0.10.5 is **deprecated and uninstallable** — do not use it. Its published
`package.json` carried `"@chatlychat/sdk-node": "workspace:*"`, which npm
cannot resolve, so `npm install @chatlychat/cli@0.10.5` fails with
`EUNSUPPORTEDPROTOCOL`. The cause was publishing with `npm publish` instead of
`node scripts/publish-packages.mjs --apply`: `pnpm publish` rewrites the
workspace protocol to the real version and `npm publish` does not. Same
content, same fixes, installable.

## 0.10.5 — 2026-11-07

- **A union arm's ITEM enum is carried and checked.** The merged `itemEnums`
  map records a field only where every arm declares it, so an array one arm
  closes to a set and another leaves open merged to nothing at all and a bad
  member matched that arm. No route in today's document is in that state —
  every arm's map is empty — so this changes no plan output yet; it exists so
  the check lands before the route does rather than after.
- Server-side, in the same sweep: `POST /v1/bot-evals` and
  `POST /v1/bot-evals/{id}/runs` answered **500** for an API key with no
  machine user, the same defect as `POST /v1/macros` in 0.10.4 and the same
  cause. Both create with no author now. Deployed with the API, not with this
  package.

## 0.10.4 — 2026-11-07

ForgeDeck's twelfth report: four field-rule and plan defects.

- **A union arm the row FILLS but its own value rules out counted as matched**,
  so the whole warning went silent. `bots` with `type: 'external'` and a
  chatly-shaped body planned clean and `apply` answered `webhookUrl: Required;
type: Invalid literal value, expected "chatly"`. An arm now matches only when
  nothing is outstanding, enum misses included; the "wrong arm" narrowing is
  limited to single-value enums (a discriminator) so a bad `preset` still shows
  the preset arm.
- **`minLength`, `maxLength` and `pattern` are read out of the document**, per
  field and per arm. `systemPrompt: 'Be nice'` (the route wants 20+) and a tool
  named `fd-tool2` (the arm's pattern allows `_` and `.`) both planned clean
  before this.
- **A reference to a type the document does not declare resolves against the
  server.** A `botRoutes`-only file blocked every row with "names bots/x, which
  is neither on the server nor created by this plan" while the bot was right
  there. One extra GET per referenced type, only when the document does not
  declare it.
- Server-side, in the same report: `POST /v1/macros` answered **500** for an API
  key with no machine user and the CLI retried it three times. It now creates
  the macro with no author, or answers a 4xx naming the way out for
  `scope: "personal"`. Deployed with the API, not with this package.

## 0.10.3 — 2026-11-07

ForgeDeck's eleventh report: one P2 and two P3s, all closed. Their four items
from 0.10.2 stay closed.

- **A row that matches NO shape of a union route is caught in `plan`.**
  `bots: [{ slug, name }]` planned clean and exited 2; `apply` then answered
  "this route accepts 2 shapes and the body matched none of them". The field
  rules read ACROSS the arms of a `oneOf` body — `allowed` is their union,
  `required` their intersection, and a type is kept only where every arm
  agrees — and not one of those readings can express the rule the server
  enforces: a body has to satisfy one WHOLE arm. `POST /v1/bots` reduced to
  `required: ['name']`, the single field both shapes share.

  The generated table now records each arm on its own, and `plan` asks the
  server's question. Where the row's own values pick an arm out — `type:
'external'` leaves exactly one standing — only that arm's missing field is
  named; where nothing discriminates, every shape is described.

  This also closes `POST /v1/ai/tools`, which is the same defect with **no
  discriminator at all** and would have survived a `type`-based fix: its
  failure is a per-arm TYPE error, because `parameters` is an array in one arm
  and undeclared in the other, so the merged table had no type for it and an
  object passed.

- **`Quote it.` is no longer advised for a field with a closed set of values.**
  `scope: 5` on a macro wants a string and has a number, so the advice fired —
  and `"5"` is refused too, by the enum, so following it produced a second
  plan that failed for a different reason. The allowed values are printed in
  its place. `name: 5`, where any string is accepted, still says `Quote it.`

- **`is not one the values` reads `is not one of the values`.** The plural form
  was already right.

## 0.10.2 — 2026-11-07

ForgeDeck's tenth report: four P2s, all closed. Their nine earlier items stay
closed and good documents on every resource plan and settle without a false
alarm.

- **A bad value INSIDE an array is caught.** A webhook document with
  `eventTypes: ["conversation.nope"]` planned clean, exited 2, and `apply`
  answered `eventTypes.0: Invalid enum value`. The enum check compared a
  field's own value, and an array is never one of the members — so the
  generated table now records an array's ITEM enum separately, and every bad
  item is named with its index, the way the server names it.
- **`Quote it.` only where quoting is the fix.** It was appended whenever the
  message contained `a number` or `a boolean`, and that message names both
  the type the document has AND the type the route wants — so it fired on
  three documents where quoting is the mistake: `enabled: "yes"` (already
  quoted; the quoting is the bug), `ttlSeconds: 1.5` (`"1.5"` is refused too)
  and `eventTypes: 5`. The advice now comes from the types, and a fraction
  where a whole number belongs is told to round rather than quote.
- **One warning per privacy mistake.** The generic table check started
  running on every resource while `privacyPartners` kept its own, so each
  line printed twice. The resource's copy is the one kept, because it is
  worded by whether the row is SENT — on an unchanged pair it says the value
  is not sent on this run, where the generic one would claim a refusal that
  never happens.
- **A blocked row's reason prints once during `apply`.** `apply` writes the
  whole plan before it writes a row, so a blocked row's detail was already on
  screen directly above. A row skipped because a DEPENDENCY failed still
  prints its detail — that one is new information no plan could have had.

## 0.10.1 — 2026-11-06

**0.10.0 is uninstallable — use this.** Its published manifest carries
`"@chatlychat/sdk-node": "workspace:*"`, so every `npm install
@chatlychat/cli@0.10.0` fails with `EUNSUPPORTEDPROTOCOL`, including the one
in the package's own README. No code difference: 0.10.1 is 0.10.0 published
through `scripts/publish-packages.mjs`, which packs with pnpm so the
workspace range is rewritten to a real version.

`npm publish` run by hand does not do that rewrite and exits 0, and `npm view`
then shows a healthy package. The repo had a gate for exactly this and it read
`packages/*` only, so the one publishable thing in `apps/` was outside its
scope; it covers both directories now.

## 0.10.0 — 2026-11-06

ForgeDeck's ninth report: 1 P1 and 5 P2s. `plan` now predicts what the route
will refuse for every resource, and two of these were overclaims in 0.9.9's
own help text and changelog.

- **A valid `botRoutes` document no longer exits 3 as REFUSED.** (P1) The
  route requires `botId`; the document writes `bot: '<slug>'` and the CLI
  resolves it at send time, so the requirement was met and the check looked in
  the wrong place. A pipeline gating on 3 stopped on a good file. The warning
  also told the author to set `botId` — the environment-pinned uuid the
  reference exists to keep out of the document — and now names `bot`.
- **Wrong JSON types and bad enum values are caught on all twelve
  resources.** 0.9.9's help text claimed this and only `privacyPartners` had
  it. The generated table carries each field's declared type and enum now. A
  whole number is reported as a `number`, never an `integer`, because that is
  the vocabulary the author wrote in and what the server's own message says.
  A field whose shape varies between union arms gets no type at all, rather
  than a guess that would refuse a good document.
- **An unknown field no longer makes `apply` write for ever.** A macro
  carrying a misspelt field applied, then the read-back said the row still
  differed, `apply` exited 1, and every later run wrote again. A dropped field
  can never read back, so it is out of the diff; the warning says the field
  never takes effect and that a rerun settles.
- **A strict route's unknown field is a refusal, not advice.** `POST
/v1/customer-cards` refuses the whole body, and the CLI called the field
  "silently DROPPED". The OpenAPI document could not express the difference
  until today — see the API note below.
- **One warning per misspelt field**, not two. The live-row heuristic now runs
  only where the route's own rules are unknown; it also asserted that "zod
  STRIPS an unknown key", which is false for 175 schemas in this API.
- **`--exit-code` answers 3 for a row that cannot be applied.** `--help` says
  `3 = will not apply`; a blocked row is one the CLI will not send, and it
  answered 2 — the code a good change exits. `--json` carries a separate
  `blocked` list; those keys are deliberately NOT merged into `refused`,
  because two count sites rely on a row never being in both.
- **`chatly platform plan --exit-code` gained its 3 arm**, which it never had
  for either a refused or a blocked row while `--help` documented it.
- **The `completionSecret: null` warning is worded by whether the row is
  sent** — the third warning in that file to need it.
- **The dead `chatly docs <type>` pointer is gone**, replaced by the list of
  fields the route accepts.

Needs the API change shipped in the same release: the OpenAPI document now
states whether a route refuses an undeclared key, which also means every union
body names the fields each of its shapes wanted instead of answering `Invalid
input`.

## 0.9.9 — 2026-11-06

- **`--exit-code` now says what 3 predicts and what it cannot.** 0.9.8 made
  `plan` check required, wrong-type and unknown fields for all twelve resource
  types, which closes most of the gap — but a rule spanning two fields is not
  something a route DECLARES, so `plan` cannot derive it. A macro needing
  'body' or 'actions' is the live example: only `apply` catches that one.
  ForgeDeck's eighth report asked for the check or the documented limit,
  because "a pipeline gating on exit 3 needs to know which of these it's
  getting"; this is the half of that answer the generated table cannot give.
  Also states that a misspelt field is NAMED but is not a refusal, since the
  server drops it and the write succeeds.

## 0.9.8 — 2026-11-06

ForgeDeck's eighth report. `plan` now answers for every resource, not just
`privacyPartners`.

- **Required fields are checked on all twelve resource types.** A macro with
  no `scope` planned as a clean `create` and exited 2, then `apply` answered
  `scope: Required`. One resource of twelve declared its required fields. The
  lists are no longer hand-written: `scripts/gen-wac-field-rules.mjs` derives
  them from the served OpenAPI document, which is what the routes are built
  from. Only on rows `plan` would CREATE — a PATCH body is partial, so an
  absent field there means "leave as stored".
- **A field name the route does not have is named.** A macro written with
  `content` instead of `body` applied "successfully" with the text silently
  dropped, because a non-strict zod object strips unknown keys. `plan` now
  says the field is not on the resource and will be DROPPED rather than
  refused — and does not count it as a refusal, because the write succeeds.
- **`Run chatly apply to make N change(s)` no longer counts refused rows.** A
  mixed document said `2 change(s)` directly above `1 document(s) will be
REFUSED`.
- **The wrong-type warning is worded by whether the row is sent.** It said
  "the write will be refused" on an unchanged row, which is the mismatch 0.9.7
  fixed for the stray-secret message one branch below it.
- **A `completionSecret: null` beside a `completionsUrl` is flagged.** The
  route resolves an explicit `null` over a stored secret and then refuses the
  pair, so this is refused even when a secret is already stored.
- **`apply` no longer mentions rows that were written when none were.** 0.9.7
  replaced a false all-clear with "the rows that were written match the
  document"; on a run where every row fails, that was itself a claim about
  rows that do not exist.

## 0.9.7 — 2026-11-06

ForgeDeck's seventh report. Both items are `plan` and `apply` describing what
they actually did.

- **A wrong JSON type is caught by `plan`, not by `apply`.** `completionsUrl: 5`
  (or `true`, `[]`, `{}`) and `completionSecret: 5` planned with no warning,
  `0 that cannot be applied` and exit 2; `apply` then exited 1 with `Expected
string, received number`. Only `cbid` was type-checked — the other two
  guarded with `typeof x === 'string'`, which skips a wrong type instead of
  reporting it. All three now warn and exit 3, naming the type the way the
  route does (an array is `array`, not `object`). `completionsUrl: null`
  remains the documented off switch and stays silent.
- **A stray `completionSecret` on an unchanged row no longer claims the server
  refused it.** Nothing is sent on that run, so there is no refusal; it now
  reads `this secret is not sent — there is no completionsUrl for it to sign`.
  Under `--write-only` the secret IS sent and the server does refuse it, and
  that wording is unchanged.
- **`apply` no longer reports an all-clear read-back after a failed write.** It
  printed `Failed (1) — nothing was written for these` and then `Read back:
everything matches the document.`, because the read-back re-plans without
  `--write-only` and so cannot see a credential that failed to be written. It
  now says the failed rows are NOT confirmed, and `--json` reports
  `verified: false`. Fixed for `chatly platform apply` too, which had the same
  two lines and was not reported.

## 0.9.6 — 2026-11-06

ForgeDeck's sixth report. All three are `plan` telling the truth about what
`apply` will do.

- **`plan` no longer says `REFUSED` about a document `apply` accepts.** A
  document carrying a `completionSecret` and no `completionsUrl`, against a
  partner whose completions are already off, plans as `unchanged` — a secret
  is a credential and is kept out of the diff — so `apply` sends nothing and
  exits 0. `plan` printed `1 document(s) will be REFUSED` and exited 3, and a
  pipeline gating on 3 stopped for a change that was ready. Only a row that
  `apply` would actually send can be refused now. The warning about the stray
  secret stays, because a secret with nowhere to report is still worth saying.
- **An empty `completionsUrl` is flagged.** `completionsUrl: ""` planned with
  no warning and exited 2, then `apply` failed with `completionsUrl: Invalid
url`. It is now refused with the same message as any other bad URL.
  `completionsUrl: null` remains the documented way to switch completions off
  and is still silent.
- **The summary counts refused documents, and `--json` lists them.** The same
  output used to say `1 to create` and `0 that cannot be applied`; the count
  now includes them, the `Run chatly apply` line is dropped when every change
  in the plan is refused, and `refused` is a top-level array in
  `plan --json` so a script no longer has to parse prose out of `warnings`.

## 0.9.5 — 2026-11-06

ForgeDeck's fifth report, items 2 to 4.

- **`plan` and `apply` say when they are rate limited instead of going silent.**
  Both printed zero bytes for 60 to 75 seconds against a throttled API, and
  the underlying transport would have slept for the 809 seconds the server
  advised. The SDK now refuses advice over 30 seconds and hands the error
  back; the CLI prints `… rate limited (server asked for Ns) — waiting Ns,
attempt 2 of 3` to **stderr**, so `--json` output stays parseable.
- **`plan` runs the host rule on a first create.** The server publishes the
  hosts a `completionsUrl` may be on, and `plan` read that list from the rows
  left after the `enabled` filter — so on the very first opt-in, when the only
  row carrying the rule is the unbound one, the list arrived empty and every
  rule keyed on it did nothing. It reads the unfiltered answer now.
- **Four more refusals answered before the write.** A `completionsUrl` that is
  not `https`, a `completionSecret` that is not a `whsec_` secret, a secret
  with no URL and none stored, and a `cbid` that is a number rather than a
  string. Each was a document that planned clean and then failed at `apply`.
- **The secret warning no longer fires on a live pair.** A document setting
  only `completionsUrl` on a partner that already has a secret stored was
  warned about a missing `completionSecret` the server does not need. A
  warning that a working document will fail teaches the reader to ignore
  warnings.
- **The `REPLACES` line was wrong for privacy partners.** `plan` said "every
  field the document omits reverts to its default". For this one resource the
  service keeps what you omit, so someone deleting `completionsUrl` to stop
  reports would have believed it was off while it was still reporting. It now
  says so, and names `completionsUrl: null` as the way to switch it off.

## 0.9.4 — 2026-11-05

ForgeDeck's fourth report, items 2 to 4.

- **`plan` and `apply` no longer promise a one-time secret that cannot exist.**
  Both printed "the create response carries a one-time completionSecret —
  `apply` prints it once and writes it nowhere", and then `apply` printed no
  secret and `--json` showed `"secrets": []`. There has never been one: the
  value is an INPUT the operator holds (the partner's own `whsec_…`) and the
  route answers a boolean `completionSecretSet`. Someone following the line
  waits for a secret that never comes, or concludes they lost it. The
  `completionSecret` entry in `secrets` drove that banner while its own
  docblock claimed it was "DEFENSIVE and inert". Nothing replaces the line: the
  `opaque` entry already prints the true version, "sent on this create and
  never readable afterwards".
- **`plan` now flags what the server will refuse, instead of planning it.** A
  missing `cbid`, an empty one, and a `completionsUrl` on a host the provider
  does not allow each planned as `create` and exited 0, and `apply` then failed
  with the real reason. `plan` exists to answer that before anything is
  written, and every one of those facts was in the document.
- **`plan` warns on a `completionsUrl` with no `completionSecret`**, which the
  API now refuses outright (it used to answer 200 and discard the URL, so every
  rerun reported a difference it would not explain).
- The completions host check reads `completionHostSuffixes`, a field the list
  route now returns, so it is a CHECK rather than a second copy of the server's
  rule — a registry that gains a host needs no CLI release. An older server
  that does not publish the field produces no host warnings at all, because an
  empty list is no evidence.

## 0.9.3 — 2026-11-05

- **`chatly apply` could not create a privacy-partner opt-in, which was the
  entire job of the resource 0.9.2 added.** The create arm sent the natural key
  in the body; `PUT /v1/privacy/partners/{provider}` validates with a `.strict()`
  body, so every FIRST opt-in was a 400 — and only the first, since the update
  arm had always dropped the key. This is the only resource with a `PUT` create,
  so no other one could expose it. A document that already held an enabled
  partner applied fine, which is why it survived a release.
- **`chatly plan` now warns on a provider the server does not list**, instead of
  planning a create that answers `404 Privacy partner not found`. `GET
/v1/privacy/partners` returns the whole registry, so an unlisted provider is
  not a guess — the plan had the evidence in hand and said yes anyway.
- **`chatly apply` now prints WHY a write was refused.** It reported only
  `Invalid request body`; it now reads `details.issues[].path` / `.message` off
  the error body and names the field, reading `keys` for an `unrecognized_keys`
  issue whose `path` is empty and would otherwise name nothing.
- **The platform document refuses workspace resource types by name.** All twelve
  of them, derived from `RESOURCE_TYPES` rather than listed, with a message
  pointing at `chatly plan` / `chatly apply` and a `ck_` key.

## 0.9.2 — 2026-11-05

- **`chatly doctor` now prints the workspace readiness report.** The code
  (`doctor-readiness.ts`, commit 65bd0585) shipped in the repository but was
  never released.
- **`chatly plan` / `apply` now manage the data-rights opt-in.** A new
  `privacyPartners` resource, keyed on the provider, so a privacy integration
  can live in the same document as the channels and bots instead of being the
  one piece that needed a hand-written `curl`. Three things about it are
  unlike every other resource and are documented beside it: the list route
  enumerates the whole provider registry rather than what exists (so a
  `--prune` would otherwise offer to delete every provider you did not name),
  create and update are one `PUT`, and `completionSecret` never reads back —
  a plan says it cannot tell whether that field changed rather than rewriting
  it every run.
- **A wrong-kind key no longer gets "the key was rejected".** When a 401 carries
  `details.reason: "wrong_credential_type"` (for example a `cp_` platform key
  sent to a workspace route) the key is fine; the server's own message names the
  route to use, and the `chatly whoami` / `chatly login` hint sent people to
  re-check a key that was never the problem. Ordinary 401s keep the hint.

## 0.9.1 — 2026-11-04

- **`chatly doctor --origin <site>` now reads that site's own
  Content-Security-Policy.** 0.9.0 answered "5 ok, 1 warning, 0 failed"
  against a page whose live `connect-src` was missing
  `https://uploads.chatlychat.com` — every attachment upload from that widget
  was being refused by the browser, and the command that exists to catch
  exactly this said nothing. Every check it had was about Chatly's deployment:
  we published the host, the host answered, the assets served. Nothing had
  read the customer's page, and a CSP violation is invisible from a server by
  construction, because the request is never made.

  The new `csp.site` check fetches the page and reads what a browser reads:
  the `Content-Security-Policy` response header **and** any
  `<meta http-equiv="Content-Security-Policy">` in the HTML, every policy
  applying at once, with `default-src` filling in for a directive the site did
  not name. It compares them against the four source lists the channel
  publishes and **fails** the run naming each host no policy admits, with the
  directive it belongs in. Emitted only with `--origin`.

  Permissive where it is unsure — a port, a path and a source written with no
  scheme are not held against the site — because a false failure sends
  somebody to fix a policy that was already right. Three things are not
  simplified: the `default-src` fallback, the scheme-upgrade pair
  (`https://host` admits `wss://host`, which is CSP's own rule and matters
  because the realtime host is published as `wss://`), and policy
  intersection, since two policies both bind.

- **`upload.preflight` can run now.** It needs `POST /v1/uploads/presign` to
  sign an upload — writing no object and no row — in order to learn the exact
  URL a browser would `PUT` to, and that route admitted no API key at all, so
  the check warned and carried on. A headline check that cannot run is worse
  than one that fails, because it reports as health. The route is open to a
  `ck_` key on `uploads:create` as of the same day; add the scope to your key
  (`chatly whoami` lists what it has).

## 0.9.0 — 2026-11-04

- **`chatly doctor`** — health-check a DEPLOYED widget install from outside,
  the way a browser on a customer's page sees it. Asked for by FormFlow:
  "CLI 0.8.2 still has no command that health-checks a deployed site's setup.
  Run before this deploy, it would have flagged the missing upload host."

  Seven checks, and every one of them is a question a server cannot answer
  about itself — which is why the two defects that reached production on
  2026-11-04 were invisible to every gate. `upload.preflight` sends the real
  browser preflight (`OPTIONS`, `Access-Control-Request-Method: PUT`,
  `Access-Control-Request-Headers: content-type`) against a real signed URL
  and requires a 2xx AND an `access-control-allow-origin`: the bucket had no
  CORS policy at all, so every attachment upload in the product died in the
  browser and production held zero messages with an attachment, ever.
  `upload.host` warns when uploads do not go to a `chatlychat.com` host, which
  was the second defect — a raw R2 account endpoint in every customer's CSP.
  `csp.hosts` dials every host we publish in `embed.contentSecurityPolicy`,
  because one that does not resolve is a feature that fails silently in a
  visitor's browser. `widget.assets` requires every asset the loader fetches
  to answer 200 with a JavaScript content-type, reading the chunk list from
  the widget host's own `version.json` rather than a hand-written list.
  `widget.origins` reports an empty `allowedOrigins` as a WARNING rather than
  a pass, and with `--origin <url>` fails with the exact value to add.
  `identity.jwks` reports the server's verdict for the identity provider's key
  set. `files.deprecated` warns while a file host is being retired.

  Exits 1 if any check FAILED; warnings alone exit 0, so it is usable as a
  deploy gate. `--channel <publicId|id>` narrows to one channel, `--json`
  emits every verdict.

## 0.8.2 — 2026-11-03

- The scaffolded React component takes an identity provider that answers
  `null`. `chatly init next` and `chatly init remix` declared
  `getToken?: () => Promise<string>`, so the component they write for you
  rejected the very provider its own comment tells you to pass — a hosted
  provider's minter is `() => Promise<string | null>`, `null` meaning signed
  out. Now `() => Promise<string | null>`, matching
  `@chatlychat/widget-element` 0.27.1.

## 0.8.1 — 2026-11-03

- `chatly init next` and `chatly init remix` scaffold props that EXIST.
  Both React launchers passed the identity as top-level props —
  `{...identity}` spreading `externalId`/`userHash`, and `{...{ getToken }}` —
  and `ChatlyLauncherProps` declares none of the three; they live inside
  `visitor`. So every scaffolded React app identified nobody, in silence,
  because the widget drops an unknown option without a word. The Atlas
  template now passes `visitor={{ getToken }}`, and the HMAC template uses
  `identityEndpoint="/api/chatly/identity"` — the option that exists to delete
  the `useState`/`useEffect`/`fetch` loop it used to write out. (FormFlow,
  2026-11-03.)

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
