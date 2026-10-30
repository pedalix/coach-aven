# Contributing

Thanks for looking. This is a small project run by one person for real installations, so the
bar is: **nothing may change for production users as a side effect of a merge.**

## Small fixes

A typo, a docs fix, or a bug fix with a test that proves it: open the PR directly. It is a bug fix
(bucket 1), needs no OpenSpec change and no ledger row — say what it fixes, label it `fix` or
`docs`, and make the checks below pass. AI-assisted PRs are welcome on the same terms: you
answer for what you submit.

## Before a PR

- `npm run typecheck` and `npm test` pass; `bash scripts/public-guard.sh` is clean (CI adds a private deny-list; use invented names and `.example` domains in tests and docs).
- Pure logic (parsing, matching, formatting) lives in its own module with a `*.test.ts`
  beside it — not inside the Slack handlers.
- Any new command, button or changed interaction is reflected in the App Home tab
  (`homeBlocks` in `src/chat/slack/blocks.ts`) in the same change.
- Changes to the base system prompt re-snapshot `src/fixtures/prompt/*.txt` on purpose.

## How changes ship

- Anything larger than a small fix plans first: an OpenSpec change under
  `openspec/changes/<name>/` (proposal → spec delta → design → tasks). `openspec list` shows what
  is in flight; open a Discussion first if you are not sure a change is wanted.
- Every behaviour change names its rollout bucket in the PR (`docs/rollout.md`): a bug fix,
  default-preserving with a test proving today's shape, or behind a flag that is off by
  default and canaried first — with its ledger row.
- PR titles become the release notes; label `feature` / `fix` / `ci` / `docs`.
- `main` is the canary; production runs the last tag.

## Keep installations out of the repo

Hosts, customer names, people, mailboxes, tenant ids belong in your private ops repo
(`infra/README.md`), never here. CI runs `scripts/public-guard.sh` and gitleaks; test
data uses `*.example` addresses and `T0000FAKE01`-style ids.

## Support and conduct

Questions go to Discussions, bugs to issues: [`SUPPORT.md`](SUPPORT.md). Everyone here follows
the [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Questions about running it for your team:
[coachaven.com](https://coachaven.com).
