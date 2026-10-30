# Design

## Context

The tracker family (`docs/sources.md` → Task trackers) is three connectors over shared plumbing: `trackers/http.ts` (one body read, pacing, `Retry-After`, 401/403 → `reauth`), `trackers/writer.ts` (`runTrackerPull`: cursor on `updated` − 5 min, scrub at write, byte-identical rows not re-appended, cursor moves only on success), `trackers/task.ts` (the `task` record). A connector supplies `fetchUpdated(from)` and a "who am I" check. The store ingests every `tasks.jsonl` under `raw/` (recursive walk, compaction by `source:account:id`), and the readouts (`tasks`, `stuck`, `search`, `get`) are source-agnostic SQL over the `tasks` table. See proposal.md.

Wrike REST v4 was probed read-only with a real user token before the design was fixed; the facts below that say "verified" come from that probe.

## Goals / Non-Goals

**Goals:**
- Wrike tasks in the same `task` shape, so every readout and the identity layer work unchanged.
- The tenant names the folders: an agency account holds every client, a tenant store holds its own.
- A folder added later gets its own history from `since`.

**Non-Goals:**
- Writes to Wrike, webhooks, attachments, time logs, custom fields.
- Tombstones for tasks deleted in Wrike or moved out of the folders (the other trackers have the same gap; a follow-up for the family, not for one connector).
- Several assignees per record (the store's `tasks` table has one assignee column).

## Decisions

- **Scope = folders, descendants included.** `GET /folders/{id}/tasks?descendants=true&subTasks=true` returns every task in the folder's subtree; a space id is accepted by the same endpoints (verified), so `folders` takes either. Alternative: an "involves me" filter like Jira/Asana — rejected, the watcher reads the whole client field (who is waiting, what is stuck), not one person's queue.
- **One cursor per folder, via an optional `scope` on `TrackerRun`.** Files and cursor live in `raw/wrike/<host>/<folder>/`; records keep `account = host`, so refs are `wrike:<host>:<id>` whatever folder listed the task. Alternative: one cursor per account (what YouTrack/Jira do for their projects) — a folder added to the config later would start at the others' cursor and never see its own history. Alternative: a per-folder map inside one `cursor.json` — would change the shared cursor format for every tracker. The `scope` keeps the unscoped path byte-identical.
- **Comments per task, all of them.** The store replaces a task row with the latest line, so a record must carry every comment, not only the new ones; `GET /tasks/{id}/comments` takes ONE task id (a comma list is 400 "Invalid Task ID", verified), so it is one call per updated task, as Asana's stories. `plainText=true` spares an HTML pass. A new comment moves the task's `updatedDate` (verified: equal to the last comment's `createdDate` to the second), so no account-wide `/comments` sweep is needed to find commented tasks.
- **Timestamps without milliseconds.** `updatedDate={"start":"…"}` answers 400 to `.000Z` (verified); `wrikeStamp` cuts them.
- **People as `Name <email>`.** Contacts come from `GET /contacts/{ids}` (≤ 100 per call, cached per pass; deleted users are answered, without e-mail). The readouts show `assignee_person || assignee_raw`, so a name reads better than a bare address when the people file does not know someone; `resolveIdentity` already joins the `<addr>` inside, the identity layer's `parseIdentity` reads both halves, and `tasks({assignee})` matches either by text. Fallbacks: e-mail, name, `wrike:<id>` (an id: the identity parser treats it as opaque).
- **The status group decides `done`.** Custom statuses come from `GET /workflows` (once per pass). Completed/Cancelled → `done`; Deferred → `todo` (parked but open, like "On hold" elsewhere — it should surface in `stuck`); in the Active group the shared `categoryFromName` splits todo/doing, and an Active status whose name merely reads "done" stays open. An unknown `customStatusId` (a workflow hidden from the token's user) falls back to the standard status.
- **Project = the folder the task sits in.** `GET /folders/{id}/folders` gives the subtree's titles (the folder itself included, verified) in one call. The first of the task's `parentIds` inside the subtree is the project; a subtask has no folder of its own (its `parentIds` point at the account root, verified) and is placed by `superParentIds`; else the configured folder's title. Other folders the task is tagged into become labels — Wrike's folders are its tags.
- **Token from an env var only (`tokenEnv`, default `WRIKE_API_TOKEN`).** The bot and the sources daemon read the same `.env`; there is no token file, so `auth` has `check` and no `add` (as YouTrack with `tokenEnv`). `check` also asks for the configured folders by id, so the daily credential check notices a folder the token lost.
- **`host` restricted to `*.wrike.com`.** The bearer is sent there; a typo must not send it elsewhere. EU accounts use `app-eu.wrike.com`.
- **30-day default horizon** (the other trackers use 90): a client folder in an agency account is busy, and the watcher's readouts look back days, not quarters; a backfill is one `--since` away.
- **Lookups degrade, the token does not.** A failed contacts or workflows call leaves `wrike:<id>` / the standard status in that pass's records (re-appended correctly once it resolves, the line hash changes) — unless it is a 401/403, which fails the folder like any other request.

## Risks / Trade-offs

- [One comments call per updated task] → a first backfill of a large folder costs as many calls as tasks; paced at 5 req/s with `Retry-After` honoured. Incremental passes touch only what moved.
- [First assignee only] → `tasks({assignee})` misses a co-assignee; documented as a known limit. Fixing it needs an assignees column in the store — a family-wide change.
- [A task in two configured folders] → written under both, the store keeps the later line (same ref); harmless duplication in raw.
- [Wrike rate limits] → per-user limits answer 429; the shared client waits for `Retry-After`, then backs off.

## Migration Plan

Bucket 2 by construction: nothing runs without a `wrike` block, and no installation has one. Canary: the home tenant — add `WRIKE_API_TOKEN` to the `.env` the bot and the sources daemon read, add `"wrike": {"folders": [...]}` to the tenant's `sources`, `orch sources auth <slug> wrike check`, restart the daemon (and the bot, for the MCP text), then watch the first pass's `wrike` line and `stuck({source: "wrike"})`. Rollback: remove the block; raw files stay until a purge.

## Open Questions

- Should Deferred tasks be excluded from `stuck` by default? Today they count as open, like an "On hold" status in the other trackers; the canary will show whether that is noise.
