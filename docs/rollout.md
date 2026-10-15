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
| Chat driver, PR 4 of 4: routines, reviews, autofix, YouTrack, dispatch and ops alerts post through the chat driver; the Slack composition root moves to `src/chat/slack/app.ts`; only `src/chat/slack/` may import `@slack/*` (OpenSpec `chat-driver-interface`) | #171 | none — bucket 1, invisible refactor | – | – | n/a | 19 recorded routine/review/dispatch scenarios byte-identical before/after (`src/chat/slack/pollers.record.test.ts`), golden payloads for the network-gated autofix/YouTrack posts (`src/chat/slack/driver.test.ts`). Deploy: `orch slack` is unchanged (cli import moved). Canary: the 08:30/18:30/19:30 routines post their parent + thread as before, `/aven routines run`, one `/aven review`, an ops alert if one fires. `orch teams` now prints the available run modes. |
| Chat driver, PR 3 of 4: mentions, DMs, thread replies and every `/aven` verb run in the platform-neutral core (`src/chat/core/messages.ts`, `src/chat/core/commands.ts`) (OpenSpec `chat-driver-interface`) | #170 | none — bucket 1, invisible refactor | – | – | n/a | 90 recorded message/command scenarios (every verb with its usage/error/denial/ownership/operator branches; mentions, DMs incl. picker and Connect file tombstones, owned/unowned/denied thread replies, ignored events, the Connect double envelope) byte-identical before/after (`src/chat/slack/commands.record.test.ts`). Canary: a mention, a DM with and without a slug, a thread follow-up, `/aven status`, `/aven memory`, `/aven routines`, `/aven <question>` — all as before. |
| Chat driver, PR 2 of 4: buttons, modal submissions and App Home run in the platform-neutral core (`src/chat/core/`); `events.ts`/`blocks.ts` move to `src/chat/slack/` (OpenSpec `chat-driver-interface`) | #169 | none — bucket 1, invisible refactor | – | – | n/a | 45 recorded interaction scenarios (every button incl. denied/unserved/stale branches, every modal submission, App Home home/client/onboarding, install lifecycle) byte-identical before/after (`src/chat/slack/events.record.test.ts`). Canary: 👍/👎 + reason modal, 🧭 Show steps, ⚙️ Session + 🔄 Restart, an agent question, the App Home tab — all look exactly as before. |
| Chat driver, PR 1 of 4: the turn engine renders through a `ChatDriver` (post/update/mark/permalink); Slack is its first implementation (OpenSpec `chat-driver-interface`) | #167 | none — bucket 1, invisible refactor | – | – | n/a | 21 recorded turn-path scenarios (answer, queue, cancel, error, background, questions, notes, attachments, YouTrack draft/auto-post, slot wait, restart recovery and replay) are byte-identical before/after (`src/chat/slack/turn.record.test.ts`). Canary: a normal day of threads, one ✖ Cancel, one agent question, one `systemctl --user restart` mid-turn — status/answer/reactions look exactly as before. |
| Sources MCP 1.4.1: `unanswered` side mode counts only messages addressed to a side member (`all: true` = every message in scope); `stuck` default limit 200 | #164 | `sources` config | 2026-10-15 | n/a | – | Bucket 2 (sources-gated). Fix for the first bluefin-ops brief: Bluefin ↔ Bluefin exchanges and questions to a project's own agent were listed as waiting. Canary: the next bluefin-ops brief shows no Bluefin ↔ Bluefin item under *Waiting on us* and no "→ CoachAven" item under *Waiting on Bluefin*. |
| Deploy moves to the ops repo: `release.yml` releases, `coach-aven-ops/deploy.yml` deploys; no deploy secrets or environment in the public repo (OpenSpec `deploy-from-ops`) | #161, #162 | none — CI/deploy tooling, no runtime code | 2026-10-15 | 2026-10-15 (v0.39.0 redeploy, then v0.40.0 — first release through the new path) | n/a | Hand-off is manual by decision (2026-10-15): `npm run release -- vX.Y.Z` = tag + push + `gh workflow run` in the ops repo; no credential in the public repo (the dispatch step stays opt-in). Proof = the first tag deployed by the ops workflow (`v0.39.0` by hand first, then the next real release). |
| Public-repo hygiene: public-guard + gitleaks in CI, ops overlay repo at `infra/prod/runtime/`, history rewrite + visibility flip (OpenSpec `go-public`) | #149, #150, #151, #157, #158 | none — no bot behaviour change (tests, docs, deploy tooling, CI) | 2026-10-15 | 2026-10-15 (v0.40.0; history rewritten the same day) | n/a | Canary = tests green and the home bot unchanged (its config is outside the repo). `deploy.sh export` now refuses a dirty ops checkout — operator-facing only. Rewrite date and flip date go in this row when done. |
| ssh-docker: no `--restart unless-stopped`, mount probe → recycle, empty mount after recycle is fatal | #134, #138 | none (driver behaviour) | 2026-10-14 | – | – | In prod only the `coach-aven` project runs on ssh-docker (the aven sandbox box, `SSHDOCKER_HOST=aven-sandboxes`); the other seven run on Daytona (Bluefin VM) and are untouched. After a dockerd restart on the sandbox box its container stays down until the next turn recreates it (before: auto-restart with a possibly empty mount). Canary check: restart Docker Desktop, next turn must recycle cleanly. |
| Metering: per-turn cost = delta of the CLI's running total | #135 | none (bug fix) | 2026-10-14 | – | – | `/aven usage` drops ~2× from the tag onward; earlier months stay inflated. Say so when the number is quoted. |
| Base prompt: `gitFlow` pr\|direct, toolchain paragraph only with `dind` | #136 | config `gitFlow`, default `pr` | 2026-10-14 | n/a | `pr` | Golden fixture pins the prod text byte-exact. |
| Base prompt: ScheduleWakeup result is a background update | ad8cab5 | none (prompt text) | 2026-10-14 | – | – | Deliberate re-snapshot; watch for odd "I scheduled…" answers in prod threads. |
| Routine delivery guard: catch-up, outcome + one retry, "previous run" preamble, `gh` seeding non-fatal | #138 | `ROUTINE_GUARD=1` | 2026-10-14 | – | – | Prod effect when flipped: a restart within `ROUTINE_GUARD_CATCHUP_HOURS` of a slot fires the missed routine into the client channel — intended. Flip after the canary shows `fired — scheduled … delivered` for a week. |
| Scrubber precision: bare "credentials" subject, URL/prose `kv` pairs no longer withhold a body; `token is required` no longer a kv hit; `sources rescrub` | #141 | none (bug fix; the kv `is`-separator change also applies to prod user-turn redaction — strictly fewer false redactions) | 2026-10-14 | – | – | Canary: withheld count in `stats()` drops after rescrub + build; no new secret in `sources audit`. |
| Sources MCP: `to` on message hits/get, direction sentence in `search` | #141 | `sources` config | 2026-10-14 | n/a | – | Brief must say "Owen → Tobin" for a Sent Items hit. |
| Sources: Outlook calendar tag + own-calendar allow-list (schema v6), tracker raw dedupe, Asana followers, meeting tools, transcript pass-through | #133, #137, #139 | `sources` config | 2026-10-14 | n/a | – | No prod project has `sources`. |
| Slack bot tokens: `auth slack add --bot | --from-install`, `kind` on the workspace record, join step for listed public channels, `slack.joinPublic` (OpenSpec `sources-slack-bot-token`) | #148 | token kind in the store; `joinPublic` config | 2026-10-15 | n/a | – | Bucket 2: a user-token record behaves exactly as before (`joinPlan` is empty for `kind: user`, tested); the join step runs only for bot records. Canary: once the app is installed in Bluefin's workspace, `add --from-install` + one Bluefin-internal public channel in the allow-list → `joined #…` in the log and the channel in the store, no DM. |
| `orch sources serve`: the sources tools over MCP streamable HTTP from the replica; a `sources` `mcp` url entry mounts no replica (OpenSpec `sources-serve-remote-mcp`) | #147 | `SOURCES_SERVE_TOKEN` + a project `mcp` url entry | 2026-10-14 | – | – | Bucket 3 by construction: nothing runs unless the command is started and a project declares the entry; the mount skip only applies to projects with such an entry (test). Prod wiring (unit, nginx, gateway target) after the tag; canary = `initialize` 200 through the gateway before bluefin-ops gets the entry. |
| Dispatch primitive: `host` MCP `propose` → Send/Dismiss → message or dispatched turn with provenance (OpenSpec `dispatch-primitive`) | #146 | `DISPATCH=1` | 2026-10-14 | – | – | Bucket 3. Off: no `host` server, no prompt paragraph, no outbox mount, no Home bullet, buttons inert (goldens + `dispatch.test.ts` pin it). Canary: bluefin-ops proposes ONE dispatch to owen-ops from its brief; Owen clicks Send; a thread opens in `#dev-bluefin-aven-owen-ops`, the pointer lands back in `#dev-bluefin-aven`, one usage record with `proposalId`. |
| Routine empty-slot skip: no turn when nothing new + nothing due + sources fresh (OpenSpec `routine-nothing-new-skip`) | #145 | `ROUTINE_SKIP_EMPTY=1` (needs `ROUTINE_GUARD=1`) | 2026-10-14 | – | – | Bucket 3. Flag off = byte-identical fire path (guard tests pin it); prod projects have no sources, so even flipped it never applies there today. Canary: a quiet 18:30 slot posts `⏭ nothing new since …` once, `/aven usage` shows no turn for it, the 19:30 preamble names the 08:30 delivery; the first run after the flag can never skip (no baseline count yet). |
| One zone per tenant: `sources.timezone` (default the bot's `AVEN_TZ`), written into the store as `tz`; every sources tool presents that store in it; storage UTC only (attribution table without a local day; `timezone` left attribution.json); sources MCP 1.6.0, store schema v8 | #177 | `sources` config | 2026-10-15 | n/a | – | Bucket 2: absent `sources.timezone` → the bot zone, exactly as before; no prod project has `sources`. Home: owen-ops Europe/Moscow (unchanged), bluefin-ops Europe/Zurich (Bluefin's day). Canary: `stats.tz` per project; bluefin-ops' `today` follows Zurich. |
| Attribution layer in the store build + the `attribution` tool (OpenSpec `attribution-layer`): the tenant's fragments, ladder decisions, open items and rule proposals from tenant data; sources MCP 1.5.0; store schema v7 | #176 | `sources` config + the tenant's `annotations/attribution.json` | 2026-10-15 | n/a | – | Bucket 2: no tenant file → no rows and the tool says "not configured"; no prod project has `sources`. Schema v7 rebuilds every store from raw once. Parity with the owen-ops CLI on 12–15.10 of the real store: same ids, states and initiatives (one late-night work block only the platform sees). Canary: owen-ops commits its attribution.json; the build log line shows `attribution …: N fragments (decided …, rule …, open …)`; the tool answers for yesterday. |
| Host tools over the session control channel (OpenSpec `host-tools`): `sources` served by the bot from its replica on a worker thread, `propose` + `registry` as the bot's `host` server; outbox mount, automatic replica mount and the in-sandbox server uploads removed; sources MCP 1.4.2 | #174 | `sources` config (bucket 2) · `DISPATCH` (bucket 3) | 2026-10-15 | n/a | – | Prod shape unchanged: no prod project has `sources` and `DISPATCH` is off, so nothing is registered (router test proves the empty route list) and the golden prompts are byte-identical. Canary 2026-10-15 18:16 (home restart): the bluefin-ops brief's session init listed `host` and `sources` as `connected, source: sdk`; 14 `mcp_message` calls on the channel (stats, unanswered ×2, stuck, get, search ×2, propose); `propose` answered with the content-hash id `p-6530b394d846` and the gate. No mount exception: owen-ops' review loader reads the old container's mount until `attribution-layer` replaces it — do not recreate `proj-owen-ops` before that. `snapshot/plain/host-mcp.mjs` deleted in the follow-up. |
| Slack scope: `sources.slack.channels` allow-list + `slack.kinds` (OpenSpec `sources-slack-channel-allowlist`) | #144 | `sources` config; both keys optional | 2026-10-14 | n/a | – | Bucket 2: absent keys = today's pull (scope test proves the unscoped selection is the identity). Canary: bluefin-ops pulls exactly the seven `#bluefin-aven-*` channels — `scope: 7 of N conversations` in the log, no `dm:` container in its store. |
| Sources MCP 1.4.0: `unanswered` / `stuck` readouts, prompt paragraph names them (OpenSpec `sources-field-readouts`) | #143 | `sources` config | 2026-10-14 | n/a | – | Bucket 2: the server and the paragraph only exist for projects with a `sources` block; `multi-repo-sources.txt` re-snapshotted on purpose, the two prod fixtures are byte-identical. Canary: the 18:30 close quotes `unanswered` permalinks and says which subject it used. |

### Retired

| Flag | Default since | PR |
|---|---|---|
| – | | |
