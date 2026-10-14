# Rollout: `main` → canary → prod

Two bots run this code. The **home bot** (Owen's laptop, one tenant, Socket Mode on a dev Slack
app) follows `main` and is restarted whenever something lands. **Prod** (Bluefin's bot, six
projects, real client channels) runs the last git tag. So every merge ships to the canary first
and reaches prod only when a tag is cut — the tag is the rollout decision, not a formality.

## The contract

Nothing may change for prod users as a side effect of a merge. Every PR that touches shared
code falls into one of three buckets, and the PR description says which:

1. **Bug fix or invisible improvement** — ungated, tests. Prod gets it with the next tag;
   numbers may move (that is the point), behaviour does not.
2. **Default-preserving** — a new config key or code path whose default is today's prod
   shape, with a test that proves it (golden prompt fixtures in `src/fixtures/prompt/`,
   `ROUTINE_GUARD` unset in tests). Prod is untouched until someone sets the key.
3. **Visible behaviour change** — behind an env/config flag, **off by default**, canary first.
   The flag is a rollout stage, not a permanent switch: canary → prod `.env` → default →
   flag retired (see *Flag lifecycle*).

Sources/ingest code (`src/sources/**`, the sources MCP) is bucket 2 by construction: it only
runs for a project with a `sources` block in its config, and no prod project has one.

## Cadence

- **Tag** only after `main` has run on the home bot for ~2 days covering at least one full
  weekday cycle (08:30 brief, 18:30 close, 19:30 review) with no regression in the canary
  channel. `git log $(git describe --tags --abbrev=0)..main --oneline` is the list of what is
  waiting; the ledger below says what to watch for.
- **Flag lifecycle**: (a) merged, off, canary has it on → (b) proved on the canary → turn on
  in prod `.env` (`prod:import` first, see `infra/prod/`) as its own deliberate step, note the
  date below → (c) one release later with no complaints → PR that makes it the default and
  removes the flag, row moves to *Retired*.
- **Start of every work session**: look at the untagged commits and this ledger; anything
  that has sat in the canary long enough is either tagged, flipped, or retired before new
  work starts. Without this rhythm the flags pile up and nobody remembers which half-state
  prod is in.
- Prod `.env` changes are not in git — record the date here when a flag is flipped.

## Ledger

Canary = the home bot runs it. Prod = tagged and deployed. Default = flag no longer needed.

| Change | PR | Gate | Canary since | Prod since | Default since | What to watch / notes |
|---|---|---|---|---|---|---|
| ssh-docker: no `--restart unless-stopped`, mount probe → recycle, empty mount after recycle is fatal | #134, #138 | none (driver behaviour) | 2026-10-14 | – | – | Prod sandboxes use ssh-docker: after a dockerd restart on the sandbox host, containers stay down until the next turn recreates them (before: auto-restart with a possibly empty mount). Canary check: restart Docker Desktop, next turn must recycle cleanly. |
| Metering: per-turn cost = delta of the CLI's running total | #135 | none (bug fix) | 2026-10-14 | – | – | `/aven usage` drops ~2× from the tag onward; earlier months stay inflated. Say so when the number is quoted. |
| Base prompt: `gitFlow` pr\|direct, toolchain paragraph only with `dind` | #136 | config `gitFlow`, default `pr` | 2026-10-14 | n/a | `pr` | Golden fixture pins the prod text byte-exact. |
| Base prompt: ScheduleWakeup result is a background update | ad8cab5 | none (prompt text) | 2026-10-14 | – | – | Deliberate re-snapshot; watch for odd "I scheduled…" answers in prod threads. |
| Routine delivery guard: catch-up, outcome + one retry, "previous run" preamble, `gh` seeding non-fatal | #138 | `ROUTINE_GUARD=1` | 2026-10-14 | – | – | Prod effect when flipped: a restart within `ROUTINE_GUARD_CATCHUP_HOURS` of a slot fires the missed routine into the client channel — intended. Flip after the canary shows `fired — scheduled … delivered` for a week. |
| Sources: Outlook calendar tag + own-calendar allow-list (schema v6), tracker raw dedupe, Asana followers, meeting tools, transcript pass-through | #133, #137, #139 | `sources` config | 2026-10-14 | n/a | – | No prod project has `sources`. |

### Retired

| Flag | Default since | PR |
|---|---|---|
| – | | |
