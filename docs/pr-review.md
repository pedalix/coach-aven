# PR review & the PR-watcher

CoachAven can review pull requests, on demand or automatically. This is the first half of
the **PR backbone**; autofix (watch a PR's CI/reviews and offer a fix) builds on the same
poller and is tracked below.

## Commands

| Command | What it does |
| --- | --- |
| `/aven review <PR url \| #num>` | One-off **read-only** review, posted where you ran it. The PR's repo identifies the project, so it works in **DMs and any channel**. Accepts a URL, `#num` (sole/this-channel repo), or `<repo> #num`. |
| `/aven review auto on` | Turn on **auto-review** for this channel's project — new non-bot PRs get reviewed as they open, posted here. |
| `/aven review auto off` | Turn it off. |
| `/aven review auto` | Show the current state. |
| `/aven autofix <PR>` | **Watch** a PR — ping this channel on CI failures / new reviews with a **Fix** button. |
| `/aven autofix off <PR>` | Stop watching it. |
| `/aven autofix list` | List PRs watched from this channel. |

## How it works

- **Read-only.** The agent reads the change in the project sandbox with `gh pr diff` /
  `gh pr view` and posts a Slack summary. It does **not** push code, comment on GitHub, or
  approve/request changes. (This is prompt-enforced framing, not a hard tool gate — same
  trust model as scheduled report jobs.)
- **Auto-review poller.** Socket Mode has no inbound webhooks, so a poller
  (`startAutoReviewPoller`, every ~3 min) lists open PRs per repo and reviews the ones that
  are due. "Due" (pure `prsToReview`) = not a draft, not the bot's own PR (`coach-aven[bot]`),
  opened **after** auto-review was enabled (the `autoReviewSince` cursor — avoids reviewing
  the whole backlog on enable), and not already reviewed.
- **State.** Per-project `projectSettings` (toggle + cursor + channel) and the `reviewedPrs`
  dedup map live in `state.json`, so a restart neither re-reviews the backlog nor floods.
- **Session.** Each review runs on key `review:<repo>:<num>:<slug>` (standing → re-running a
  review keeps prior context).

## ⚠️ Open item: review quality is not yet evaluated

The review **prompt quality has not been judged**. The on-demand reviewer was eyeballed once
("more or less okay") but we have **not** systematically assessed whether the reviews are
accurate, well-prioritised, or low-noise — and auto-review reuses the exact same prompt.

**Before relying on auto-review, judge the output.** Things to assess and likely tune
(`reviewPrompt` in `src/slack.ts`): does it review only the diff (not whole files), rank by
severity with a cap, distinguish blocking vs nit, stay concrete (file:line), avoid
hallucinated findings? Effort levels (cf. `/code-review` low/med/high) could be exposed.

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
