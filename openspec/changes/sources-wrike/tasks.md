# Tasks

## 1. Config and shared plumbing

- [x] 1.1 `WrikeSourcesConfig` (`folders`, `tokenEnv?`, `host?`, `since?`), `wrike` in `SourceKind`/`TrackerKind`, boot validation in `src/sources/config.ts` (ids in API v4 shape, permalink numbers rejected with the conversion call, env-var name, `*.wrike.com` host, unknown keys); verify with `src/sources/config.test.ts` (valid block normalised, each rejection, a block without `wrike` unchanged).
- [x] 1.2 Optional `scope` on `TrackerRun` (`<account>/<scope>/` files + cursor, `<account>/<scope>` in logs and counts); verify with `src/sources/trackers/trackers.test.ts` — the existing tests pass unchanged (unscoped = byte-identical) and the new scope test proves separate cursors, `since` for a later scope, refs untouched, no path escape.

## 2. Connector

- [x] 2.1 `src/sources/wrike/normalise.ts` (pure): `Name <email>` people, status group → category, project from parent / super-parent folders, labels, permalink key, HTML description → text, comments oldest first, stamps without milliseconds; verify with `src/sources/wrike/normalise.test.ts` over fixtures shaped like Wrike v4 answers.
- [x] 2.2 `src/sources/wrike/pull.ts`: subtree titles, paged folder tasks (`nextPageToken`), comments per task, contacts batched and cached, workflows once, one `runTrackerPull` per folder, merged summary, 30-day default; verify with `src/sources/wrike/pull.test.ts` (paging and query, per-folder cursor, 429 + `Retry-After`, 401 → reauth with no cursor moved, a bad folder failing alone, no token → reauth).
- [x] 2.3 `src/sources/wrike/auth.ts` (`check`: who the token is + every folder readable), dispatch in `src/sources/run.ts` (`pullProject`, `runAuth`), `--only wrike` in `src/sources/cli.ts`; verify with `npm run typecheck` (the `runAuth` switch is exhaustive).
- [x] 2.4 Store and readouts: the per-folder raw files are ingested, and `stuck`, `tasks` and `search source: wrike` answer over Wrike tasks; `wrike` in the sources MCP's tracker sources and tool descriptions (1.12.1); `wrike:<id>` is an opaque identity. Verify with the end-to-end test in `src/sources/wrike/pull.test.ts` and `src/sources/identities/identities.test.ts`.

## 3. Docs and rollout

- [x] 3.1 `docs/sources.md` (Wrike section, tracker table, raw layout), `docs/configuration.md` (`WRIKE_API_TOKEN`), `docs/runtime-config.md`; verify with `src/configdocs.test.ts` and `src/doclinks.test.ts`.
- [x] 3.2 `docs/rollout.md` ledger row (bucket 2 by construction); no Slack surface changes, so no Home tab update.
- [x] 3.3 Live read-only check against a real account (one folder, a temp outDir, deleted afterwards): paging, normalisation and the store build on real answers.
- [ ] 3.4 Canary: the home tenant gets a `wrike` block and `WRIKE_API_TOKEN`; `orch sources auth <slug> wrike check` passes; the first pass's `wrike` line and `stuck({source: "wrike"})` look right. — after the merge, by the operator.
