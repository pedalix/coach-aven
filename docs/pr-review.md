# PR review & the PR-watcher

CoachAven can review pull requests, on demand or automatically. This is the first half of
the **PR backbone**; autofix (watch a PR's CI/reviews and offer a fix) builds on the same
poller and is tracked below.

## Commands

| Command | What it does |
| --- | --- |
| `/aven review <PR url \| #num> [low\|med\|high]` | One-off **read-only** review, posted where you ran it. The PR's repo identifies the project, so it works in **DMs and any channel**. Accepts a URL, `#num` (sole/this-channel repo), or `<repo> #num`. Optional trailing effort (default `med`). |
| `/aven review auto on [effort]` | Turn on **auto-review** for this channel's project — new non-bot PRs get reviewed as they open, posted here, at the given effort (default `med`). |
| `/aven review auto off` | Turn it off. |
| `/aven review auto` | Show the current state + effort. |
| `/aven autofix <PR>` | **Watch** a PR — ping this channel on CI failures / new reviews with a **Fix** button. |
| `/aven autofix off <PR>` | Stop watching it. |
| `/aven autofix list` | List PRs watched from this channel. |

## How it works

- **Read-only.** The agent reads the change in the project sandbox with `gh pr diff` /
  `gh pr view` and posts a Slack summary. It does **not** push code, comment on GitHub, or
  approve/request changes. (This is prompt-enforced framing, not a hard tool gate — same
  trust model as scheduled report jobs.)
- **Methodology.** `reviewPrompt` (in `src/prompts.ts`) borrows Claude Code's `/code-review`
  approach — compressed into one turn instead of its multi-agent fan-out: scope = touched
  hunks + their enclosing functions; **find → verify** with a quote-to-refute burden of proof
  and a **concrete failure scenario required per finding** (the false-positive killer);
  severity-ranked, capped output.
- **Effort.** `low` (≤4, single pass, precision) · `med` (≤8, cross-file, precision — default)
  · `high` (≤10, recall-biased + a fresh gap sweep). Effort is the precision↔recall lever.
  (Full multi-agent depth is what `/code-review ultra` in the cloud is for — not run here.)
- **Auto-review poller.** Socket Mode has no inbound webhooks, so a poller
  (`startAutoReviewPoller`, every ~3 min) lists open PRs per repo and reviews the ones that
  are due. "Due" (pure `prsToReview`) = not a draft, not the bot's own PR (`coach-aven[bot]`),
  opened **after** auto-review was enabled (the `autoReviewSince` cursor — avoids reviewing
  the whole backlog on enable), and not already reviewed.
- **State.** Per-project `projectSettings` (toggle + cursor + channel) and the `reviewedPrs`
  dedup map live in `state.json`, so a restart neither re-reviews the backlog nor floods.
- **Session.** Each review runs on key `review:<repo>:<num>:<slug>` (standing → re-running a
  review keeps prior context).

## ⚠️ Open item: review quality still wants a real judging pass

The prompt now follows Claude Code's `/code-review` methodology (above) and is on a much
stronger footing than the first cut — but its output **hasn't been systematically judged**
yet (accuracy, prioritisation, noise) on real PRs, and auto-review reuses the same prompt.
Spend a session running it across a handful of known-good and known-buggy PRs and tune
`reviewPrompt` in `src/prompts.ts` if needed. All prompt copy lives in `src/prompts.ts`, so
it's a one-file edit.

## Autofix (tier 1)

`/aven autofix <PR>` subscribes a PR; a poller (`startAutofixPoller`, ~2 min) checks its CI
(aggregate check-runs for the head sha) and its reviews, and — when something **changes**
since you subscribed — posts a Slack notification with a **🔧 Fix it** button. The cursors
are baselined at subscribe (current CI sha/conclusion + latest review id), so it only pings
on *new* failures / reviews, not the existing state. A merged/closed PR auto-unsubscribes.

The decision is pure (`autofixEvents`): notify once per head-sha CI failure, and on new
non-bot reviews that aren't plain approvals. **Tier 1 = notify + one-click fix — it never
pushes autonomously.** The button enqueues a write-turn (`autofixPrompt`) that checks out
the branch, fixes, pushes, and reports back (asking first if the fix is ambiguous/risky).

> Like auto-review, the **fix turn writes under `coach-aven[bot]`** and can reply to review
> threads — mind any repo automation that triggers on PR comments (cf. Claude Tag's warning).

## Roadmap (same backbone)

- Re-review on new commits (head-sha change); optional inline GitHub review comments.
- Autofix tier 2: auto-push clear CI fixes (ask on ambiguous review feedback).
