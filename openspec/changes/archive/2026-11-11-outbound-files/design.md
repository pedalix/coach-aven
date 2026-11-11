# Design

## Context

See proposal.md — Why. What exists today:

- **Inbound only.** `src/attachments.ts` is the pure half (allowlist `isSupported`, `MAX_BYTES` 25 MB, `MAX_FILES` 10,
  `sanitizeName`, `inboxDir`/`inboxPath`, `planIngest`, `attachmentPreamble`, `skippedNotice`); `ChatSession.ingest`
  in `src/tasks.ts` holds the sandbox handle and writes `/root/inbox/<turnId>/`; `liveTurn` in `src/turn.ts` calls it
  before `live.ask`, prepends the preamble to the prompt and posts the deterministic skip notice. The base prompt
  (`src/prompt.ts`) tells the agent about `/root/inbox/<turn>/` in one sentence.
- **The sandbox handle** (`src/driver.ts`) has `exec` and `uploadFile`, nothing that reads a file back. ssh-docker's
  `run` collects stdout as a string.
- **The chat driver** (`src/chat/driver.ts`) posts views (`post`/`update`) and fetches inbound files (`ChatMessage.files()`);
  there is no outbound file method. `DriverCapabilities` already tells the shared texts what a platform can do.
  Slack output is pinned by recorded call snapshots (`src/fixtures/chat/`); the twin's `RecordingApi` answers any Web
  API method with `ok: true` plus canned fields. The Slack manifest grants `files:write`/`files:read`, and the
  production token carries both (checked 2026-11-11).
- **The web** stores uploads beside the conversation (`src/chat/web/files.ts`: `storeUpload`, `findUpload`) and serves
  them through `GET /files/:slug/:id` with the session and a folder check; the driver appends stored views to the
  history and the page renders them.
- **Teams** has no cheap outbound path: a channel file goes through Graph into the team's SharePoint, a 1:1 file
  through a consent card; an Adaptive Card's data-URI image is capped far below a screenshot.
- **Concurrency:** several conversations of one project share one sandbox and run turns at the same time.
- **Answers** are scrubbed at the model boundary (`scrubText`, `ClaudeSession`, honouring `ProjectConfig.scrubSecrets`).

## Goals / Non-Goals

**Goals:**
- The smallest end-to-end path from "the agent has a file" to "the person has it": one convention, one read, one post.
- Byte-identical behaviour with the flag off (snapshots and goldens prove it); nothing new for Teams.
- Reuse the inbound rules and helpers rather than a second allowlist.

**Non-Goals:**
- A channel from inside the sandbox to the bot (mid-turn posting, progress files).
- Public links, Teams delivery, files from idle/background results — see proposal.md — Out of scope.
- A sandbox-driver interface change.

## Decisions

### D1. An outbox directory per turn, read when the turn ends

`/root/outbox/<turnId>/`, the mirror of the inbox. The engine pulls it once `live.ask` has returned and the answer is
delivered (D7), then removes it.

Why per turn and not `/root/outbox/`: turns of different conversations of one project run concurrently in the same
sandbox; a shared directory would hand one conversation another's files. The turn id is already the inbox key.

Why at the end of the turn: the bot has no way to learn mid-turn that a file appeared (no mounts, no server in the
sandbox — doctrine), and the end of the turn is the one moment the bot reads the sandbox anyway. A mid-turn
`post_file` tool would need a sandbox-to-bot channel (an MCP server the bot runs, or the messaging runtime); that is a
later change, and the convention here survives it (the tool would post the same directory early).

### D2. The read-back is `base64` over the existing `exec`

No new sandbox primitive. `src/outbox.ts` produces three scripts and parses their output: the listing (a POSIX
`for f in * .*` loop printing `<bytes>\t<name>` per regular file — the plain sandbox image is Alpine, whose busybox
`find` has no `-printf`; the first canary turn listed nothing for that reason), the read (`base64 -w0 <path>`, which
busybox and coreutils both take), the removal (`rm -rf <dir>`); `ChatSession.collectOutbox` runs them through
`sandbox.exec` and decodes. The listing decides admission before any bytes move, so an oversized file never transits.

Alternative: `downloadFile(path): Promise<Buffer>` on `SandboxHandle` with a bytes mode in ssh-docker's `run`. Cleaner in
the abstract, but it touches every fake that implements the handle (five test files and `memjournal.ts`) and the SSH
layer, for a payload the cap keeps at 25 MB (34 MB of base64 through a string). Not worth it now; if a second reader
of sandbox files appears, lift it then.

### D3. Admission reuses attachments.ts; the media type comes from the name

`planOutbox(entries)`: regular files only, name order, `sanitizeName`, `isSupported(mimeOf(name), name)`,
`MAX_BYTES`, `MAX_FILES`; empty files and subdirectories are ignored silently (nothing the agent meant to send),
refusals carry the same reason strings as inbound so one `skippedNotice`-style text serves both. `mimeOf` (extension →
media type) moves from `src/chat/web/files.ts` into `attachments.ts` so the web and the outbox share it. The sandbox
cannot tell us a MIME type; the extension is what Slack and the browser go by too.

### D4. Text files are scrubbed, binaries are not

A text-typed file (`text/*`, JSON, YAML, CSV, Markdown, logs) passes `scrubText` unless `scrubSecrets === false` on the
project — the agent holds repository contents and the sandbox holds tokens (`/root/.aven/gw-token-*`, git
credentials), and a "save the config for me" is one prompt away. Binaries go as written: the same gap the inbound side
and every screenshot already have. The spec says so, so nobody assumes otherwise.

### D5. The driver grows a capability and one method; no new view

`DriverCapabilities.outboundFiles: boolean` and `postFiles(to: ConvTarget, files: OutboundFile[]): Promise<void>` with
`OutboundFile = { name, mime, data: Buffer }`. Views stay untouched: a Slack upload is not a `chat.postMessage`, and
a new `MessageView` kind would have to render on every surface including Teams. The web driver appends its own stored
record kind for the page. The core uses the capability to decide whether to name an outbox at all (D6), so Teams needs
no "not delivered" text: an agent that was never told about an outbox writes none. (The earlier idea of a visible
"cannot deliver" note on Teams was dropped for that reason — it would only ever announce a file nobody asked for.)

- **Slack:** one `client.files.uploadV2({ channel_id, thread_ts, file_uploads: [{ file, filename }] })` per turn. The
  SDK runs `files.getUploadURLExternal` + a POST of the bytes + `files.completeUploadExternal`; the twin's
  `RecordingApi` gets a canned `upload_url` pointing back at itself and records the byte POST, so the snapshot pins the
  three calls and the `channel_id`/`thread_ts`. A marked conversation (agent-messaging D14) cannot carry message
  metadata on a file post, and the project's Slack source skips the bot's posts by that marker alone — so the engine
  uploads nothing there and posts a marked text notice naming the files instead (`outboxMarkedNotice`).
- **Web:** `storeUpload(filesRoot, conv, name, data)` into the room's (or the person's private) folder — the existing
  `GET /files/:slug/:id` then serves it with the same session and folder rules as an upload; the history gets a
  `{ t: 'post', files: [{ id, name, size, mime }] }` record and the page renders names with sizes, images as `<img>`
  on the same URL. The driver takes `filesRoot` as one more dep.
- **Teams:** `outboundFiles: false`; `postFiles` throws "not supported" (never reached by the core).
- **Shadow driver** (`src/chat/shadow/driver.ts`): journals the file names, posts nothing.

### D6. The agent learns the convention twice, briefly, and only where it works

- Base prompt, one paragraph after the inbox sentence: files for the person go to the outbox directory named in the
  message; what is posted (types, 25 MB, 10 per turn), that it lands right after the answer, *not* to paste file
  contents into the answer instead, and that a message naming no directory means "answer in text" (a private
  `/aven` ask, a routine's dream). The paragraph is per SESSION and per SURFACE: the engine opens a session with
  `outbox: true` only when the flag is on and the surface the key names delivers files (`sessionFor(…, { outbox })`
  → `openChat({ outbox })` → `buildPrompt({ outbox })`), so a Teams or shadow session gets today's prompt, byte for
  byte. The four existing goldens stay byte-identical (the flag-off proof), one new golden pins the paragraph.
- Per turn, one line in the message preamble: `Outbox for this turn: /root/outbox/<turnId>/ — files saved there are
  posted into this thread after your answer.` Only when the flag is on **and** `chat.capabilities.outboundFiles`. The
  line costs ~30 tokens per turn; the directory cannot be known any other way (the session prompt is static).

Routines go through the same engine, so a scheduled report can attach its chart; nothing special is needed.

### D7. Order and failure handling in the engine

In `liveTurn`, after `deliver(view, …)`: `collectOutbox(turnId)` → `postFiles` → notices, all inside a try that logs,
raises a Sentry issue (`captureError`, subsystem `outbox`) and posts `⚠️ Couldn't post <names>: <reason>` on failure;
anything else that throws in that block (a notice that could not be posted, a bug) is a Sentry issue and one
best-effort ⚠️ line too, so the person is never left guessing where the files went. The answer is already delivered,
the user's message already marked ✅; a failed upload must not flip the turn to an error (spec: *Delivery failure
never fails the turn*). Refused files are admission decisions, not failures: a notice, no log, no issue. Files
follow the answer so an answer saying "the chart is below" is true, and the status message does not show "Working…"
beside a finished file. A turn that went background posts its answer as a new message; the files follow it the same way.
A turn recovered after a restart too: the inflight record keeps the turn id (`inflight.turnId`), and the recovery
runs the same pull after the recovered answer; a record written before the field has no id and posts nothing.

### D8. Flag and config

`OUTBOUND_FILES=1` read in `src/config.ts` → `cfg.outboundFiles`, handed to the turn engine (the per-turn line and the
pull), the prompt builder, and the Home renderers (`homeBlocks` gets `opts.outboundFiles`, the web home the same).
Bucket 3; the flag is a rollout stage: canary → prod `.env` → default → retire.

### D9. The capabilities table is rendered from code and pinned by a test

`DriverCapabilities` has had no reader in the core until now; `outboundFiles` gives it one, and the question "where
is this implemented" needs one answer. `src/chat/capabilities.ts` renders a markdown table (one row per capability,
one column per driver) from the drivers' declarations — each driver exports its capabilities as a constant or a
function of its options (`teamsCapabilities(opts)`, whose `threadRepliesNeedMention` is configurable and shown as its
default with a note). `docs/chat-drivers.md` carries the table between two marker comments; `src/chat/capabilities.test.ts`
renders it again and fails when the document differs — the same way the Teams and web Home tests pin the verbs. The
docs index links the page under *Run an installation*. The parity matrices in `docs/teams.md` and `docs/web.md` stay:
they are prose for people about how each surface feels; the table is the contract.

Alternative: generate the page from a script (`docs/commands.md` is generated from the Home tab). A test that compares
is the same guarantee with no build step; the renderer is pure and three lines of markdown.

## Risks / Trade-offs

- [A marked conversation's file post carries no `aven_marked` metadata — `files.completeUploadExternal` has no
  metadata parameter — and the Slack source keys on the marker alone (`sources/slack/normalise.ts`)] → no upload in
  a marked conversation: a marked text notice names the files (D5); the bytes stay in the sandbox.
- [`mimeOf` moved into `attachments.ts` and learned `html`/`htm` for the outbox; the web's upload check uses the same
  map, so a `.html` upload on the web is now accepted (it answered 415 before)] → declared, not gated: Slack's inbound
  side accepts `text/html` already, the file is served as an attachment with `nosniff`, and the web surface runs on
  the canary installations only; noted in the ledger row.
- [Base64 over `exec` holds up to ~34 MB in a string per file] → the listing refuses over-cap files before reading;
  ten files are read one at a time.
- [The agent writes to the outbox from a background Task that finishes after the turn] → the directory stays until
  the sandbox is recreated; nothing is posted, nothing breaks. Idle results are out of scope; a housekeeping sweep of
  `/root/outbox/*` older than a day can follow if it ever matters.
- [Slack Connect: an upload into an ext-shared channel is shared with the other organisation like any file] → that is
  the point; the admission is the same as for what the agent says in text.
- [A sandbox image's tools differ (busybox on the plain Alpine image, coreutils on the laravel one)] → the scripts use
  POSIX shell, `wc -c`, `base64 -w0` and `rm -rf` only, verified in both; the listing script's test pins the command.
- [Scrub false positives mangle a CSV] → the same trade-off answers accept; the project's `scrubSecrets: false` exists.
- [Slack's file uploads are ~2 s per file] → ten files add seconds after the answer, visibly; acceptable.

## Migration Plan

1. Merge with the flag off (nothing changes anywhere; snapshots and goldens prove it).
2. Home: `OUTBOUND_FILES=1` in `~/coach-aven-home/.env`, recreate; ask a project for a chart as PNG in Slack and in the
   web chat. Staging: the flag on exercises the web surface (Teams stays silent by design).
3. Prod `.env` as its own step after the canary; ledger row dated.
4. Rollback: unset the flag and recreate — no data to migrate; stale `/root/outbox/<turn>/` directories are harmless.

## Open Questions

None — the Slack source's handling of the bot's own posts was checked at apply (it keys on the marker), see Risks.
