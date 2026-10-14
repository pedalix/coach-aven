# Tasks

## 1. Config and puller

- [ ] 1.1 Add `channels?: string[]` and `kinds?: ('channel'|'group'|'im'|'mpim')[]` to `SlackSourcesConfig` with boot validation in `src/sources/config.ts`; verify with config tests (valid, invalid kind, empty list rejected).
- [ ] 1.2 Apply the filter in `src/sources/slack/pull.ts` after `users.conversations` (match by id, then by name; kinds by conversation flags); verify with a pull test using a fake client: listed conversations pulled, unlisted skipped and logged with `--verbose`, no-config behaviour unchanged.

## 2. Docs and rollout

- [ ] 2.1 Document both keys in `docs/sources.md` and add the `docs/rollout.md` row (bucket 2, default-preserving, test proves it); verify `npm test` passes in a worktree with `SLACK_CHANNEL_PREFIX=bluefin-aven-`.
