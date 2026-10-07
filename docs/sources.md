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

`data/` sits at the package root beside `facts/`, `memory/`, `drafts/` (gitignored, mode 700;
`AVEN_DATA_DIR` relocates it). Raw files are **append-only**: the same id may recur (edits,
resyncs) and deletions arrive as `{ "deleted": true }` tombstones — the store compacts by id,
last record wins, tombstone wins.

## Store

Raw JSONL is the archive; the agent needs something it can *query*. `orch sources build <slug>`
(run automatically at the end of every `pull`, `--no-build` to skip) folds the new bytes of
every raw file into **one SQLite per project**, `data/<slug>/store.sqlite` (`src/sources/store.ts`,
on Node's built-in `node:sqlite`, no native dependency):

| Table | What |
| --- | --- |
| `raw_records` | one row per raw **line** (`source, account, id, line_hash`) — the idempotency unit; a replayed line is a no-op |
| `messages` | compacted mail + chat: `ref` = `source:account:id`, `thread_id`, `ts`, `author_person`/`author_raw`, `subject`, `text`, `permalink`, `raw_ref`, `scrub_withheld`/`scrub_kinds`, `deleted` |
| `messages_fts` | FTS5 over `subject`+`text` (`porter unicode61 remove_diacritics 2`: *läuft* ↔ *lauft*, *running* ↔ *run*); triggers keep it in step and **drop deleted rows from the index** |
| `threads` | per-thread rollup (first/last ts, count), recomputed for the threads a build touched |
| `events`, `files` | calendar items and file metadata, same compaction and tombstones |
| `people`, `identities`, `message_people` | who is who — reseeded on every build from the people file, then `from`/`to` rows per message |
| `sync_state` | `schema_version` + the byte offset consumed per raw file |

Why this shape: GB-scale personal mail and chat are an FTS problem first (the research behind
the design is in the owen-ops repo, `docs/research-landscape.md` §2); embeddings would be an
optional, disposable side index, never the source of truth. Thread ids follow the pullers'
`raw_ref`s: Gmail `gmail:<account>/<threadId>`, Slack `slack:<team>/<channel>/<thread_ts>`,
everything else is its own thread.

**Build semantics.** Only complete lines are consumed — a half-written last line waits for the
next build; a raw file that shrank below its offset is re-read from zero and reported. Each
chunk of lines is applied with its new offset in one transaction, so a crash can never leave
rows without the offset that produced them (and `raw_records` makes the replay harmless).

**People.** `sources.people` (relative to `projects.config.json`), default
`projects.d/<slug>.people.json`: a JSON array of
`{ "person_id", "name", "company?", "default_initiative?", "identities": [...] }`. Identity kinds
are inferred — contains `@` → e-mail; `slack:` → the display name the Slack puller writes;
`msgraph:` → UPN; bare string → display name. Matching is by lower-cased key, and
`"Name <addr>"` authors fall back to the address. The same key for two people is a load error.

### Replica

After each build the store is copied with `VACUUM INTO data/<slug>/replica/store.sqlite.tmp`
and renamed into place — a consistent single-file snapshot with no WAL. That **directory** is
what the sandbox gets, mounted read-only at `/data/sources` (`SOURCES_MOUNT_TARGET`), and it is
added to the project's `sandbox.mounts` **automatically** by `loadProjects` whenever the
project has a `sources` block — nobody writes that line by hand, and a hand-written mount on
the same target fails the boot as a duplicate. The directory (not the file) is mounted so
the rename is visible inside the container; readers open it with `?immutable=1`
(`openReadOnly()` in `store.ts`). Like every sandbox option it applies at container creation:
turning sources on for an existing `proj-<slug>` needs a `docker rm` first.

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

## Poller

The bot pulls on its own: a fifth poller (`src/pollers.ts` → `src/sources/sync.ts`) ticks
every minute and runs `pull → store build → replica` for every project whose pass is due.

- **Cadence.** `sources.intervalMinutes` per project (default 15). A pass with any failure
  doubles the wait — 15 → 30 → 60 → 120 min, capped at two hours — and a clean pass resets it.
- **Single-flight.** One pass per project at a time, projects sequentially: one process, one
  disk, and the pullers already parallelise inside (accounts, conversations).
- **Re-auth.** A kind whose puller reports `reauth` (Google `invalid_grant`, a revoked Slack
  token, an Entra refresh that needs a human) is *parked*: the other kinds keep their cadence,
  the parked one is probed once every two hours, and the operator gets ONE alert
  (`alertOps`) per distinct situation — not a nag every two hours. It is released the moment
  a probe reports ok again, i.e. after `orch sources auth <slug> <kind> …` on the bot host.
- **No sandbox involvement.** Pulls run on the bot host with tokens the sandbox never sees;
  the replica swap is an atomic rename, so an in-flight turn keeps reading the old file.
- **Daily credential check.** At 06:00 (`AVEN_TZ`) every configured kind's `check` runs
  headless; a failing one alerts with the checker's last lines.

### State: the `sources_sync` fact

Sync state is one facts predicate per project in `facts/<slug>.json` (docs/project-facts.md) —
derived, re-derivable by pulling again, never in `state.json`, never in an export:

```json
{
  "subject": "project:owen-ops",
  "predicate": "sources_sync",
  "value": {
    "lastRunAt": "2026-10-07T13:45:02.118Z",
    "lastOkAt": "2026-10-07T13:45:02.118Z",
    "lastSummary": {
      "google": { "ok": true, "reauth": false, "records": 312, "finishedAt": "…", "errors": [] },
      "slack":  { "ok": true, "reauth": false, "records": 15,  "finishedAt": "…", "errors": [] }
    },
    "consecutiveFailures": 0,
    "needsReauth": [],
    "reauthProbeAt": "…",
    "lastError": "…"
  },
  "sources": ["data/owen-ops/raw", "projects.config.json#sources"],
  "observedAt": "2026-10-07T13:45:02.400Z"
}
```

`/aven status` renders it under the project line as
`↳ sources: last pull 13:45, 327 records, next in 7m | reauth needed: google`
(times in `AVEN_TZ`; `never pulled, due now` before the first pass; `N failing` while backing off).

## Search tool

A project with a `sources` block gets a fifth MCP server in every chat: **`sources`**
(`snapshot/plain/sources-mcp.mjs`, injected by `src/sources/mcp.ts` → `withSourcesMcp`). It is a
dependency-free stdio server that runs on the image's own Node and opens the read-only replica at
`/data/sources/store.sqlite` — per call, so a replica swapped between turns is picked up without a
restart. The agent sees `mcp__sources__search`, `get`, `people`, `stats`:

| Tool | Does |
| --- | --- |
| `search({query, since, until, source, person, initiative, limit})` | FTS5 (`bm25`) over subject+text; every token is quoted so user text cannot reach the MATCH grammar (`word*` keeps prefix matching). `person` is an identity (email, slack id) or a name fragment; `initiative` filters by the people whose default initiative it is. No query → newest first. Hits carry `ref`, `permalink`, a highlighted snippet and `withheld` when the body was removed. |
| `get({ref})` | The full row, up to five thread neighbours each way, the people on it and the scrub metadata. A withheld body returns its `[BODY WITHHELD…]` marker verbatim — that *is* the answer. |
| `people({q})` | Known people with their identities (from `projects.d/<slug>.people.json`). |
| `stats()` | Per-source counts and time range, events, files, withheld count, build meta — what the replica covers, before the agent concludes something is missing. |

Shipping: the script is baked into the plain image at `/opt/aven/sources-mcp.mjs` and
`provisionTooling()` compares sha256 and re-uploads it into warm sandboxes (and the laravel image)
whenever the bot ships a newer copy. The layer-1 system prompt gains one paragraph when sources are
enabled: search first, cite permalinks, redaction markers are final. A project may declare its own
`sources` MCP entry to override the built-in one.

## What comes next

| Slice | Adds |
| --- | --- |
| ~~PR-B sources-store~~ | shipped: the store, the replica and the automatic mount above |
| ~~PR-C sources-poller~~ | shipped: the poller below |

| ~~PR-D sources-mcp~~ | shipped: the `sources` MCP server above |

Each pull ends with the store build, so the replica the sandbox sees is never older than
the last pull. The CLI stays for bootstrap, backfills (`--since`, `--full`) and audits.
