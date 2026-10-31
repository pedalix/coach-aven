---
name: ship
description: Deploy CoachAven installations, answer "is it live / where does it run", or preview a worktree's change before merge. Use when the user says ship / deploy / выкати / release / tag / promote to staging or prod / roll back, asks whether a PR or commit is live on an installation, or wants to see a change before merging. Sessions never deploy any other way (no direct deploy.sh … deploy, remote-script deploy or npm run release).
---

> Mechanics: `infra/deploy/README.md` → *Several installations*; the change is OpenSpec `ship-dispatcher`. Installation
> names, stages and hosts are in the operator's overlays (`infra/<slug>/deploy.env`), never in this repo.

# Ship, where, preview

Sessions only merge. Installations move through **one command**, `npm run ship -- <slug>…`, run in the checkout that
holds the overlays (the main checkout; from a worktree it tells you where). It deploys in `STAGE` order under one lock:
the lowest stage gets the newest green `main`, every later stage what the stage below runs, a release stage gets a tag
`ship` creates. Never deploy around it.

## "Is it live?" — `where`

```bash
npm run where            # each installation: version, commit, how far behind main
npm run where -- 142     # ✓/✗ per installation for PR #142 (or a commit)
```

Answer from this output, not from memory of what a session deployed.

## Shipping

1. **Plan.** `npm run ship -- --plan <slugs…>` — the version per installation, the range, the merged PRs. Show the user
   the plan's lines as they are.
2. **Canary stages** (no new tag): ship on the user's go — `npm run ship -- <slug>`.
3. **A release stage** (the plan says `new tag` or names a `vX.Y.Z`):
   - Run **one** fresh, independent, read-only review of `git diff <the installation's current version>..<the
     candidate commit>`: a new Agent (not you, not a fork that saw the work), told to find correctness bugs and real
     regressions with a concrete failure scenario each, precision over recall, no style notes, no edits, no GitHub
     comments. One review per release — not per PR, no second round.
   - Show the user **one screen**: the version, the PR list from the plan, the review's findings (or "clean"), and
     anything in `docs/rollout.md`'s ledger that this release moves (a row whose *Prod since* this fills).
   - Run `npm run ship -- <slug>` only after the user's explicit go for this release ("да", "выкатывай", "ship").
     Approval of the plan is not approval to ship.
4. **After.** `npm run where` to confirm; note in the ledger rows whose *Prod since* is now set (a docs PR).

A failure stops `ship` at that installation and names the version it still runs and the rollback command
(`npm run ship -- <slug> --version <earlier>`). Report it as it is; roll back only on the user's word.

## Preview before merge

When the user wants to see a change before it merges: `npm run preview` in the change's worktree → give the URL
(`http://127.0.0.1:879x`). It is the quickstart's installation on the scratch project from
`~/.config/coach-aven/preview.env`, sharing nothing with any installation. Stop it when done: `npm run preview -- stop`
(`--clean` drops `.preview/`). Start one only when asked — its turns spend the credit.
