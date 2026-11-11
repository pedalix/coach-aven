# Tasks

## 1. The pure outbox module

- [x] 1.1 Move `mimeOf` (extension → media type) from `src/chat/web/files.ts` into `src/attachments.ts` and import it back
      in the web; verify `npm test -- src/chat/web/files.test.ts src/attachments.test.ts` passes unchanged.
- [x] 1.2 Create `src/outbox.ts`: `outboxDir(turnId)`, `listScript(dir)` (a POSIX `for` loop with `wc -c` — busybox has no `find -printf`),
      `parseListing(stdout)`, `planOutbox(entries)` (regular files, name order, `sanitizeName`, `isSupported(mimeOf(name),
      name)`, `MAX_BYTES`, `MAX_FILES`, empty files and over-count ignored/refused per the spec), `readScript(path)`
      (`base64 -w0`), `removeScript(dir)`, `isTextFile(mime)`, `outboxPreamble(turnId)`, `outboxSkippedNotice(skipped)`,
      `outboxFailedNotice(names, reason)`; verify `src/outbox.test.ts` covers each spec scenario of *Outbound admission
      matches inbound* (unsupported type, eleven files, subdirectory/empty file) plus listing parse with tabs in names and
      the three scripts byte-exact.

## 2. Flag, prompt, config

- [x] 2.1 Read `OUTBOUND_FILES=1` in `src/config.ts` as `cfg.outboundFiles` (default false); verify `src/config.test.ts`
      asserts the default and the `1` value.
- [x] 2.2 `buildPrompt` gains `outbox?: boolean`; when true, one paragraph after the inbox sentence (what to save where,
      the limits, "lands right after your answer", "do not paste file contents instead"); verify the four existing goldens
      in `src/fixtures/prompt/` are byte-identical with the option off and a new `single-repo-outbox.txt` pins it on
      (`npm test -- src/prompt.test.ts`).
- [x] 2.3 Document the flag in `docs/runtime-config.md` (what it turns on, per surface) and verify the page's flag table
      renders with the new row.

## 3. The driver interface and the three drivers

- [x] 3.1 `src/chat/driver.ts`: `DriverCapabilities.outboundFiles: boolean`, `OutboundFile { name; mime; data: Buffer }`,
      `postFiles(to, files): Promise<void>`; Teams driver reports `false` and a throwing `postFiles`; shadow driver
      journals names only; verify `npm run typecheck` passes and `src/chat/imports.test.ts` still forbids SDKs in the core.
- [x] 3.2 Slack driver: `postFiles` = one `client.files.uploadV2({ channel_id, thread_ts, file_uploads })`; extend the
      twin's `RecordingApi` with a canned `upload_url` for `files.getUploadURLExternal` that points back at the stub and
      records the byte POST; verify a new recorded snapshot in `src/chat/slack/driver.test.ts` pins the three calls with
      `channel_id`/`thread_ts` and that `api.failures['files.completeUploadExternal']` makes `postFiles` throw.
- [x] 3.3 Web driver: `filesRoot` dep; `postFiles` stores each file with `storeUpload` into the conversation's folder and
      appends a `files` record (`id, name, size, mime`); the page renders name + size as a link to `/files/:slug/:id`
      and an `<img>` for image types; verify `src/chat/web/driver.test.ts` (record shape) and a server test that a
      second user's session cannot fetch a private conversation's file, and that the room file downloads with the
      session (`npm test -- src/chat/web`).
- [x] 3.4 `docs/web.md` files section and `docs/teams.md` files row say what each surface does with outbound files (Teams:
      not yet); verify by reading the two sections.
- [x] 3.5 Each driver exports its capabilities (`SLACK_CAPABILITIES`, `teamsCapabilities(opts)`, `WEB_CAPABILITIES`,
      `SHADOW_CAPABILITIES`); `src/chat/capabilities.ts` renders the markdown table; `docs/chat-drivers.md` carries it
      between marker comments and the docs index links the page; verify `src/chat/capabilities.test.ts` fails when a
      value in the document is flipped and passes as committed.

## 4. Session and engine

- [x] 4.1 `ChatSession.collectOutbox(turnId)` in `src/tasks.ts`: list → plan → read each accepted file (`exec`, base64
      decode) → scrub text-typed files with `scrubText` unless `scrubSecrets === false` → remove the directory; returns
      `{ files, skipped }`; verify `src/tasks.test.ts` (or a new `tasks.outbox.test.ts`) with a fake sandbox handle covers
      the scrub of a token in `debug.log`, the opt-out, the removal script after a successful read, and that a listing
      exit code ≠ 0 yields a `skipped` entry rather than a throw.
- [x] 4.2 `liveTurn` in `src/turn.ts`: when `cfg.outboundFiles && chat.capabilities.outboundFiles`, append
      `outboxPreamble(turnId)` to the prompt preamble, and after `deliver(view, …)` run `collectOutbox` → `postFiles` →
      `outboxSkippedNotice` / `outboxFailedNotice`, all best-effort; verify the recorded turn snapshots
      (`src/turn.*.test.ts`, `src/fixtures/chat/turn/`) are byte-identical with the flag off, and a new flag-on recording
      shows the answer first, then the upload calls, then no notice when nothing was skipped; a forced
      `completeUploadExternal` failure leaves the ✅ mark and posts the ⚠️ notice.
- [x] 4.3 Concurrency check: a test with two turns of one project (different turn ids) saving files proves each pull reads
      and removes only its own directory (`src/outbox.test.ts` for the paths, the turn test for the calls).

## 5. Home cheat-sheets

- [x] 5.1 Slack `homeBlocks(…, { outboundFiles })`: the *Share files* line adds that files can come back ("ask for a chart,
      a screenshot or a CSV and it lands in the thread") when on; verify the Home snapshot in `src/fixtures/chat/` is
      byte-identical with the option off and a new snapshot pins it on.
- [x] 5.2 Web home: the same sentence under the same option; Teams home unchanged; verify `src/chat/web/webhome.test.ts`
      and `src/chat/teams/teamshome.test.ts` pass (the verb lists are unchanged).

## 6. Rollout ledger

- [x] 6.1 Add the `docs/rollout.md` ledger row: change, PR, gate `OUTBOUND_FILES=1` (bucket 3), canary/prod/default
      columns empty, *What to watch*: a "send it as an image" ask in a project thread yields a PNG reply in the thread;
      verify the row renders in the table.

## 7. Integration

- [x] 7.1 `npm run typecheck && npm test` green.
- [x] 7.2 (done on the home canary instead of a preview, 2026-11-11: the web chat showed the PNG inline and the 📎 notice for a `.mov`) `npm run preview` with `OUTBOUND_FILES=1` on the scratch project: "draw a bar chart of 1, 2, 3 and give it to me
      as a PNG" → the image shows inline in the web thread and downloads with the session; "give me the repo's README as
      a .mov" → the notice names the unsupported type; verify by observation in the preview chat.

## Workflow follow-up

- Canary: `npm run ship -- home` after the merge, `OUTBOUND_FILES=1` in `~/coach-aven-home/.env`, recreate; the same two
  asks in a Slack project thread; date the ledger's *Canary since*.
- Staging, then prod `.env` as its own step with the owner's go; date the ledger.
- Archive the change with `/openspec-archive-change` after the merge; `openspec validate chat-driver-interface --type spec
  --strict` on the merged spec.
