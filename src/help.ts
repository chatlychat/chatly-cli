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
  bots rotate-secret <id>     New signing secret, shown once. No overlap window
  bots deliveries <id>        The push ledger. --status pending|delivered|failed|dead
  bots delivery <id> <delivery-id>
                              One delivery, with the exact signed payload
  bots redeliver <id> <delivery-id>
                              Queue the recorded payload again, from attempt 0
  bots test-delivery <id>     Sign and POST a rehearsal payload; prints the response

ROUTING + AUTOMATION
  bot-routes list | fields | create | update <id> | delete <id>
  bot-routes resolve          Dry-run the table. --body with a hypothetical visitor
  triggers list | get <id> | upsert | delete <id>
  brands list | get <id> | create | update <id> | delete <id>
  macros list | get <id> | create | update <id> | delete <id>
  email-templates templates | get <kind> | set <kind> | reset <kind>
  knowledge-gaps list | triage <id>

INTEGRATIONS
  webhooks deliveries         --status
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
  channels rotate-secret <id>

DEVELOPING AGAINST WEBHOOKS
  listen                      Tail this workspace's webhook deliveries and POST
                              each one to a local URL. Registers nothing
                              --forward-to <url>   where to POST (omit to print only)
                              --secret <whsec_…>   sign the forwarded request
                              --endpoint <id>      one subscription's traffic only
                              --event <name>       repeatable; filters client-side
                              --status <s>          delivered | failed | dead
                              --replay <n>         forward the n newest rows first
                              --interval <seconds> poll interval, default 2

WORKSPACE AS CODE
  plan                        Diff chatly.json against the live workspace. Reads only
  apply                       Make the plan's changes. Never deletes unless told
                              --file <path>   the document (- for stdin). Default: ./chatly.json
                              --prune         also delete what the document omits
                              --write-only    also send fields that cannot be read back
                              --exit-code     plan only: exit 2 when there is drift

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
