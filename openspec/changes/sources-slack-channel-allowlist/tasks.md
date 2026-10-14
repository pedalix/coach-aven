# Tasks

## 1. Config and puller

- [x] 1.1 Add `channels?: string[]` and `kinds?: ('channel'|'group'|'im'|'mpim')[]` to `SlackSourcesConfig` with boot validation in `src/sources/config.ts`; verify with config tests (valid, invalid kind, empty list rejected).
- [x] 1.2 Apply the filter in `src/sources/slack/pull.ts` after `users.conversations` (match by id, then by name; kinds by conversation flags); verified with `scope.test.ts` over the pure selection step (`src/sources/slack/scope.ts`, no fake client needed): listed conversations kept, unlisted skipped (logged as `--verbose` lines once per run), no-config selection is the identity.

## 2. Docs and rollout

- [x] 2.1 Document both keys in `docs/sources.md` and add the `docs/rollout.md` row (bucket 2, default-preserving, test proves it); verify `npm test` passes in a worktree with `SLACK_CHANNEL_PREFIX=bluefin-aven-`.
