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
    "google":  { "accounts": ["you@example.com", "you@side.example"], "since": "2026-09-01",
                 "calendars": [], "kinds": ["gmail", "drive", "calendar"] },
    "slack":   { "workspaces": ["T0000FAKE01"], "since": "2026-10-01", "threadWindowDays": 30, "editWindowHours": 48 },
    // a tenant store: only the shared channels, no DMs —
    // "slack": { "workspaces": ["T0000FAKE01"], "channels": ["bluefin-aven-caldora", "C0BBX082QNQ"], "kinds": ["channel"] },
    "msgraph": { "tenant": "00000000-0000-4000-8000-000000000000", "accounts": ["you@partner.example"],
                 "only": ["mail", "calendar", "chats", "channels", "files"], "calendars": [] },
    "intervalMinutes": 15,
    "people": "projects.d/owen-ops.people.json"
  }
}
```

| Key | Meaning |
| --- | --- |
| `google.accounts` | e-mails bootstrapped with `orch sources auth <slug> google login`; `since` bounds the first Gmail/Drive backfill; `calendars` are ids read **in addition to each account's primary calendar** (a colleague's shared calendar once yielded 200k title-less events, so nothing else is read by default); `kinds` ⊆ gmail, drive, calendar |
| `slack.workspaces` | team ids (or names) stored by `auth slack add`; empty = every stored workspace. `since` bounds first contact with a conversation, else the workspace's `backfill_days`. `editWindowHours` is how far history is re-read each run to turn deletions into tombstones and edits into replacements |
| `slack.channels`, `slack.kinds` | **the project's Slack scope.** `channels`: channel names (with or without `#`) or conversation ids — set, only these are pulled and every other conversation the user is in, DMs included, is skipped (a DM or group DM has no name: list it by id). `kinds` ⊆ channel (public), group (private), im, mpim — applied on top. Both absent = everything the user is a member of, as before. A tenant store (Bluefin's shared `#bluefin-aven-*` channels pulled with Owen's user token) needs the allow-list, or it would hold his private conversations. The pull log says `scope: n of m conversations` and names the skipped ones with `--verbose`; `orch sources pull <slug> --only slack --list` marks them `[out of scope]`. Lines already pulled from a conversation later excluded stay in `raw/` (append-only) until a purge; a fresh store starts scoped from its first pull (`src/sources/slack/scope.ts`). **Bot tokens** (a workspace stored with `auth slack add --bot` or `--from-install <team_id>`, i.e. the CoachAven installation's own token): the puller reads what the bot is a member of, joins every listed PUBLIC channel it is not in yet (`conversations.join`), names listed private channels it was not invited to as unreadable, never sees DMs; `joinPublic: true` joins every public channel of the workspace. This is the access model for a tenant's own workspace — install the app, invite it where wanted — while Slack Connect channels keep coming through the user token in ours (`sources-slack-bot-token`) |
| `msgraph.tenant` | the Entra tenant GUID — the authority is always the tenant, never `/common`; `accounts` are UPNs; `only` ⊆ mail, calendar, chats, channels, files |
| `msgraph.calendars` | Outlook calendar ids read **in addition to each account's default calendar** (default: the default calendar only — the same rule as `google.calendars`). A colleague's calendar shared into the mailbox, holidays and birthdays all appear in `/me/calendars`; Graph reports the mailbox owner as *organizer* for everything in them, so ownership is a property of the calendar, not of the event. Skipped calendars are named in the log every pass (ids with `--verbose`) so one can be opted in. Every Outlook event record carries `calendar: {id, name, is_default}` |
| `intervalMinutes` | poller interval (PR-C); validated now |
| `timezone` | the tenant's IANA zone — presentation only (storage is UTC): what a bare date means in every sources tool, `today`, the attribution layer's days. Default: the bot's `AVEN_TZ` |
| `people` | identities file for the store build (PR-B); validated as a relative path now |

`loadProjects` validates the block at boot (`src/sources/config.ts`), so a typo fails the start,
not the first pull.

## Credentials

```
~/.config/coach-aven/sources/<slug>/google.json      OAuth clients + refresh tokens (or a DWD service-account key)
~/.config/coach-aven/sources/<slug>/slack.json       tokens per workspace: user (xoxp) or the app's bot (xoxb); `kind` recorded by auth.test
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
orch sources auth owen-ops google login --client pedalix --account you@example.com
orch sources auth owen-ops slack add --probe              # paste the xoxp; --probe checks the rate-limit tier
orch sources auth bluefin-ops slack add --from-install T0SPOT   # the CoachAven installation's bot token for Bluefin's own workspace (or --bot to paste a xoxb)
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
| `events`, `files` | calendar items and file metadata, same compaction and tombstones. `events.calendar` is the Google calendar id for `gcal` rows and, for `msgraph` rows, the JSON text `{"id","name","is_default"}` of the Outlook calendar the event was read from (`is_default: true` = the account's own). Outlook lines without `calendar` — written by the puller before schema v6, which read every shared calendar untagged — are skipped at build, so the v6 rebuild drops them while the puller re-emits the own calendar tagged (its cursor marker `calendar.version` resets the delta link once) |
| `people`, `identities`, `message_people` | who is who — from the tenant's people file (markers included), then `from`/`to` rows per message |
| `meetings`, `meetings_fts`, `meeting_people` | recorded calls (see *Meetings*): title, start/end, attendees, summary, next steps, transcript; FTS over title+summary+transcript |
| `fragments`, `attributions` | the tenant's ledger (see *Tenant annotations*) and the initiative index behind every `initiative` filter: which refs belong to which initiative, with shares and who decided. With the attribution layer on, the index follows the plan — judgments, pins and live rule decisions over the platform's own refs — and ledger lines the plan does not hold keep their own rows; off, it is the ledger's alone |
| `sync_state` | `schema_version`, `derived_fingerprint`, `last_build_at`, one `pulled:<kind>` per source (ISO `finishedAt` of the last pull of that kind that reported **ok** — a failing kind keeps its previous value, so this is the age of the data, not of the attempt; the `stats` tool shows them under `meta`) + the byte offset consumed per raw file |

Why this shape: GB-scale personal mail and chat are an FTS problem first (the research behind
the design is in the owen-ops repo, `docs/research-landscape.md` §2); embeddings would be an
optional, disposable side index, never the source of truth. Thread ids follow the pullers'
`raw_ref`s: Gmail `gmail:<account>/<threadId>`, Slack `slack:<team>/<channel>/<thread_ts>`,
everything else is its own thread.

**Build semantics.** Only complete lines are consumed — a half-written last line waits for the
next build; a raw file that shrank below its offset is re-read from zero and reported. Each
chunk of lines is applied with its new offset in one transaction, so a crash can never leave
rows without the offset that produced them (and `raw_records` makes the replay harmless).

**Schema changes rebuild.** A store written by an older schema is deleted and rebuilt from raw
at the next build (raw is the source of truth; 84k lines take ~15 s) — there are no migrations.

**Derived vs ingested.** Raw → tables is incremental. Everything that depends on the tenant's
files — person resolution on every row (`author_person`, assignee/reporter, `message_people`,
`meeting_people`), people markers, `fragments`, `attributions` — is recomputed **in full** whenever
those files change (`derived_fingerprint`). A fix to people.json therefore applies to the rows
already stored, not only to the next pull. Person-only updates never touch the FTS indexes: each
table has ONE `AFTER UPDATE OF <indexed columns>, deleted` trigger that deletes-then-inserts in
that order (two separate update triggers fire in reverse creation order, which used to drop every
re-emitted row from the index).

**People.** In order: the tenant's `annotations/people.json` (when `sources.tenant` is set), else
`sources.people` (relative to `projects.config.json`), else `projects.d/<slug>.people.json`: a JSON array of
`{ "person_id", "name", "company?", "marker?": { "type": "exclusive|narrow|broad", "initiatives": [...] }, "identities": [...] }`.
The marker is the tenant's statement of how much a person says about which initiative a
conversation belongs to; the store only carries it to `people`. The older `default_initiative`
field is still read, as a `broad` marker. Identity kinds
are inferred — contains `@` → e-mail; `slack:` → the display name the Slack puller writes;
`msgraph:` → UPN; bare string → display name. Matching is by lower-cased key, and
`"Name <addr>"` authors fall back to the address. The same key for two people is a load error.

### Replica

After each build the store is copied with `VACUUM INTO data/<slug>/replica/store.sqlite.tmp`
and renamed into place — a consistent single-file snapshot with no WAL. Readers open it per call
with `?immutable=1` (`openReadOnly()` in `store.ts`), so a swap between two calls is picked up at
once. **The sandbox does not get it.** The bot answers the agent's `sources` tools from it over the
session's control channel (*Search tool* below; `docs/runtime-config.md` → *Host tools*), so a
sources project runs on any driver and nothing is mounted for it.

No project mounts it, and there are no exceptions (Owen, 2026-10-15). Deterministic work over the
whole store — attributing threads, calls, tickets and work blocks to initiatives — belongs in the
store build, where the data is, and reaches the agent through tools (OpenSpec `attribution-layer`),
not as a program reading the file inside the sandbox.

## Secrets

Every message body passes `scrubForWrite` (`src/sources/common/sink.ts`) before it is written:

- **Inline redaction** (`src/scrub.ts`, the same detectors that guard the model boundary):
  connection strings, PEM keys, vendor token prefixes, JWTs, Bearer tokens, `KEY=value` /
  `password:` pairs (EN/DE/RU), IBAN and card numbers become `[REDACTED:<kind>:<hash6>]`. The
  hash is `sha256(value)[0..6]`, so the same secret yields the same tag — the agent can say
  "same password as last week" without knowing it.
- **Carrier messages** — a strong kind present (DSN, PEM, `.env` line, JWT, Bearer, vendor
  token), two or more *bundle* findings, a `Password:` line beside a login line, a delivery
  subject (*Zugangsdaten*, *your credentials*, *credentials for/attached*, *your login details* …)
  or a credential-looking attachment name — lose their whole body:
  `[BODY WITHHELD: credential carrier — see vault <id>]`. A *bundle* finding is an explicit
  `key: value` / `key=value` outside a URL: `?link_token=…` tracking parameters, prose
  ("1.05M-token context", "scanner pass (gitleaks") and card/IBAN numbers are redacted inline
  but never cost the body — in the first 230 withheld bodies they were the majority (newsletters,
  GitHub notification mail, Slack unfurls). Generic words (access, account, keys, the bare noun
  *credentials*) are **not** carrier signals either; the first live pulls showed they withhold
  Dependabot digests, "you have 1 overdue task" and Owen's own "18 credentials to rotate".
- **Re-scrubbing after a rule change**: `orch sources rescrub <slug> --identity <age key>
  [--write]` replays the current rules over every withheld body (decrypted from the vault with
  the operator's private key), and appends the ones that are no longer carriers to their raw
  file inline-scrubbed; the next build replaces the withheld row by `ref`. Dry run by default;
  the summary names what still withholds and why.
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
- **One writer.** Whoever ingests a project holds `data/<slug>/.lock` (`src/sources/lock.ts`:
  pid, host, since, by): the bot's poller before each pass, a sources daemon for as long as it
  runs. A second writer refuses (the daemon at start, `orch sources pull/build` unless `--force`)
  or skips (the bot, logged once); a lock whose pid is gone is stale and taken over.

**Daemon mode** (OpenSpec `sources-daemon`): `orch sources daemon` runs this same ticker, the
daily check and the HTTP face in one process where the data lives, and the bot ingests nothing
for a project with `sources.daemon` — or for any project when `SOURCES_DAEMON=1` (a daemon on
the same host ingests). The daemon has no chat: its re-auth and auth-check alerts sit in its
status, and the bot's minute watcher passes each one on once (plus one alert when the daemon has
not answered for ten minutes, and one when it is back). See *Remote access*.

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

A project with a `sources` block gets one more MCP server in every chat: **`sources`**. The tool
table is `snapshot/plain/sources-mcp.mjs` (dependency-free; its `handleMessage` answers one JSON-RPC
message against one replica), and the **bot** serves it: registered over the session's control
channel, answered on a worker thread from the replica on the bot host (`src/hostrouter.ts`,
`docs/runtime-config.md` → *Host tools*). The same table also runs as a stdio server
(`node sources-mcp.mjs`, for tests and an operator's shell) and over HTTP (`orch sources serve`,
*Remote access*). The agent sees `mcp__sources__search`, `get`, `people`, `stats`:

| Tool | Does |
| --- | --- |
| `search({query, since, until, source, person, initiative, includeBots, limit})` | FTS5 (`bm25`) over subject+text; every word is quoted so user text cannot reach the MATCH grammar. Exposed on purpose: `"quoted phrases"`, `word*` prefix, and upper-case `OR` / `AND` / `NOT` between two terms (lower-case `or` is a word; dangling operators drop). Bot/integration messages (`messages.is_bot`) are excluded unless `includeBots`. A call recorded by several recorders comes back once, with the other copies in `also`. `person` is an identity (email, slack id) or a name fragment; `initiative` filters by the people whose default initiative it is. No query → newest first. Hits carry `ref`, `permalink`, `author` (who wrote it) and `to` (the other side — participants minus author, addresses stripped; omitted for channel posts), a highlighted snippet and `withheld` when the body was removed. A hit from `…/Sent Items` has the mailbox owner as author: sent, not received. |
| `get({ref})` | The full row, up to five thread neighbours each way, the people on it and the scrub metadata. A withheld body returns its `[BODY WITHHELD…]` marker verbatim — that *is* the answer. A task comes with its comments; a meeting comes *compact* (see *Meetings*): full summary, next steps, `transcript_chars`, `speakers`, every recorder copy — never the transcript. |
| `transcript({ref, q, offset, limit})` | One copy's transcript (a `meetings` ref, or a `call:` id → its primary copy), paged by characters on whole lines: default 30k, max 50k, `next_offset` until null. With `q` (all words must occur in a line, case-insensitive) only the matching lines ±1 line of context, numbered `L<n>:`. A withheld transcript returns its marker. |
| `calendar({since, until, person, q, source, limit})` | Calendar events (Google, Outlook) ordered by start — the source for "meetings today". `person` matches attendees/organizer via the person's identities (or the raw text); `q` matches the title. Every row carries `calendar` (see *Store*): for Outlook the JSON `{id, name, is_default}` — the only way to tell an own event from one in a calendar shared into the mailbox, since Graph names the mailbox owner as organizer for both. |
| `people({q})` | Known people with their identities (from `projects.d/<slug>.people.json`). |
| `unanswered(…)`, `stuck(…)` | The readouts — what waits for a reply, what stopped moving; see *Readouts* below. |
| `stats()` | Per-source counts and time range, events, files, withheld count, `tz`, `now` and build meta — what the replica covers, before the agent concludes something is missing. `meta.pulled.<source> {at, age_minutes}` is derived from the `pulled:<kind>` scalars in `sync_state` (the last **ok** pull per kind, see *Store*); a source older than its interval is named with its last pull, never read as "quiet". |

**UTC in storage, the tenant's zone in presentation.** Every stored instant is UTC — raw records,
store rows, the attribution tables, the ledger; nothing local is persisted. One zone per tenant,
`sources.timezone` in the project config (default: the bot's `AVEN_TZ`), decides what a date MEANS:
the build writes it into the store as `tz`, and every tool call against that store reads its windows
in it — so bluefin-ops and owen-ops on the same bot each get their own "today". The server, not the
model, decides: a bare `YYYY-MM-DD` is that whole day in the tenant's zone (`until: 2026-10-07` ends at
23:59:59.999 there), a zone-less datetime is wall time there, anything with `Z` or an offset is taken as
given. `stats.tz` names the zone; descriptions say "the project's time zone" with the server default for
a store built before zones were stored. An unknown zone name falls back to UTC rather than killing the
server.

Shipping: the bot imports the table, so a change reaches every session with the bot's next
restart — nothing is uploaded into sandboxes any more. The layer-1 system prompt gains one paragraph when sources are
enabled: search first, cite permalinks, redaction markers are final, transcripts are read through
`transcript` (in a subagent when a question needs the whole call), and an unavailable replica is
reported in one line — never polled or waited for, the orchestrator re-runs failed scheduled turns.
A project may declare its own `sources` MCP entry (a daemon's url, a stdio command) to override the
built-in one; the bot then registers no `sources` server for its sessions.

## Readouts

Two tools answer the questions a brief or an evening close used to reconstruct from `search` and
`tasks` on every run — *what waits for a reply* and *what stopped moving*. Both are plain SQL over
stored rows (no model, no text heuristics), so the same store always yields the same list and a
routine can quote the rows as facts. They are the latency and threshold readouts of the attention
field (`ideas/local-mode-positioning-2026-10-14.md` §8); the first tenant agent for Bluefin runs on them.

| Tool | Does |
| --- | --- |
| `unanswered({person, side, hours, since, until, container, source, limit})` | Inbound human messages addressed to the **subject** with no later reply from them. One row per conversation: the *oldest* waiting message (`ts`, `ageHours`), `pending` (messages piled up since, with `lastInboundTs`), `author`/`to`, the thread summary, `snippet`, `permalink`. `hours` is the minimum age (default 24); no `since`/`until` → the last 14 days (the result's `note` says so). |
| `stuck({days, project, status, assignee, source, limit})` | Open tracker tasks (status category `todo`/`doing`) whose **last activity** — `updated`, or a later comment — is at least `days` old (default 5), grouped by project then status, stalest first; rows carry `key`, `title`, `status`, `assignee`, `updated`, `lastActivity`, `daysSinceUpdate`, `due`, `url`, `ref` (for `get`). `truncated: true` when `limit` cut the list. |

**The subject.** Who "we" are decides what is inbound and what counts as an answer:

- default — the **account owner**: the people whose identities are the mail accounts the store was
  pulled for (`identities` ∩ `messages.account`; Slack accounts are team ids and never resolve, so
  the mailbox decides). The result's `subject` names them;
- `person` — one person, resolved like `search.person` (email, Slack id, name fragment);
- `side` — a **side**: company names and/or person ids from the people file, comma-separated;
  everyone whose `company` matches is "us". List the project's agent in `people.json` with the
  side's company and its replies count as the side's.

**Inbound** = a human message (`is_bot = 0`) not authored by the subject. In person mode it must
also be *addressed*: the subject is in `message_people` with role `to` — mail recipients, Slack
@mentions, DM/group-DM members (what the pullers write into `participants`; the account owner's
Slack identity must be in the people file for their DMs to resolve). A channel post that does not
mention the person is not addressed to them. A side is addressed when **any member** is — a message between two
people outside the side, or one addressed to someone else (Bluefin ↔ Bluefin in a shared channel, a question to a project's
own agent), is never inbound. `all: true` makes **every** message in scope inbound instead: the store
(a Slack allow-list, see *Tenant annotations*) or `container` IS the client scope — pass one, or the
list is the whole store.

**Answered** = the subject (any member of the side) wrote a later message that is *in the same
thread*, *in the same direct conversation* (DMs have no threads; the conversation is the thread),
or *addressed to the author within the same source* — a mail reply in a new thread (any folder), an
@mention in the same channel: how people answer outside the thread. A mention of the author in another
channel is not an answer. For an author the people file does not know, "addressed" is
matched on the raw address/label in the reply's `participants`. A reply posted in a channel without
a thread or a mention is **not** seen as an answer, and reactions are not stored — the tool says
so in its description, and the brief should treat such rows as "no written reply", not "ignored".
The window (`since`/`until`) applies to the waiting message, so a reply after `until` still closes it.

**Stuck** measures silence since the *last update of any kind* — `updated` as the tracker reports
it, or the newest comment timestamp if later — not time in the current status: the pullers do not
record status transitions. The SQL pre-filters on `updated` (a comment can only make a task newer),
the comment pass runs in JS. `status` takes a category (`todo`, `doing`) or an exact status name;
`project` a key prefix or project name; `assignee` resolves through the people file.

Worked example — the 18:30 close for owen-ops asks `unanswered({hours: 24})` and gets

```jsonc
{ "subject": {"mode": "person", "people": ["owen-hale"]}, "hours": 24, "since": "2026-09-30T…", "conversations": 2,
  "unanswered": [
    { "ref": "slack:T02J…", "container": "#bluefin-aven-caldora", "author": "client-user", "to": ["Owen Hale"], "ts": "2026-10-13T08:12:00.000Z",
      "ageHours": 31, "pending": 2, "lastInboundTs": "2026-10-14T07:40:00.000Z", "thread": {"n": 3}, "snippet": "@Owen Hale …", "permalink": "https://pedalix.slack.com/archives/…" },
    { "ref": "gmail:you@example.com:1a13…", "container": "inbox", "author": "konrad@…", "ts": "2026-10-12T15:02:00.000Z", "ageHours": 48, "pending": 1, … } ] }
```

and `stuck({days: 5})` returns `groups: [{project: "CG", status: "In Progress", n: 2, tasks: [{key: "CG-61", daysSinceUpdate: 9, …}]}]`.
The close quotes both lists with their permalinks and says which subject the readout used. For
Bluefin's own agent the same call is `unanswered({side: "bluefin"})` over a store scoped to the client
channels, and `stuck({days: 5, project: "CG"})` per initiative.

## Remote access

The agent never reaches the store itself: the bot answers its `sources` calls over the session
channel, wherever the sandbox runs (Daytona on another host included). What *Remote access* is about
is the other hop — a store that does not live on the bot host. `orch sources serve` is that store's
HTTP face:

```
orch sources serve <slug> [--listen 127.0.0.1:3415] [--db <replica>]     # SOURCES_SERVE_TOKEN required
```

`src/sources/serve.ts` serves the SAME tool table — `snapshot/plain/sources-mcp.mjs` is imported and
its `handleMessage` answers every POSTed JSON-RPC message — over MCP streamable HTTP, stateless:
`POST /mcp` with a message (or a batch) → `application/json`, a notification → `202`, no SSE stream
(`GET /mcp` → 405), no session id, no server-initiated messages. The DB is opened per call, so a
replica swapped by a build is picked up at once; `stats.meta` is the live `sync_state`. `GET /health`
(no token) says whether the replica is present. A static bearer (`SOURCES_SERVE_TOKEN`) is checked
constant-time on every call; without the variable the command refuses to start.

**Today** a project may point its own `sources` MCP entry at such a listener (directly or behind the
gateway) — then the sandbox calls that url and the bot registers no `sources` server for it:

```jsonc
"mcp": [{ "name": "sources", "url": "https://<gateway-host>/gw/<slug>/mcp", "auth": "gateway-m2m" }]
```

**The daemon** (OpenSpec `sources-daemon`) puts ingest and this face in one process where the data
lives, and the bot forwards to it — the sandbox keeps talking only to the bot, and the bot host holds
neither the store nor the source tokens:

```
orch sources daemon [--listen 127.0.0.1:3416] [--only <slug,…>]       # SOURCES_DAEMON_TOKEN required
```

- `POST /mcp/<slug>` — the same stateless JSON-RPC face, routed by slug; `GET /status/<slug>` — the
  sync state, the replica's raw-record count, what the tenant ledgers say is due today, the replica's
  age, recent alerts, the last auth check. Both need the bearer; an unserved slug is 404; `GET /health`
  is open and says only `ok`.
- The bot side is one block per project: `"sources": { …, "daemon": { "url": "http://10.0.0.5:3416",
  "tokenEnv": "SOURCES_DAEMON_TOKEN" } }`. The bot forwards every `tools/call` to `<url>/mcp/<slug>`
  (initialize and tools/list it answers itself: the table is static, so a session opens while the
  daemon is away; a call it cannot forward is a tool error the agent reports in one line), and reads
  `<url>/status/<slug>` every minute for `/aven status`, the empty-slot skip and the ops alerts. A
  status older than three minutes is not trusted: the slot fires.
- `infra/prod/coach-aven-sources-daemon.service.tmpl` is the unit (it replaces the per-slug
  `coach-aven-sources.service.tmpl`); `infra/prod/nginx-sources.conf.example` the TLS snippet when the
  bot reaches the daemon over a public name.

## Task trackers

YouTrack, Jira and Asana are one family: same contract (`auth check|add`, `pull` with a cursor on
`updated`, pure `normalise` with tests), one normalised shape — `task` (`src/sources/trackers/task.ts`):

`{source, account, id, key, title, status, statusCategory: todo|doing|done, assignee, reporter, due,
created, updated, project, url, labels[], text, comments:[{author, ts, text}], deleted?}`

`assignee`/`reporter` are e-mails where the tracker exposes them, else `youtrack:<login>`,
`jira:<accountId>`, `asana:<gid>` — add those strings to a person's `identities` in the people file
to join them. Raw files are `raw/<kind>/<account>/tasks.jsonl` + `cursor.json`; the store gets a
`tasks` table and `tasks_fts` (title, description, comments) with the same tokenizer and the same
"deleted means gone from the index" triggers.

The cursor is **inclusive** (`updated >= max(updated)`, minute-granular in Jira), so the rows at the
cursor come back on every pass for ever — with overlap 0 just the same. `cursor.json` therefore keeps,
beside `updated`, `hashes`: id → sha256 of the scrubbed line last appended, for the ids the last
successful pass returned (bounded by construction). A byte-identical row is not appended again; cursor
and map move together, only on success. Raw tracker files used to grow ~5 MB/day on the home bot from
7 Jira + 2 Asana rows re-appended every 16 minutes.

```jsonc
"sources": {
  "youtrack": { "url": "https://acme.youtrack.cloud", "tokenEnv": "YOUTRACK_TOKEN",
                "projects": ["CG", "CAR"], "assignee": "Owen", "since": "2026-09-15" },
  "jira":     { "site": "acme.atlassian.net", "fromNetrc": true, "since": "2026-09-15" },
  "asana":    { "workspace": "7520977444554", "projects": ["1208573315693393"] }   // projects: tasks there assigned to me OR following me
}
```

| Tracker | Credentials | What is pulled | Limits |
| --- | --- | --- | --- |
| YouTrack | permanent token: `tokenEnv` (reuse the bot's `YOUTRACK_TOKEN`) or `youtrack.json {token}` via `auth … youtrack add` | per project, `updated` since the cursor; with `assignee`, only issues that person is assigned to, reported or commented on. Query verified on Cloud: a parenthesised OR group needs explicit `and`, the keyword is `reporter:` (not `by:`), and no `sort by:` after a group | paced 5 req/s |
| Jira Cloud | e-mail + API token: `fromNetrc` (the host's `machine <site>` entry) or `jira.json {email, token}` via `auth … jira add --email …` | `POST /rest/api/3/search/jql` (the enhanced search; `nextPageToken` paging); default JQL "involves me" (assignee/reporter/watcher/comment), a configured `jql` replaces it, `updated >=` is always ANDed. ADF → plain text | paced 4 req/s, `Retry-After` honoured |
| Asana | PAT: `asana.json {token}` via `auth … asana add` | `GET /tasks?assignee=me&workspace=…&modified_since=…` (search is premium-only) plus, per `projects` gid, `GET /tasks?project=…&modified_since=…` **kept only when the task is assigned to me or lists me as a follower** (Asana adds every @mentioned user as a follower, so a colleague's task that mentions me arrives, the rest of the board does not); `me` is resolved once per pull via `/users/me` (or the configured gid / e-mail). Comment stories per kept task. Status = board section, `completed` → done | 150 rpm free tier → paced at 450 ms |

Scrubbing: description and every comment go through `scrubForWrite` separately, so one comment
with a DSN withholds that comment (filed in the vault), not the whole ticket; titles are redacted
inline. Secrets come in through `--token-env NAME` or stdin, never argv.

The `sources` MCP server learns trackers too: `search` covers tasks (hits carry `kind: "task"` and
a status; `source: youtrack|jira|asana` narrows to them), `get` returns a ticket with its comments,
`stats` counts tasks per source with the open share, and a new tool **`tasks({assignee, status,
dueBefore, project, source, updatedSince, limit})`** is the work list — open tasks by default,
soonest due first. Every row carries `lastComment {by, at}`, and with `updatedSince` also
`commentsSince {n, authors}` (computed from the stored comments at query time), so a morning brief
can say "Rowan: 2 comments on AWS billing alerts" without a `get` per task.

## Meetings

`sources.meetings` adds recorded calls as a fifth shape (`src/sources/meetings/`), one record per
call: `{ source: granola|gmeet|wispr, account, id, title, start, end, attendees: [{email, name}],
summary, next_steps: [...], transcript, url }`, raw at `raw/meetings/<provider>/<account>/meetings.jsonl`.
Summary and transcript are scrubbed separately — a password read out loud withholds the
transcript (marker + vault) and keeps the summary. Each provider's cursor remembers the version of
every note it wrote, because recorders keep rewriting a note after the call.

```jsonc
"meetings": {
  "granola": { "since": "2026-10-01" },          // Personal API key: orch sources auth <slug> meetings granola add
  "gmeet":   { "accounts": ["you@example.com"] }, // Gemini "Notes by Gemini" docs via the google token (drive.readonly)
  "wispr":   { "since": "2026-10-01" }           // device-code login: orch sources auth <slug> meetings wispr login
}
```

- **Granola** — Personal API (`public-api.granola.ai/v1`, Business/Enterprise plans), token in
  `granola.json`. Paced to 4 rps; a note still processing (404) is retried next run.
- **Gemini in Meet** — Drive search for `… – Notes by Gemini` docs, exported as text/plain; the
  doc name carries title and local start time, the doc carries summary, next steps and (when
  transcription was on) the transcript tab. The "Notes:" mail repeats the doc and is not used.
- **Wispr Flow** — no REST API and no personal token. The one programmatic door is the remote MCP
  server `https://api.wisprflow.ai/connect/mcp`, and it IS headless-capable: its authorization server
  `https://mcp-auth.wisprflow.com` advertises dynamic client registration, the device-code grant and
  `refresh_token` with `offline_access` (verified 2026-10-09 against its RFC 8414 metadata; a
  registration + device authorization round-trip worked). `wispr login` registers a public client
  once, prints a verification URL + code to approve in a browser (Google/Apple/Microsoft/SSO — Wispr
  email+password logins cannot authorize MCP), and stores `{client_id, refresh_token}` in
  `wispr.json`. The pull refreshes (rotated refresh tokens are rewritten), opens an MCP session and
  calls `search_meetings` / `get_meeting` (transcript paged by `start_char`).

The `sources` tool gains **`meetings({since, until, person, source, limit})`** — one row per call
with the summary's first ~900 chars (`summary_truncated` when cut), next steps, transcript size and
every copy's `speakers`; without `since`/`until` it shows the last 14 days, 20 calls by default.
`search` returns call hits as `kind: "meeting"`. `get` on a meeting ref is *compact*: full summary,
next steps, attendees, `transcript_chars`, `speakers`, the call's attributions and every copy side
by side — never the transcript, which **`transcript({ref, q, offset, limit})`** pages (a 90k-char
call used to arrive in one `get` and overflow the tool-result cap). `speakers` is judged from the
transcript's own labels at query time: `me-them` (Granola's microphone-vs-speaker split,
attribution-grade), `names-diarized` (Wispr, Gemini — diarization guesses that swap turns),
`anonymous` ("Speaker N" only) or `null` (no labelled lines, e.g. withheld). Quotes from a
names-diarized or anonymous copy are marked unverified unless a me-them copy confirms the speaker.

### Calls: one conversation, several recorders

Running Granola, Gemini in Meet and Wispr at once (normal while migrating between recorders)
yields up to three `meetings` rows per real call. Every build regroups them (`src/sources/calls.ts`,
`calls` table + `meetings.call_id`): two copies are the same call when their windows overlap by
more than half of the shorter recording; a copy never joins a call that already has one from the
same recorder (back-to-back Granola notes stay two calls); several candidates → shared attendees,
then title words, then overlap decide. A copy with no end time counts as 30 minutes. The primary
copy is the highest-priority recorder that has a transcript — Granola, then Wispr, then Gemini
(Granola's Me/Them labels are attribution-grade, the others diarize and swap turns) — and among
equals the longer transcript; a transcript under 200 chars does not count (a withheld one is its
60-char marker, which must not make that copy primary), and copies without one fall back to the
richest summary. The call title is the first real title among the copies ("Instant meeting"
loses). `meetings` lists one row per call with `sources` (each copy's ref, transcript size and
`speakers`) and the next steps of every copy merged; `search` collapses copies; `get` on any copy
returns the call with each recorder's summary, next steps and `speakers` side by side — the place
to compare recorder quality; `transcript` takes any copy's ref.

### Bots and Slack names

`messages.is_bot` marks integrations: the Slack puller's own flag (`bot_id`, `bot_message`, a
users-map bot), known app names (Intercom, monto-webhook, Sentry, Gleap, Zapier, …) and no-reply /
notification mail senders (`src/sources/bots.ts`). Slack DMs and authors still carrying a raw user
id are renamed at build from `raw/slack/slack.users.json`; the puller asks `users.info` for ids
`users.list` does not return (Slack Connect guests, deactivated accounts). A better users map or new
bot rules relabel every stored row on the next build (they are part of the derived fingerprint).

## Local activity

The review session runs in the sandbox and cannot see the host's git repos or Claude Code
transcripts, yet most of "where did my day go" is exactly that kind of work. The `local` source
pulls it like any other source (no credentials — it reads the bot's own filesystem):

```json
"local": {
  "roots": ["/home/me/code"],
  "authors": ["Jane Doe", "jane@example.com"],
  "claudeProjectsDir": "/home/me/.claude/projects",
  "since": "2026-10-01"
}
```

- **git**: repos under `roots` (depth ≤ 4, worktrees included), commits by any of `authors` on any
  branch. Commits ≤ 90 min apart form one block, +20 min lead-in for the work before the first
  commit, a lone commit counts 20 min. Container = `host/owner/name` from `origin`, so clones and
  worktrees of one repo collapse. Items = `sha subject`.
- **claude**: every transcript line carries a timestamp; activity is clustered per working
  directory per local day (gap ≤ 60 min, min 10). A cwd inside a repo gets that repo's container.
  Items = the first real prompt of each session (200 chars). Files > 50 MB are read head + tail.
- Blocks are bucketed by local day in `AVEN_TZ`. A day is recomputed in full whenever anything in
  it changed; a block that disappears (a new commit merged two blocks) is tombstoned. Titles and
  items are scrubbed inline (a pasted token in a prompt is redacted, never withheld).
- Raw: `raw/local/activity.jsonl` + `cursor.json`. Store: `activity` + `activity_fts`. The
  sandbox tool `activity({since, until, container, source, q})` lists blocks oldest first;
  `stats` counts them per source.

## Tenant annotations

`sources.tenant: { repo, ref?, path? }` names the project's own repo of decisions (default path
`annotations/`). Before every build the bot fetches it into `data/<slug>/tenant/` (shallow, hard
reset, GitHub token passed as a one-shot header — never in a remote URL or `.git/config`); a fetch
failure keeps the previous checkout and is logged, never fatal. The bot only **reads**:

- `annotations/people.json` — people, identities, markers (above);
- `annotations/fragments.jsonl` — append-only, last line per `id` wins, `superseded` ignored:
  `{ id, kind: call|thread|work, start, end, refs: [...], attributions: [{initiative, share}],
  decided_by: rule|model|owen, rule_id?, rationale, decided_at, status: decided|escalated|superseded }`.
  `refs` are store refs (`source:account:id`) or the account-free shorthand `meeting:<source>:<id>`.

Decided fragments become `attributions(ref, initiative, share, fragment_id, decided_by)`.
`search(initiative=…)` filters by them (a prefix covers sub-initiatives: `hcg/simplify` matches
`hcg/simplify/p1-…`) and nothing else — people no longer imply an initiative. The tool
**`fragments({since, until, initiative, status})`** lists the decisions themselves. Who decides is
the tenant's business (its review session in the sandbox commits these files); the bot indexes.

## Attribution

The tenant's attribution plan is computed in the store build, from the tenant's own data, and served
by the `attribution` tool (OpenSpec `attribution-layer`; `src/sources/attribution/`). It is the
deterministic half of a review session: which initiative each piece of the subject's day belongs to,
and what is left for a judgment. No tenant code runs on the host and no file reaches the sandbox.

**On** when the tenant ships `annotations/attribution.json`:

```json
{ "subject": "<person_id>", "since": "2026-10-01",
  "threadGapMinutes": 45, "substance": true, "admin": { "<umbrella>": "<umbrella>/<umbrella>/admin" } }
```

**Inputs** (all tenant data): `initiatives.json` at the tenant root — routing keys per initiative
(`repos`, `local_paths`, `calendar_title_patterns`, `slack_channels`, `teams_channels`, `jira_keys`,
`youtrack_prefixes`, `alias_of`, `split_into`); `annotations/rules.json` — `{id, when: {person,
container, title_re, repo, project_key, source}, then: {initiative | candidates}}`; people markers
(`annotations/people.json`); the ledger (`annotations/fragments.jsonl`).

**Fragments**: the subject's calls (one per summary topic, weighted by the topic's share), runs of the
subject's own messages per container (a gap over `threadGapMinutes` ends a run), and work blocks from
`activity`; greeting-only runs attach to the adjacent call with the same counterpart or drop. Ids depend
only on the records, so decisions recorded against an id stay attached across rebuilds.

**The ladder**, strong to weak, stops at the first rung that decides: tenant rules (a `candidates` rule
stops it with exactly that choice set), exclusive markers, registry routing (repo/path, channel, tracker key,
calendar title), the admin bucket (money, contracts, visas → the counterpart umbrella's `admin` initiative),
narrow markers (broad people only add hints), broad markers. It never guesses: several registry hits are
candidates, and so is a channel two initiatives list. Admin keywords match whole words with explicit
inflections (`vat` no longer fires on "private", `договор` not on "договорились"); calendar title patterns of
five characters or fewer match whole words; channel entries may be `{id, name}` objects and match by id first.
Each decision carries its rung's graded confidence (repo/path .99, tracker key and tenant rule .97, exclusive
and channel .95, a single title hit .80, admin .75) — the ladder decides exactly as the rung says; the
learning loop reads the confidence (OpenSpec `ingest-learning-loop`).

**Call participants** (`participants.ts`): every recorder copy of a call — the copies the store's call
clustering joins (`meetings.call_id`) are one call — contributes its attendees by name as well as by address
(a person's own name counts as an identity unless two people share it), glued Gemini invitee strings are split
against the roster, the linked calendar event (start ±15 min, equal title) adds its attendee addresses and the
transcript adds its speakers. A run of messages adds the recipients the store recorded (`role = 'to'`).

**States**: `decided` (the ledger has a decision — it always wins, matched by id or, for message runs,
by overlapping refs), `escalated` (the ledger has an open question), `rule` (the ladder decides it now),
`open` (candidates + hint for a judgment). Rule proposals come from recorded judgments: a person (not a
broad marker) or a container whose judged fragments are at least 90 % one initiative, three or more.

**Pins**: a `rule` decision is live while its day is open — the evening review and the next morning see
the current rules — and is pinned once the day has closed (`pinAfterDays` full days after it ended, default
1): decided once, with the rule id and the rules version (hash of rules, registry and people markers), in
`data/<slug>/attribution/pins.jsonl` on the bot host — outside the store, which is rebuilt at will. A rule
changed later does not move a pinned day; a judgment in the ledger still wins over a pin. The readout marks
pinned rows (`pinned: {at, rules_version}`). `orch sources attribution redo <slug> --since D [--until D]`
unpins a window (days in the tenant's zone); the next build decides it with the current rules.

**Timelog**: `timelog({since, until})` — the subject's minutes per local day and initiative, computed at
query time from the plan (decided, pinned and rule decisions), with the owen-ops CLI's merge rules: calls
count in full (topics by share), message runs and work blocks are unioned per initiative minus call time,
split aliases distribute by weight, open work in a shared repo follows the one candidate active that day,
and unattributed time is its own row (`confidence: open | escalated`, with candidates). `parallelSessions`
in attribution.json: `sum` (default) or `wallclock` (parallel work scaled so a day never exceeds
wall-clock; calls untouched). Default window: this month so far.

**Identities**: `identities()` — who is who for the tenant's people file, recomputed by every build with the
plan: `merges` (unmapped identities that deterministically belong to a known person: the same full name in any
order, a mailbox that is the glued full name, a unique first name seen together with the person or under their
domain/company), `questions` (yes/no with the best guesses once the identity talked with the subject at least twice
or in a direct chat; "who is" for an unknown seen at least five times with them; most-seen first, capped at 50,
stable ids) and `counts`. System senders and opaque ids are counted, never asked. The tenant applies merges to its
people file and asks a few questions per run, deduped by id — the platform writes nothing into the tenant repo.

**Commitments**: `commitments({since, until, owner?})` — the next steps of the recorded calls of those local days:
every recorder copy's steps parsed per recorder (Granola "step (Owner)", Wispr "(Owner) step", Gemini "[Owner] step"
until "Details"), unioned per call and deduped by text, as rows `{id: c-<hash(call|text)>, owner, to, what, call,
provenance}`. `owner` is the subject's person id when the step names one of their names or addresses (the people
file, plus "me"); `to` is the single other attendee of the subject's steps. `owner: "subject"` filters to them.
Proposals only: due dates and initiatives are a human's.

**Budgets**: `budgets` in attribution.json — the billing frames the timelog is reconciled against, one per
umbrella: `{umbrella, unit: hour | half_day, unitMinutes?, perMonth?, overrides?: {YYYY-MM: n}, by?: initiative |
billing_code}`. With budgets, every `timelog` answer carries `reconciliation` for the month of `until` from its
first day, whatever the window: per budget the units used (half-days rounded to 0.5 per breakdown key and then
summed, hours rounded to 0.1 on the total), the month's cap (an override wins) and what is left, plus minutes
per umbrella, non-billable time (routed initiatives without a billing code) and unrouted time. It never bends
the minutes; a model quotes it and never recomputes it.

**Recompute**: at every build that consumed new lines or saw a tenant file change (and at least hourly,
since the horizon ends today), over `since` to today in the tenant's zone (`sources.timezone`; the table stores
UTC instants only, the tool turns the asked days into UTC bounds and labels each row with its local day) — 389 fragments of 15 days in
under half a second on the home store. A broken tenant file keeps the previous tables and is logged.

**Parity** with the owen-ops CLI it was ported from (2026-10-15, four days of the real store): the same
ids, the same `decided` / `rule` / `open` sets and the same initiatives; the one difference — a work block
just after local midnight that the CLI's UTC-day load window never saw — is the platform being right.

### Item mode

`"items": {"days": 30}` in attribution.json turns on the **item floor**: every message, task, comment and
meeting of the last N local days gets a row in `att_items` (`items.ts`), read with
`attribution({unit: 'item', since, until})` — the call without `unit` answers exactly as before. Per item:

- **sender class** — human, bot, bulk (one-way mail from an unresolved sender the subject never wrote to) or
  system (role mailboxes), one merged list instead of `bots.ts` and the identities collector disagreeing;
- **repeat cluster** with its weakest-edge confidence — exact repeats, alert episodes (a firing, its repeats
  and its resolve), companion bot posts, cross-posts, forwards, tracker mail ↔ ticket — and a **family** (sender
  + text template + host/app token), the key a label can be reused under. A human item never joins a bot
  cluster; a scrub placeholder alone never makes two items equal;
- **initiative** with its rung and confidence, or candidates: the item's own tracker key, a reply inheriting
  its decided root, a host or app listed in the registry (`sources.hosts`, `sources.apps`), an unknown host in
  a channel with a closed host list → `unregistered`, keys in the text, tenant rules, registry channels, a
  bulk sender → `none`;
- **kind** when structure decides it (bot, bulk and system senders, small talk → `noise`) and the
  **addressee** (explicit, a vocative first name, the parent's author for a reply, `none` for integrations).

## Learning loop (shadow)

People's answers teach the attribution layer, deterministically and only as data
(`src/sources/attribution/learn.ts`, the pure learner; `learn-load.ts`, what it reads and writes). **On** when
attribution.json says `"learn": {"mode": "shadow"}` (optional `questionsPerDay` 0–50, default 3; `auditShare` 0–1,
default .15; `siblingAware`, default true); absent = off, and the next build clears what an earlier one stored.
No model anywhere: a model may word a question or pre-fill its guess in the sandbox, never decide or teach.

**What an answer becomes.** One line in the tenant repo, nothing else — the store keeps no learning state:

- **Fragments**: a line of `annotations/fragments.jsonl` a person decided — `decided_by: "owen"` (the owner's
  literal) or `"human:<person_id>"` — with `status: "decided"`. Optional fields record the question:
  `answer` (its id: the lines of one answer are ONE observation, however many units it covered), `guess` (what the
  machine proposed before the answer, or null), `conf` and `rung` (its confidence and rung instance), `audit: true`
  (a re-check of an auto-decision). Without `answer`, a call's topic lines decided at the same `decided_at` count as
  one answer (one override of a call), any other line as its own. The plan reads a `human:<id>` line exactly as
  before (as `model`); only the loop reads the decider.
- **Items** (item mode): a new file `annotations/labels.jsonl`, one line per answered item:
  `{ref, task: "t1-item", label, by: "human:<person_id>", answer, audit?, guess?, conf?, rung?, at}`. The last line per
  task × ref wins; `status: "superseded"` withdraws it. A line by anyone but a person (`by: "model"`, `"rule"`) is
  kept in the file and never read as evidence.
- **Seeds**: none yet.

Labels are compared alias-resolved, a split alias spread into its targets (the top share is the label). **Never
evidence**: the ledger's `rule` and `model` lines, pins, the floor's decisions, the loop's own output, a model's guess
— on the bench, feeding the loop's own decisions back took its weekly precision from 100 % to 81 %.

**Audits.** Every build draws the day's audit sample from the units the loop would auto-decide today: seeded by the
day (every build of a day draws the same units), its size accruing `questionsPerDay × auditShare` per day from the
first answer on (one about every second day at the defaults). The routine re-asks them; the answer line carries
`audit: true` and what the machine said (`guess`, `conf`, `rung`). Auto-decided units are never asked otherwise, so
audits are the only unbiased look at the machine's own precision — the one way a stale rule or a registry error
reaches the calibration.

**What the daemon derives, every build, from scratch** (a pure function of the store and the tenant: deleting the
store and rebuilding reproduces it): per unit — every fragment of the horizon, every item of the item window — the
floor's OWN say (the ladder alone, without the ledger or pins: label, graded confidence, rung instance such as
`rule:<id>`, `excl:<person>`, `channel:<id>`, `key:<PREFIX>`, `title:<pattern>`, `repo:<repo>`, `host:<h>`), its case
(a call, a run-day, a family-day, a ticket) and its typed keys (fragments: recurring call series, run container,
counterpart set, rare title words, structure-decided work next to it; items: thread, alert family, host, app, mail
subject and domain, channel, sender, rare subject words). From the answers, replayed in day order: key tables (a key
predicts once it holds k agreeing answers; two labels end it) and each key type's measured reliability (a Beta prior,
moved by every prediction a person then checked); the calibration of every rung instance (prior Beta(20c, 20(1−c)),
moved by answers and audits on its units; an instance that decided on its own and falls below τ = .95 is
**demoted** — its units become questions with its label as the guess); **sibling-aware trust** — a structural rung
(rule, exclusive marker, channel, tracker key, title) of a client that runs other active initiatives decides the
client, the initiative only when the unit's own text carries a cue of it and none of a sibling's (or answers on the
route confirm it), else it asks; the ranked question queue (per client and day, a learnable key, or the case), the
audit sample, and rule candidates (keys people confirmed three times). Each answered unit shows what the loop said
BEFORE its answer, so `agreement` is an honest check.

**Shadow vs live.** Shadow computes all of that, stores it (`att_learn`: per unit label, conf, rung, the question it
would ask, audit; the `att:learn` meta: counts and tables) and shows it — and nothing else reads it: the plan, the
pins, the timelog and the initiative index are byte-identical with the loop on or off (checked on the real store),
and the `attribution` answer without `learn: true` is unchanged. **Live** is not built: the plan would take the loop's
decisions at τ and pin them with a calibration version beside the rules version — after at least two days of shadow
on the canary and its own rollout row.

**Readout**: `attribution({since, until, unit, learn: true})` adds `learn` — per unit of the asked days and kind
`{id, day, label, conf, rung, ask?: {group, value, guess, form}, audit?}`, plus `counts` (the floor at τ, the loop at τ,
`promoted`/`held`/`relabelled` against the floor, asked, questions, audits, evidence), `agreement` (on answered units:
how many the floor and the loop would decide and how many of those carry the answer), `calibration` per rung instance,
`key_types`, today's ranked `questions`, the `audits` and `rule_candidates`. Cost on the owner's store (388
fragments): about 0.1 s per build; with item mode's 7,272 items, about 1 s more.

## What comes next

| Slice | Adds |
| --- | --- |
| ~~PR-B sources-store~~ | shipped: the store and the replica above (the automatic mount it added was retired by `host-tools`) |
| ~~PR-C sources-poller~~ | shipped: the poller below |
| ~~PR-D sources-mcp~~ | shipped: the `sources` MCP server above |
| ~~sources-tasks~~ | shipped: the task-tracker family above (YouTrack, Jira, Asana) |
| ~~meetings + tenant annotations~~ | shipped: recorded calls and the tenant's attribution loop above |

Each pull ends with the store build, so the replica the sandbox sees is never older than
the last pull. The CLI stays for bootstrap, backfills (`--since`, `--full`) and audits.
