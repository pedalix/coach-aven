# Contributing

Thanks for looking. This is a small project run by one person for real installations, so the
bar is: **nothing may change for production users as a side effect of a merge.**

## Before a PR

- `npm run typecheck` and `npm test` pass; `bash scripts/public-guard.sh` is clean.
- Pure logic (parsing, matching, formatting) lives in its own module with a `*.test.ts`
  beside it — not inside the Slack handlers.
- Any new command, button or changed interaction is reflected in the App Home tab
  (`homeBlocks` in `src/blocks.ts`) in the same change.
- Changes to the base system prompt re-snapshot `src/fixtures/prompt/*.txt` on purpose.

## How changes ship

- Plan first: an OpenSpec change under `openspec/changes/<name>/` (proposal → spec delta →
  design → tasks). `openspec list` shows what is in flight.
- Every behaviour change names its rollout bucket in the PR (`docs/rollout.md`): a bug fix,
  default-preserving with a test proving today's shape, or behind a flag that is off by
  default and canaried first — with its ledger row.
- PR titles become the release notes; label `feature` / `fix` / `ci` / `docs`.
- `main` is the canary; production runs the last tag.

## Keep installations out of the repo

Hosts, customer names, people, mailboxes, tenant ids belong in your private ops repo
(`infra/README.md`), never here. CI runs `scripts/public-guard.sh` and gitleaks; test
data uses `*.example` addresses and `T0000FAKE01`-style ids.

## Support

Best-effort. Open an issue with the log lines (`journalctl -u coach-aven`), the driver, and
the Claude Code CLI version in the sandbox. Questions about running it for your team:
[coachaven.com](https://coachaven.com).
