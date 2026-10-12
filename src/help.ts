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

CONTACTS
  contacts list               People in this workspace
  contacts get <id>
  contacts upsert             --email --name --external-id --phone
  contacts tag <id> <tag>     Add a tag
  contacts journey <id>       Timeline: conversations, events, tickets

TICKETS
  tickets list                --status --queue
  tickets comments <id>
  tickets queues

KNOWLEDGE + SEARCH
  search <query>              Across contacts, conversations, messages, tickets, KB
  kb articles                 Help-centre articles
  kb article <slug>

EVENTS
  events track <contact-id> <name>
                              Fire a CDP event. --prop key=value, repeatable
  events list                 --contact-id

WEBHOOKS
  webhooks deliveries         --status
  webhooks redeliver <id>

REPORTS
  reports overview            --from --to
  reports agents
  reports sla

WORKSPACE
  workspace settings
  workspace labels | inboxes | skills
  workspace team-members <team-id>
  channels list | channels get <id>
  billing usage | billing plans

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

Docs: https://chatlychat.com/docs/cli
`;
