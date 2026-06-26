# Multi-tenancy — Design & Options

> Decision doc. CoachAven today serves **one Slack workspace** (ours). We want to serve
> **multiple clients**. There are two fundamentally different ways to do that, and they
> differ by an order of magnitude in cost and in what they unlock. This lays out both so we
> can pick deliberately. **No code has been written for either** — this is the pre-decision.

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
| System prompt | `project.systemPrompt` layered onto the base (`tasks.ts:buildSystemPrompt`) | ✅ per project |
| Channel binding | explicit `slackChannel` id **or** `bluefin-aven-<slug>` name wildcard (`slack.ts:pickProject`) | ✅ per channel, **channel-id is workspace-agnostic** |

**What is *global* (single-tenant) today:**

- **Slack**: one app, one bot token + one app token, Socket Mode (`config.ts`, `slack.ts`).
- **Claude**: one `CLAUDE_CODE_OAUTH_TOKEN` (one Claude Max subscription) for all projects.
- **Daytona**: one API key / org; one shared instance.
- **GitHub App**: one App (`pedalix-factory`), though it can be installed on many orgs.
- **State/config**: a flat `projects.config.json` list and a single `state.json`, keyed by
  `thread:<ts>` / `dm:…` / `cmd:…` with **no tenant dimension**.

So the gap to "tenancy" is: a **tenant dimension** over config/state, and **per-tenant
credentials** where today there's one global value. The two options differ mostly in **how Slack
fans out**, and everything else is shared plumbing.

---

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
- **Resource planning.** One warm Sail sandbox per (tenant × project) adds up fast; the README
  already warns ~10 is heavy. Autostop/caps/quotas matter more as clients multiply.

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
