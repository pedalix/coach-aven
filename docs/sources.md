# Sources — per-project ingestion of mail, chat, calendar and files

A project can declare **sources**: external systems the bot reads on the project's behalf and
archives on the bot host, scrubbed of secrets, for the project's agent to search later. The
pullers are orchestrator-side competencies like the composer dependency scanner
(`docs/project-facts.md`): they hold credentials the sandbox must never see and write derived
state the sandbox only reads.

This document describes what **PR-A (sources-core)** ships: the config block, the credential
locations, the `orch sources` CLI, the on-disk layout and the secrets pipeline. The store, the
poller and the sandbox-side search tool are the next slices (see *What comes next*).

## Config

```jsonc
{
  "slug": "owen-ops",
  "repos": ["owner-example/owen-ops"],
  "sources": {
    "google":  { "accounts": ["owen@example.com", "owen@example.com"], "since": "2026-09-01",
                 "calendars": [], "kinds": ["gmail", "drive", "calendar"] },
    "slack":   { "workspaces": ["T0000FAKE01"], "since": "2026-10-01", "threadWindowDays": 30, "editWindowHours": 48 },
    "msgraph": { "tenant": "00000000-0000-4000-8000-000000000000", "accounts": ["owen.hale@example.com"],
                 "only": ["mail", "calendar", "chats", "channels", "files"] },
    "intervalMinutes": 15,
    "people": "projects.d/owen-ops.people.json"
  }
}
```

| Key | Meaning |
| --- | --- |
| `google.accounts` | e-mails bootstrapped with `orch sources auth <slug> google login`; `since` bounds the first Gmail/Drive backfill; `calendars` are ids read **in addition to each account's primary calendar** (a colleague's shared calendar once yielded 200k title-less events, so nothing else is read by default); `kinds` ⊆ gmail, drive, calendar |
| `slack.workspaces` | team ids (or names) stored by `auth slack add`; empty = every stored workspace. `since` bounds first contact with a conversation, else the workspace's `backfill_days`. `editWindowHours` is how far history is re-read each run to turn deletions into tombstones and edits into replacements |
| `msgraph.tenant` | the Entra tenant GUID — the authority is always the tenant, never `/common`; `accounts` are UPNs; `only` ⊆ mail, calendar, chats, channels, files |
| `intervalMinutes` | poller interval (PR-C); validated now |
| `people` | identities file for the store build (PR-B); validated as a relative path now |

`loadProjects` validates the block at boot (`src/sources/config.ts`), so a typo fails the start,
not the first pull.

## Credentials

```
~/.config/coach-aven/sources/<slug>/google.json      OAuth clients + refresh tokens (or a DWD service-account key)
~/.config/coach-aven/sources/<slug>/slack.json       user tokens (xoxp) per workspace
~/.config/coach-aven/sources/<slug>/msgraph.json     Entra refresh tokens (rotated on every use, under a lock)
~/.config/coach-aven/sources/<slug>/vault.recipient  age public key the vault encrypts to
```

`XDG_CONFIG_HOME` is honoured. Files are mode 600 in a 700 directory, written atomically.
They are deliberately **not** beside `state.json`: `state.json` is deploy-synced and exportable
(`infra/prod/deploy.sh export|import`), and a tenant purge may delete `data/<slug>` — an OAuth
grant must survive both and never travel in an export. They are also not `${ENV}` references
like MCP secrets, because refresh tokens rotate and must be rewritten in place.

Bootstrap runs **once, where a browser is** (the operator's laptop; WSL2 + Windows Chrome works):

```bash
orch sources auth owen-ops google client add --name pedalix --json ~/Downloads/client_secret_….json --audience internal
orch sources auth owen-ops google login --client pedalix --account owen@example.com
orch sources auth owen-ops slack add --probe              # paste the xoxp; --probe checks the rate-limit tier
orch sources auth owen-ops msgraph login --tenant <guid> --client <app-id>
orch sources auth owen-ops <kind> check                   # the health check — run it FROM THE BOT HOST too
```

If the laptop is not the bot host, copy the three JSON files over once; `check` from the host
proves that refresh works from its IP (Conditional Access, egress rules). Exit codes: 0 ok,
2 usage / consent refused (the message says what to click), 3 a credential is dead.

What each source needs from whom is documented per connector in the module headers
(`src/sources/<kind>/auth.ts`); the short version: Google needs nothing but a Desktop-app
OAuth client (Internal audience for a Workspace you administer, External *published* for
anything else — Testing mode kills refresh tokens after 7 days); Slack needs an
undistributed user-scoped app per workspace (token rotation OFF); Microsoft needs **one
tenant-wide admin consent** for Mail.Read, Calendars.Read, Chat.Read, Files.Read.All,
Sites.Read.All and ChannelMessage.Read.All — expect "Need admin approval" on the first login and
send the admin the link that `auth msgraph admin-consent-url` prints.

## Pulling

```bash
orch sources pull owen-ops                       # every configured kind, incremental
orch sources pull owen-ops --only google --since 2026-01-01 --full
orch sources pull owen-ops --only msgraph --chats-full       # daily: catches edits/deletes of old Teams messages
```

Exit codes mirror the pullers: 0 ok, 1 something failed (the log says what), 3 a human must
re-run `auth`. Every pull is safe to repeat: cursors (Gmail `historyId`, Drive page token,
Calendar sync tokens, Slack `last_ts` + edit window, Graph delta links and watermarks) advance
only after their data was written, so a crash re-reads a little and never skips.

## On disk

```
data/<slug>/raw/google/<account>/{messages,files,events}.jsonl + google/cursor.json
data/<slug>/raw/slack/slack.{messages,files}.jsonl + slack.{cursor,users}.json
data/<slug>/raw/msgraph/<account-slug>/{messages,calendar,files,tombstones}.jsonl + cursor.json
data/<slug>/vault/<id>.json.age
```

`data/` sits at the package root beside `facts/`, `memory/`, `drafts/` (gitignored, mode 700).
Raw files are **append-only**: the same id may recur (edits, resyncs) and deletions arrive as
`{ "deleted": true }` tombstones — readers compact by id, last record wins, tombstone wins.
PR-B turns this into `data/<slug>/store.sqlite` and a read-only replica for the sandbox.

## Secrets

Every message body passes `scrubForWrite` (`src/sources/common/sink.ts`) before it is written:

- **Inline redaction** (`src/scrub.ts`, the same detectors that guard the model boundary):
  connection strings, PEM keys, vendor token prefixes, JWTs, Bearer tokens, `KEY=value` /
  `password:` pairs (EN/DE/RU), IBAN and card numbers become `[REDACTED:<kind>:<hash6>]`. The
  hash is `sha256(value)[0..6]`, so the same secret yields the same tag — the agent can say
  "same password as last week" without knowing it.
- **Carrier messages** — a strong kind present (DSN, PEM, `.env` line, JWT, Bearer, vendor
  token), two or more non-financial findings, a `Password:` line beside a login line, a strong
  subject (*Zugangsdaten*, *credentials*, *your login details* …) or a credential-looking
  attachment name — lose their whole body: `[BODY WITHHELD: credential carrier — see vault <id>]`.
  Generic words (access, account, keys) are **not** carrier signals; the first live pull showed
  they withhold Dependabot digests and "you have 1 overdue task".
- **Attachments** are never ingested; name + size survive.
- **The vault**: a carrier's raw secrets and body are encrypted with `age` to the project's
  recipient and filed under `data/<slug>/vault/<id>.json.age`. Without `age` or a recipient the
  puller logs once and keeps going — the body is still withheld, just not preserved. Decrypt
  with your private key wherever you keep it; the host never holds it.

### Quarterly audit

```bash
orch sources audit owen-ops --dir /var/www/coach-aven/events     # raw + replica + the bot's event log
```

Our detectors over every string field of every JSONL record, gitleaks as an independent second
opinion when it is on `PATH`, and recall on the gold set `src/fixtures/scrub-gold.jsonl`. Exit 1
on any real hit or gold miss. The rule: **every miss becomes a gold row and a canary row**
(`src/fixtures/scrub-canary.jsonl`, asserted by `src/scrub.test.ts`), the leaked credential is
rotated, and the number improves measurably instead of by feel. Run it after the first backfill
(baseline), quarterly, after a detector change, and when a new source joins.

## What comes next

| Slice | Adds |
| --- | --- |
| **PR-B sources-store** | `data/<slug>/store.sqlite` built incrementally from `raw/` (raw immutable, messages, threads, events, files, people/identities, FTS5), `VACUUM INTO` replica, the replica mounted read-only into the sandbox automatically (no hand-written `sandbox.mounts`) |
| **PR-C sources-poller** | pulls on the poller loop (interval per project, single-flight, backoff, re-auth alerts), sync state in `facts/<slug>.json`, `/aven status` line, App Home bullet |
| **PR-D sources-mcp** | an MCP server inside the sandbox over the read-only store: `search`, `get`, `people`, `stats`, every hit with its permalink |

Until PR-C, schedule `orch sources pull <slug>` yourself (cron/launchd every 15 min keeps the
Gmail `historyId` alive; a lapsed one costs a full resync, not data).
