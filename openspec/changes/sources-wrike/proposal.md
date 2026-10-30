# Proposal

## Why

A delivery team keeps part of its client work in Wrike — a folder per client or site. The tenant agent that watches the team's attention field (what is unanswered, what is stuck, what keeps recurring) reads YouTrack, Jira, Asana and Slack today, but not Wrike, so that part of the work is invisible to it: a client task parked for two weeks never shows up in `stuck`, a comment from the client never reaches the brief.

## What Changes

- A fourth tracker connector, `src/sources/wrike/` (`normalise.ts` pure, `pull.ts`, `auth.ts`, tests), on the shared tracker plumbing (`src/sources/trackers/`): same `task` record, same scrub-at-write, same raw → store path, so `tasks`, `stuck`, `search` and `get` work for Wrike tasks without changes to the store.
- Config: `sources.wrike: { folders: [<folder or space id>, …] (required, non-empty), tokenEnv? (default WRIKE_API_TOKEN), host? (default www.wrike.com, only *.wrike.com), since? (YYYY-MM-DD, default 30 days back) }`, validated at boot like the other trackers.
- Wrike REST v4 with a permanent token (`Authorization: Bearer`): per folder, every task in it and beneath it (subtasks included) updated since that folder's cursor, paged by `nextPageToken`; comments per task; contacts for names; workflows for custom status names. 429 waits for `Retry-After`; 401/403 parks the source for re-auth.
- One cursor per configured folder: the shared tracker writer gains an optional `scope` (files and cursor under `<account>/<scope>/`); without it nothing changes for YouTrack, Jira or Asana.
- `orch sources pull <slug> --only wrike` and `orch sources auth <slug> wrike check` (who the token is, every folder readable — the daily credential check runs it). No `add`: the token lives in `.env`, like a YouTrack block with `tokenEnv`.
- The sources MCP knows `wrike` as a tracker source (`search source: wrike` looks in tasks) and names Wrike in the `tasks`/`search` descriptions — sources MCP 1.12.1.
- Docs: a Wrike section in `docs/sources.md`; `WRIKE_API_TOKEN` in `docs/configuration.md`.

Out of scope: writing to Wrike (the token is used read-only); tasks deleted in Wrike or moved out of the configured folders (not seen again — as with the other trackers); more than one assignee per record (the store has one assignee column; the first is kept); Wrike notification mails in the attribution layer's tracker-mail rule.

## Capabilities

### New Capabilities
- `sources-wrike`: Wrike folders as a tracker source of a project's sources store.

### Modified Capabilities
- (none — `sources-readouts` already covers any tracker task; the Wrike tasks satisfy it unchanged)

## Impact

- `src/sources/wrike/*` (new), `src/sources/{types,config,run,cli}.ts`, `src/sources/trackers/{writer,task,auth}.ts`, `src/sources/identities/normalise.ts` and the attribution layer's identity prefixes (`wrike:` is an id), `snapshot/plain/sources-mcp.mjs`, tests, `docs/sources.md`, `docs/configuration.md`, `docs/runtime-config.md`, `docs/rollout.md`.
- Rollout bucket 2 by construction: only a project with a `wrike` block pulls Wrike; no installation has one yet. The shared-code edits are default-preserving — the tracker writer without `scope` is byte-identical (the existing tracker tests pass unchanged), `config.test.ts` proves a block without `wrike` validates as before, and `search source: wrike` matches nothing in a store without Wrike tasks. The only text prod's agent sees change is the word "Wrike" in two tool descriptions.
- Canary: the home tenant, once a `wrike` block and `WRIKE_API_TOKEN` are set there. Ledger row in `docs/rollout.md`.
