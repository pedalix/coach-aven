# Multi-tenancy — Design & Options

> Decision doc. CoachAven today serves **one Slack workspace** (ours). We want to serve
> **multiple clients**. There are two fundamentally different ways to do that, and they
> differ by an order of magnitude in cost and in what they unlock. This lays out both so we
> can pick deliberately.

> **DECIDED 2026-07-10: Option B (workspace multi-tenancy, Public Distribution + OAuth),**
> **full multi-tenant SaaS as the target, built in slices.** Slice 1 is in: the OAuth
> install flow over Socket Mode (`SLACK_CLIENT_ID/SECRET/STATE_SECRET`), an
> `InstallationStore` persisting per-workspace bot tokens in `state.json`
> (`src/chat/slack/installations.ts`), per-event team tokens in the handlers, and a **tenant gate**
> (home team + `SLACK_ALLOWED_TEAMS`) so an unexpected install can't reach our global
> registry. Option A's shared-channel model remains possible in parallel — the two
> aren't exclusive.
>
> **Slice 2 is in (per-team project registries):** the `workspaces` block in
> projects.config.json scopes projects per tenant (`teamProjects`/`projectOwnerTeam`,
> src/projects.ts); session keys carry an optional tenant prefix (src/teamkeys.ts — home
> stays bare, ZERO migration for pre-slice-2 home records); EVERY persisted record carries
> an explicit `teamId` (stamped from the key by the store for chats/queued turns), giving
> `Store.exportTenant`/`purgeTenant` for offboarding; pollers/routines/recovery resolve
> each record's own workspace client (`clientForTeam`); App Home is per-tenant with an
> onboarding view for installed-but-unmapped workspaces; `/aven` is tenant-scoped
> (`reload`/`usage` home-only, `review auto` owner-team-only); a claim-on-act LRU in
> events.ts guards against Slack Connect double envelopes. ⚠️ **Deploy slice 2 BEFORE
> admitting any client team** — a team allowlisted earlier would have bare-keyed records
> that orphan. **Connect spike RESULT (2026-07-13, live ext-shared channel, app installed
> on BOTH sides):** Slack dedupes per app — one event → ONE envelope, `authorizations[0]`
> = the channel's host-side installation, even when the OTHER side's bot user is the one
> mentioned. So: no double delivery for one app (claim-on-act stays as a safety belt only;
> real duplication needs two different apps), and in a shared channel the acting tenant is
> the HOST side regardless of which bot user is @mentioned — keep ONE bot per shared
> channel. Envelope journaling: `AVEN_EVENT_LOG=1|full` (events/<day>.jsonl; `full` adds
> raw bodies — trusted phase only); captured shapes are replay fixtures for the
> **digital-twin tests** (`src/chat/slack/twin.ts` + `twin.test.ts`, zero network).
> Still ahead (see §3): uninstall/tokens_revoked handling, SQLite, self-serve onboarding.

---

## Enabling multi-workspace installs (operator steps)

Set `SLACK_CLIENT_ID` + `SLACK_CLIENT_SECRET` + `SLACK_STATE_SECRET` and the bot serves
`/slack/install` on `SLACK_OAUTH_PORT`; other workspaces install from that link (enable
Public Distribution in the Slack app admin, register your `https://<host>/slack/oauth_redirect`).
Per-workspace tokens land in `state.json`; events still ride the one Socket Mode connection.
The `workspaces` block in `projects.config.json` maps each team id to the slugs it may see:

```jsonc
"workspaces": { "T0YOURHOME1": ["shop", "monitoring"], "T0CLIENT001": ["monitoring"] }
```

No block = single-tenant. With it, membership is explicit-only and every record carries
the owning team — admit a client workspace only on a build that includes slice 2 (the status
note above). The rest of this page is the decision record behind it.

---

## 0. TL;DR

| | **Option A — Slack Connect** (channel = tenant) | **Option B — Workspace multi-tenancy** (app per workspace) |
|---|---|---|
| Client interaction | Joins a **shared channel** in *our* workspace | Installs *our* app into **their own** workspace |
| Slack work | ~none (already supported) | OAuth install flow + InstallationStore + public endpoint |
| Keeps Socket Mode / no-ports | ✅ yes | ⚠️ events yes, **install needs a public HTTPS endpoint** |
| `state.json` re-keying | not needed | needed (`team_id`-scoped keys) |
| Effort | **S–M** | **M–L** |
| Best for | agency/consulting: we run projects *for* clients, collaborate | a self-serve product clients install themselves |

**Recommendation:** start with **Option A**. It matches how we already work (a client joined a
bot channel via Slack Connect and it worked), costs little, and the isolation we actually care
about — separate repos/sandboxes per client — **already exists**. Option B is the right move only
if/when we want clients to self-install the bot into their own workspaces as a product.

The two are **not mutually exclusive**: the tenant model from Option A is a prerequisite for B,
so doing A first is also the safe first step *toward* B.

---

## 1. What already exists (the single-tenant baseline)

CoachAven already isolates **per project**, and a project is already bound to a channel. This is
most of "tenancy" under a different name:

| Concern | Where | Already isolated? |
|---|---|---|
| Sandbox | `proj-<slug>` warm box, `SANDBOX_NAME_PREFIX` (`config.ts`) | ✅ per project; prefix proven by dev/prod split |
| Repos | `project.repos[]`, cloned side by side (`tasks.ts:prepareChat`) | ✅ per project |
| GitHub token | `getGitHubToken` mints a token **scoped to only that project's repos**; installation **auto-discovered from the repo owner** (`github.ts:discoverInstallationId`) | ✅ per project, multi-org-ready |
| Claude session | one Claude conversation per thread/DM (`state.ts` chats) | ✅ per conversation |
| MCP servers | `project.mcp[]` materialized per sandbox (`project.ts:seedMcpConfig`) | ✅ per project |
| System prompt | `project.systemPrompt` layered onto the base (`prompt.ts:buildSystemPrompt`) | ✅ per project |
| Channel binding | explicit `slackChannel` id **or** `aven-<slug>` name wildcard (`slack.ts:pickProject`) | ✅ per channel, **channel-id is workspace-agnostic** |

**What is *global* (single-tenant) today:**

- **Slack**: one app, one bot token + one app token, Socket Mode (`config.ts`, `slack.ts`).
- **Claude**: one `CLAUDE_CODE_OAUTH_TOKEN` (one Claude Max subscription) for all projects.
- **Sandboxes**: one Docker host per installation (`SSHDOCKER_HOST`), every project's container on it.
- **GitHub App**: one App (`pedalix-factory`), though it can be installed on many orgs.
- **State/config**: a flat `projects.config.json` list and a single `state.json`, keyed by
  `thread:<ts>` / `dm:…` / `cmd:…` with **no tenant dimension**.

So the gap to "tenancy" is: a **tenant dimension** over config/state, and **per-tenant
credentials** where today there's one global value. The two options differ mostly in **how Slack
fans out**, and everything else is shared plumbing.

---

> **Note (2026-10-20):** sections 2–6 are the option analysis of 2026-07, when sandboxes ran on a
> self-hosted Daytona, and they stay as written. The Daytona driver has since been removed
> (OpenSpec `retire-daytona-driver`): every sandbox is a container on the installation's Docker
> host (`SSHDOCKER_HOST`, `docs/sandbox-drivers.md`). Where they name a Daytona key, org or
> instance, read that host; for `makeDaytona(cfg)`, read `createDriver(cfg)`.

## 2. Option A — Slack Connect (channel = tenant)

### How it works
The bot stays installed **only in our workspace**. Each client is invited — via **Slack Connect**
— into one or more **shared channels**. The bot is a member of those channels; it reads and posts
there. A "tenant" is a **channel (or a group of channels)**, identified by its **channel id**
(globally unique, and the same regardless of which workspace a participant is in).

This is essentially the model we have, plus an explicit grouping when a client owns several
channels. The explicit `slackChannel`-id binding in `projects.config.json` already makes this
**workspace-agnostic and granular** — exactly the "bind channels to tenants regardless of
workspace" idea.

### What changes in code
1. **Tenant grouping (only if per-client billing/audit is wanted).** Add a thin layer:
   ```jsonc
   {
     "tenants": {
       "acme": { "claudeOauthToken": "${ACME_CLAUDE}", "daytona": { "apiKey": "${ACME_DAYTONA}" }, "sandboxPrefix": "acme-" }
     },
     "projects": [ { "slug": "acme-web", "tenant": "acme", "repos": [ ... ], "slackChannel": "C…" } ]
   }
   ```
   Resolve credentials as **tenant → fall back to global default** at `openChat` time.
   `seedClaudeAuth(sandbox, token)` already takes the token as a parameter, and `makeDaytona(cfg)`
   already builds the client from cfg — so this is a **prop-drill, not a refactor**.
2. **Per-tenant sandbox prefix** (`<tenant>-proj-<slug>`) — reuses the existing
   `SANDBOX_NAME_PREFIX` mechanism for clean visual/operational separation on the shared Daytona.
3. **Access control (the real must-have — see §4).** In a shared channel, *any* external
   participant can drive Claude Code. Add a per-channel/tenant allowlist.

### What does NOT change
- No OAuth, no InstallationStore, no public endpoint — **Socket Mode and the no-ports/no-TLS
  property stay intact.**
- **`state.json` keys stay as-is**: the bot is in one workspace, so message `ts` values share one
  coordinate system — no cross-workspace key collisions.
- GitHub: one App installed on each client's org; `discoverInstallationId` already resolves it.

### Pros
- Tiny delta over today; matches our actual (agency) workflow.
- Strongest isolation property is free: a channel maps to one project's repos, so **a client
  literally cannot reach another client's code** from their channel.
- Keeps the operationally simple single-process / Socket-Mode deployment.

### Cons / limits
- Clients don't get "their own" app in their sidebar; they only see shared channels.
- Everything runs under **our** Slack app, **our** rate limits, and (unless we split credentials
  per tenant) **our** Claude/Daytona billing.
- Not self-serve: onboarding a client is us creating a channel + Connect invite + a config entry.

### Caveat to verify (½-day spike)
Slack Connect has historically had edge cases. Confirm in a real shared channel that: (a) the bot
receives `app_mention` and `message` events from **external** users; (b) the event payload lets us
identify the sender's team (for allowlist/attribution); (c) `conversations.info`, reactions, and
interactive buttons all work across the Connect boundary. (Our existing channel suggests yes, but
confirm before committing.)

---

## 3. Option B — Workspace-level multi-tenancy (app per workspace)

### How it works
We **publish/distribute** the Slack app so each client **installs it into their own workspace**.
A "tenant" is a **Slack workspace** (`team_id`). Each install yields that workspace its own bot
token; the bot lives in the client's sidebar like any installed app.

### What changes in code
1. **Slack distribution + OAuth.** Enable distribution, implement the **OAuth install flow** and
   an **InstallationStore** that persists each workspace's bot token keyed by `team_id`. Bolt
   supports this, but it requires a **public HTTPS redirect/callback endpoint** for installs.
   - Runtime **events can still ride Socket Mode** (the app-level token is app-scoped; installed
     workspaces' events arrive on our one socket), so the public endpoint is needed **only for the
     install handshake**, not for steady-state traffic. Still, it's the one place the
     "no nginx / no ports / no TLS" simplicity gives a little.
   - **Public App Directory** listing needs Slack review; an **unlisted distributed app**
     (private install link to known clients) does not — the pragmatic B2B path.
2. **Per-team token at every Slack call.** Each `chat.*` call must use the installing team's
   token. Bolt injects the right `client` per event via the InstallationStore; our handlers
   already use the per-event `client` in most places — a couple of spots that reach for
   `app.client` (e.g. startup recovery, `runAsk`) need the team-scoped client.
3. **`state.json` re-keying.** A message `ts` is unique only **within** a workspace. Keys must
   become tenant-scoped (`<team_id>:thread:<ts>`, …). Touches `state.ts`, `slack.ts`, `tasks.ts`.
4. **Tenant-scoped config/resolution.** `projects.config.json` becomes
   `team_id → { projects[], githubOrg, claudeAuth, daytona }`; `pickProject` resolves within the
   installing team.
5. **Move off single-file state → SQLite.** N installs × per-team tokens × install records strain
   the whole-file-rewrite `state.json` (already flagged as "later"). This is the natural trigger.

### Pros
- True product shape: clients self-install; the bot is "theirs."
- Clean per-workspace boundary for tokens, attribution, and (with per-tenant creds) billing.
- Scales to many clients without us hand-creating channels.

### Cons / cost
- The OAuth/InstallationStore/public-endpoint work is real, and it **changes the deployment shape**
  (we now expose an HTTPS surface).
- State re-keying + config restructuring + SQLite migration are a meaningful refactor.
- More moving parts to operate (install lifecycle, token revocation, uninstalls).

---

## 4. Cross-cutting (applies to BOTH options)

These are needed regardless of which Slack model we pick.

- **Access control — highest priority.** Today, anyone in a bound channel can trigger a run that
  reads/edits repos and opens PRs. With clients in the loop (especially external Connect users in
  Option A), we want a **per-channel/tenant allowlist** of who may drive the bot, and optionally a
  guard that a channel can only ever touch its own project's repos. The repo-scoping already
  enforces the *data* boundary; the allowlist adds the *actor* boundary. `liveTurn` has the
  sender's user/team available, so the check is cheap.
- **Per-tenant credentials (optional, billing-driven).** Decide whether clients share our Claude
  Max subscription + Daytona, or get **per-tenant Claude API keys / Daytona orgs** for cost
  attribution and quota isolation. The seams (`seedClaudeAuth`, `makeDaytona`) are already
  parameterized; this is config plumbing plus a billing decision, not architecture.
- **Daytona isolation level.** Either namespace sandboxes by tenant prefix (cheap, container-level
  isolation — already our model for trusted code), or per-tenant Daytona org+key (real
  quota/audit separation; depends on Daytona multi-org support).
- **Resource planning.** One warm Sail sandbox per (tenant × project) adds up fast; the README's
  gotchas put it at ≥2 vCPU / 4 GiB per warm Sail sandbox. Autostop/caps/quotas matter more as clients multiply.

---

## 5. Recommendation & sequencing

1. **Do Option A first.** Lowest cost, matches the agency model, unlocks real client work now.
   - Land the **tenant grouping** treating today's setup as "tenant 0" (no behavior change).
   - Add the **external-user allowlist** (the security must-have).
   - Add **per-tenant sandbox prefixing**; add per-tenant Claude/Daytona creds only when a client
     needs separate billing.
2. **Treat Option B as a later, product-driven upgrade.** Because Option A introduces the tenant
   dimension cleanly, B becomes "add the Slack OAuth/InstallationStore + re-key state on top,"
   not a rewrite. Don't pay for B until we want self-serve installs.

---

## 6. Open questions for the manager discussion

- Are clients **collaborators in our space** (→ A) or do they need the bot **in their own
  workspace** as a product (→ B)?
- **Billing**: do we eat Claude/Daytona cost, or attribute per client (→ per-tenant credentials)?
- **Audit/compliance**: is a per-tenant credential/audit trail a hard requirement, or
  nice-to-have?
- **Self-serve onboarding**: needed soon, or is hand-onboarding clients fine for now?
- **External access**: which client users may *drive* the agent vs only read along?

---

## 7. Slice 4 — money & boundaries (partially shipped 2026-07-12)

Slice 4 is the "whose money, whose data, who may act" layer. Two parts landed early
(they're additive and don't collide with the slice-2/3 re-keying work); two are designed
here and deliberately wait for slice 2 to merge.

### 7.1 Usage metering — SHIPPED

Every settled agent turn appends a JSONL record to `./usage/<YYYY-MM>.jsonl`
(`src/metering.ts`; hooked in `turn.ts` for both live turns and no-UI asks/dreams):
timestamp, conversation key, project, kind, status, wall-clock, and the token/cost
figures from the claude CLI's `result` event (`usage` + `total_cost_usd`). `/aven usage
[days]` renders per-project (and, once several teams exist, per-workspace) totals.

- **Attribution, not billing.** All turns run on our Claude Max subscription today —
  the `~$` figure is the CLI's computed token cost, i.e. what the traffic *would* cost
  at API prices. That's exactly the number needed to (a) hand-write an invoice, and
  (b) decide when a client's volume justifies a per-tenant API key.
- **Cost is per turn (metering fix, 2026-10).** The CLI's `total_cost_usd` is the
  *process's running total*, not the turn's — every turn of a persistent session reports
  everything spent so far — and from v0.22.0 until this fix it was recorded verbatim and
  summed, so `/aven usage` and the feedback "$ per answer that helped" overstated by
  roughly 2× (home bot, Oct 2026: Σ $47.77 recorded vs ≈ $25 reconstructed; a canceled
  zero-token turn carried the previous turn's exact figure). Records now hold the delta in
  `usage.costUsd` and the raw total in `usage.costUsdCumulative` (`claudeSession.ts`
  `CostDelta`, one per CLI process: starts at 0 on spawn, seeded from the replayed log on
  reattach, restarts if the counter runs backwards). A record without
  `costUsdCumulative` is pre-fix: `/aven usage` reports those on a separate *Legacy* line
  and the feedback section leaves them out of the $ figures, so **totals drop to about
  half of earlier reports** — nothing else about the output changed. Routine turns that
  carry the scheduler's `routineId`/`routineLabel` stamp get their own *By routine* cut.
- **Team attribution is forward-compatible**: records store the conversation key; keys
  gain a `team_id` prefix in the slice-2/3 re-keying and `teamOf()` picks it up with no
  migration. Until then everything aggregates as the home team — which is factually true.
- **Sandbox-hours**: wall-clock agent-active time is the proxy for now. Real per-sandbox
  hours would need accounting on the sandbox host (`docker stats`, container start and stop
  times) — do this when a client is actually billed by sandbox time, not before.

### 7.2 Capacity: global turn cap — SHIPPED

`TURN_MAX_CONCURRENT` (default 4) caps concurrently *running* agent turns across all
conversations, pollers, and (soon) tenants — per-key queues serialize within a
conversation; this caps across them. Waiting turns show "⏳ waiting for a free agent
slot" on their status message. Dreams and `/aven` asks count against the same cap.
Per-TEAM quotas (fairness between tenants, not just a global ceiling) belong after the
re-keying, when a turn knows its team.

### 7.3 Roles / actor gate — SHIPPED (2026-07-13, after slice 2 as planned)

Who inside a workspace may *drive* the agent (run/steer/cancel turns, open PRs, post
YouTrack reports) vs only read along. The tenant gate answers "is this WORKSPACE
served?"; this answers "may this USER act?". Implementation (`src/access.ts` + storage
in `state.json` `teamAccess`, keyed by raw tenant id):

- Policy per workspace: `{ mode: 'open' | 'allowlist', users: [..], admins: [..] }`.
  Default: **open everywhere** — deliberately (2026-07-13): adding a workspace must not
  add process; the allowlist is an opt-in lever (`/aven users restrict`), not a hoop for
  every install. A client team's installing user (from the OAuth record) is still
  pre-seeded as its ADMIN, so `restrict` stays reachable from the client's side later.
- Enforcement at the entry handlers: mentions, DMs, and buttons/modals that start or
  steer work (make_pr, autofix, yt_report + both YT modals, question answer/submit,
  cancel) — each denial names the admins who can grant access. **Thread replies from
  non-cleared users are ignored silently** — viewers chatting in an agent thread must
  not drive it, but per-message denials would spam them. Read surfaces (trails, ticket
  modals, memory, status) stay open to viewers.
- Admin surface: **`/aven users`** (the name `access` was already taken by the
  what's-in-this-channel command): bare = list; `allow @user` / `deny @user` /
  `open` / `restrict` — admin-only (home: any home user; client team: its admins).
  Deny also strips admin rights; removing the LAST admin of an allowlisted team is
  refused (no lockouts). `/aven` viewer verbs: status, usage, users, access, memory,
  prompt; everything else requires drive clearance.

### 7.4 Privacy / DPA — POSITION, revisit before first external client

Data flows to be transparent about with clients (and to put in a DPA when one asks):

- **Client code** is cloned into sandboxes on infrastructure we operate (today: our
  ssh-docker host). Transcripts of agent sessions (including code
  excerpts) live inside the project's sandbox; consolidated memory is journaled to our
  disk (`memory/<slug>/`). Usage metering stores *counts only* — no message content.
- **Prompts and diffs** transit Anthropic (Claude) under our account. Today that account
  is a consumer **Claude Max subscription** — before onboarding a paying external client,
  review whether client workloads on a consumer subscription fit Anthropic's commercial
  terms; the clean answer is a **per-tenant (or at least company) Claude API key**, which
  also makes billing exact instead of attributed. The seams already exist
  (`seedClaudeAuth` takes the token as a parameter; metering shows per-team volume).
- **Slack content** (questions, answers, buttons) stays in the client's workspace under
  their retention policy; our `state.json` keeps thread↔session bindings, not transcripts.
- Action item for the first real client: a one-page data-flow annex (the three bullets
  above), a deletion story ("offboard = delete sandbox + memory journal + state keys +
  usage rows for the team"), and the per-tenant-key decision.
