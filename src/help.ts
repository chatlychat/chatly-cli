/**
 * `--help`, and the one thing it has to be: complete.
 *
 * ── Why this is 22 sections and not 7 ─────────────────────────────────────
 *
 * It was 7. `run.ts`'s own docblock said a check "makes certain that every
 * command documented in `--help` is reachable — a command with no help entry
 * is a command nobody finds", and no such check existed: fifteen of the
 * twenty-two command groups had never been mentioned here, among them `ai`,
 * `billing`, `bot-routes`, `brands`, `customer-cards`, `docs-sources`,
 * `email-templates`, `knowledge-gaps`, `macros` and `triggers`.
 *
 * A CLI's help IS its documentation. An undocumented command is an unshipped
 * command, however complete its implementation — the same defect
 * `check-endpoint-with-no-caller` exists for one layer down.
 *
 * `cli.spec.ts` now checks BOTH directions on every run: every key in
 * `COMMANDS` appears here, and every command word here resolves through
 * `COMMANDS` or `ALIASES`. The first half is what was missing; the second is
 * what stops this file growing a promise the CLI does not keep.
 *
 * The convention the spec relies on: a command line starts with exactly two
 * spaces and its first word is the command group.
 */
export const HELP = `chatly — the Chatly command line

USAGE
  chatly <command> [subcommand] [flags]

AUTH
  login                       Store an API key in ~/.config/chatly/config.json (0600)
  logout                      Remove the stored key
  whoami                      Which workspace this key belongs to, and its scopes
                              (a cp_ credential: scopes, expiry and guardrails)
  api-keys create             Mint a key. --recipient seals it to an X25519
                              public key, so no plaintext is ever returned
                              (see SEALED DELIVERY below)

CONVERSATIONS
  conversations list          Open conversations, newest first
  conversations get <id>      One conversation
  conversations messages <id> The thread
  conversations send <id> <body>
                              Reply as the key's machine identity
  conversations unattended    Open with no agent reply yet
  conversations mood <id>     Sentiment over the thread
  conversations return-to-bot <id> <bot-id>
                              Give an open thread back to an assistant

CONTACTS
  contacts list               People in this workspace
  contacts get <id>
  contacts upsert             --email --name --external-id --phone
  contacts tag <id> <tag>     Add a tag
  contacts journey <id>       Timeline: conversations, events, tickets
  contacts cards <id>         Customer-card data for this person

TICKETS
  tickets list                --status --queue
  tickets get <id>
  tickets comments <id>
  tickets queues
  tickets lineage <id>        Merge and split history
  tickets time <id>           Time logged
  tickets status-history <id>

KNOWLEDGE + SEARCH
  search <query>              Across contacts, conversations, messages, tickets, KB
  kb articles                 Help-centre articles
  kb article <slug>
  kb collections

EVENTS
  events track <contact-id> <name>
                              Fire a CDP event. --prop key=value, repeatable
  events list                 --contact-id

BOTS + EXTERNAL AGENTS
  bots list | get <id>
  bots create                 --body. type:"external" answers with a secret, ONCE
  bots update <id>            --body
  bots update-external <id>   --body. webhookUrl, timeoutSeconds, fallbackMessage
  bots rotate-secret <id>     New signing secret, shown once. Hard cut, or
                              --activate-at <ISO instant> (≤168h) keeps the old
                              one signing until then
  bots deliveries <id>        The push ledger. --status pending|delivered|failed|dead
  bots delivery <id> <delivery-id>
                              One delivery, with the exact signed payload
  bots redeliver <id> <delivery-id>
                              Queue the recorded payload again, from attempt 0
  bots test-delivery <id>     Sign and POST a rehearsal payload; prints the response
  deliveries list --bot <id>  An agent's delivery log. --status, --all
  deliveries show <event-id> --bot <id>
                              The body (kept 7 days) and what the agent replied
  deliveries replay <event-id> --bot <id>
                              Re-send the ORIGINAL body with the original eventId

ROUTING + AUTOMATION
  bot-routes list | fields | create | update <id> | delete <id>
  bot-routes resolve          Dry-run the table. --body with a hypothetical visitor
  triggers list | get <id> | upsert | delete <id>
  brands list | get <id> | create | update <id> | delete <id>
  macros list | get <id> | create | update <id> | delete <id>
  email-templates templates | get <kind> | set <kind> | reset <kind>
  knowledge-gaps list | triage <id>

INTEGRATIONS
  webhooks deliveries         --status --endpoint --trace <ulid> (X-Chatly-Trace)
  webhooks delivery <id>
  webhooks redeliver <id>
  webhooks endpoints          Subscriptions, not traffic
  webhooks events             The subscribable event catalogue
  webhooks schema-versions
  webhooks create             --url --event (repeatable). Answers with whsec_, once
  webhooks pin <id> <version>
  customer-cards list | create | update <id> | delete <id>
  customer-cards rotate-secret <id>
                              Update your endpoint BEFORE calling this
  docs-sources list | providers | discover | create | update <id> | delete <id>
  docs-sources sync <id>      --full re-reads every page
  docs-sources subscribe <id> A refusal is a success: read the response
  channels list | get <id> | adapters | create | update <id>
  channels set-key <id> <key> Give an existing channel the key chatly.json matches it on
  channels rotate-secret <id>
  channels brand <id>         --url <brand.json> | --file/--body to apply; neither reads back

DATA RIGHTS
  privacy executor-key        Mint the credential a privacy platform registers.
                              Answers with the executor URL, the workspace id
                              and the secret — shown ONCE. The key carries
                              exactly privacy:execute and reaches nothing but
                              /v1/privacy/*
  privacy lookup              --body <json>  resolve a person to a subjectId
  privacy request             --body <json>  file one; caseId is the replay key
  privacy status <id>         Read a request back
  privacy cancel <id>         Withdraw one that has not run

DEVELOPING AGAINST WEBHOOKS AND AGENTS
  listen                      Tail this workspace's webhook deliveries and POST
                              each one to a local URL. Registers nothing
                              --forward-to <url>   where to POST (omit to print only)
                              --secret <whsec_…>   sign the forwarded request
                              --endpoint <id>      one subscription's traffic only
                              --event <name>       repeatable; filters client-side
                              --status <s>         pending | delivered | failed | dead
                              --replay <n>         forward the n newest rows first
                              --interval <seconds> poll interval, default 2
  listen --bot <id>           Tail one external agent's push deliveries instead,
                              the same ledger as 'bots deliveries'. Same flags, except:
                              --secret <chsec_…>   the AGENT's secret, not whsec_
                              --event <kind>       message | transfer (agent.message too)
                              Forwards the payload itself, with the five
                              x-chatly-* headers a real delivery carries
  listen --relay              Receive LIVE tool calls, card fetches and canvas steps
                              on localhost and answer them. Takes PRODUCTION traffic
                              for the ids named, so they are required:
                              --tool <id> | --card <id> | --canvas <channelId>
                              --forward-to <url>   required; each call's path is appended
                              --secret <s>         or <id>=<s>, repeatable; re-signs
                              Detaches after 10 minutes idle, or on Ctrl-C. The
                              dashboard shows a banner for as long as it is attached

WORKSPACE AS CODE
  plan                        Diff chatly.json against the live workspace. Reads only
  apply                       Make the plan's changes. Never deletes unless told
                              --file <path>   the document (- for stdin). Default: ./chatly.json
                              --prune         also delete what the document omits
                              --write-only    also send fields that cannot be read back
                              --exit-code     plan only: exit 2 when there is drift
  platform plan               The same over /v1/platform/* with a cp_ credential:
  platform apply              workspaces, users, apiKeys, botCredentials,
                              knowledgeSources and settings (business hours,
                              routing, widget channel) across many tenants.
                              Default file: ./chatly.platform.json. Same flags.
                              apply re-reads afterwards and exits 1 unless
                              everything matches the document

INSTALL
  init next|remix|astro|express
                              Scaffold the widget into this project for a web channel:
                              identity route, launcher or snippet, CSP sources
                              (chatly.csp.mjs) and a privacy table. Never overwrites
                              --public-id <id>   which web channel (needed if several)
                              --identity hmac|atlas   default hmac (atlas: next, remix)
                              --dir <path>   default .   --dry-run   --force

AI
  ai providers | quota
  ai add-provider             BYOK. --body
  ai test-provider <key>
  ai tools | create-tool | update-tool <id> | delete-tool <id>
  ai tone | set-tone | generate-tone <sample>

REPORTS
  reports overview            --days
  reports agents              Means, not percentiles
  reports conversations-by-day
  reports sources | response-times | voice
  reports attribution <dim>   One of ten dimensions; an unknown one is refused
  reports cohorts             --weeks, NOT --days
  reports themes              --date. A daily snapshot; there is no regenerate
  reports theme-conversations <theme-id>
  reports teams | labels | sla
                              --from --to --days --group-by

BILLING
  billing summary | plans | invoices
  billing usage <event-type>  One meter over a window. --from --to
  billing usage-daily <event-type>
                              Dense: one row per UTC day, zeros included
  billing usage-monthly       --month

WORKSPACE
  workspace settings
  workspace labels | inboxes | skills
  workspace team-members <team-id>
  workspace key-scopes        What a key may be granted

SEALED DELIVERY
  secret keypair              An X25519 keypair; send the public half to
                              whoever mints the credential
  secret open --sealed <blob> --key-file <path>
                              Open a sealedSecret locally, so the plaintext
                              never has to be pasted anywhere

RAW
  api <METHOD> <path>         Any route, with auth, idempotency and retries
                              chatly api GET /v1/feature-flags
                              chatly api POST /v1/macros --body '{"name":"Refund"}'

GLOBAL FLAGS
  --json                      Raw API response instead of a table
  --all                       Follow pagination to the end (list commands)
  --limit <n>                 Page size
  --cursor <c>                Start from a cursor
  --key <ck_…>                Override the stored key for this call
  --api-url <url>             Point at another Chatly environment
  --help, --version

Docs: https://chatlychat.com/docs/sdk-cli
`;
