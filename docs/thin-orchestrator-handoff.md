# Thin Orchestrator — Design & Handoff

> Handoff for a fresh session that will build the **thin orchestrator**: per-project,
> isolated coding-agent sandboxes on our **self-hosted Daytona**, driven by a small
> control script (no AgentBox). Everything here was learned/verified in the exploration
> session (2026-06). Read top to bottom; §5–§8 are the build spec, §9 is cleanup.

---

## 0. TL;DR

- We self-host **Daytona** on the box (`bluefin-daytona`). It works: create sandboxes from an
  image, exec commands, run Docker-in-sandbox, run Claude Code — **all verified**.
- We evaluated **AgentBox** and are **dropping it**: it assumes **Daytona Cloud** in several
  places (public S3+STS, S3-volumes via `mount-s3`, attach hardcoded to `ssh.app.daytona.io`,
  git-bundle upload through the CF-limited API host). 6 self-hosted gaps; not worth it.
- The **thin orchestrator** needs almost none of that: snapshot-from-image + `git clone`
  **inside** the sandbox + toolbox `process/execute` + PTY for live/mid-session. **No S3,
  no mount-s3, no public object storage.**
- Build it as a small script (Python or TS) using the Daytona **REST API / SDK**.

---

## 1. Goal & requirements

Run **coding agents (Claude Code)** in **isolated, ephemeral dev environments**, one per
project, so an agent can use Bash freely: clone the repo, `docker compose`/Laravel Sail up
Postgres+mail, run tests/static analysis, answer questions, open a PR.

Hard requirements (from the user):
- **Per-project isolation** — projects must not affect each other.
- **Docker inside the sandbox** — projects use Laravel **Sail** (docker compose).
- **Trusted code** (their own) → no need for gVisor/Kata/microVM hardening; container
  isolation is enough.
- **Worktree model preferred**: 1 sandbox per project, **N parallel tasks via `git worktree`**
  inside it (cheaper than 1 sandbox/task). Each task = own branch/worktree → own
  `COMPOSE_PROJECT_NAME` so their Postgres/mail don't collide.
- **Mid-session messaging** — be able to send follow-up messages to a running agent.
- **Minimal public surface.**
- **PM-trigger flow** (server-side eventually): PM says "do X on repo Y" → spin sandbox →
  agent implements → returns questions / opens PR → tests/static analysis → teardown.
- ~10 projects.

---

## 2. Platform we already have (self-hosted Daytona)

Deployer app **`bluefin-daytona`** (Docker Compose, `daytona/` in this repo), fronted by
`bluefin-proxy` nginx. Box: `<sandbox-vm>`.

| Thing | Value |
|---|---|
| Dashboard + API | `https://<daytona-host>` (CF orange). API base: `…/api` |
| API auth | API key `dtn_…` (org-scoped), header `Authorization: Bearer <key>`. Key lives in `daytona/.env` (gitignored) / dashboard → Settings → API Keys. |
| Org id | `8fa6734c-74f2-49c0-9504-92b09cf7f259` |
| Sandbox previews / toolbox proxy | `*.meshnet.pro` (+ apex `meshnet.pro`), CF **Full(strict)**, cert `proxy/nginx/ssl/meshnet/` |
| Object storage (MinIO) | `s3.meshnet.pro` (grey-cloud + Let's Encrypt) — **only needed for AgentBox; see §9** |
| Dashboard login | dex local connector, `dev@daytona.io` / `password` (no SSO session — relogin on refresh by design; use external IdP later for nice UX). Agents/automation use the **API key**, unaffected. |

Snapshots currently in Daytona: `daytonaio/sandbox:0.5.0-slim` (default, **no docker**),
`dind-test` (`docker:28-dind`, has docker), `agentbox-base-…` (AgentBox's — can delete).

Non-obvious deploy facts that MUST stay (already in `daytona/docker-compose.yml`):
- **runner `ENVIRONMENT=development`** — `production` breaks embedded-DNS to the nested
  dockerd (can't resolve `registry:6000` → snapshot push fails).
- registry `…Allow-Origin` must be a valid value (not `[*]` — that's a YAML alias, crashes it).
- dex `oauth2.skipApprovalScreen: true`.

---

## 3. Why thin orchestrator, not AgentBox (decision + learnings)

AgentBox **does** run on our self-hosted Daytona (verified: it created real boxes, ran Claude
Code with the user's Claude Max creds, docker worked in-box). But getting there required
fixing **6 Daytona-Cloud assumptions**, and one is unfixable without patching AgentBox:

1. Object storage must be **public + STS** → exposed MinIO (`s3.meshnet.pro`).
2. Default S3 **bucket** `daytona` had to be created manually.
3. Runner image **lacks `mount-s3`** (Daytona bug #3273) → built a custom runner (musl
   compile per PR #4813).
4. `mount-s3` used **virtual-host style** → broke on MinIO → path-style wrapper.
5. Client uploads (git bundle of the repo) hit **Cloudflare's 100 MB** limit on the API host
   → 413 (holidayshop is 640 MB).
6. **`agentbox attach`/`shell` are hardcoded to `ssh.app.daytona.io`** (Daytona Cloud SSH
   gateway) in `packages/sandbox-daytona/src/backend.ts` → interactive attach just
   reconnect-loops on self-hosted. Only `agentbox drive` (relay-based) works.

Also: AgentBox is **box-per-task**, not the worktree model the user wants.

Net: AgentBox is built for Daytona Cloud. On self-hosted it's a permanent maintenance/patch
burden for a worse-fitting model. **The thin orchestrator avoids ALL six** (see §5).

---

## 4. Proven capabilities (tested this session)

- ✅ **Sandbox from image name** (no S3): `POST /api/snapshots {imageName:"docker:28-dind"}`
  → active in seconds; `POST /api/sandbox {snapshot}` → started.
- ✅ **Docker-in-sandbox**: in a `docker:28-dind` sandbox, ran `docker compose up -d postgres`
  → `pg_isready` ok → SQL query returned `42`. Sail will work.
- ✅ **Toolbox exec**: `POST /api/toolbox/:id/toolbox/process/execute {command,timeout}` →
  `{exitCode, result}`. Ran multi-line bash, got stdout. **No S3 involved.**
- ✅ **Claude Code in a sandbox**: with seeded creds, `claude -p "…" --dangerously-skip-permissions`
  ran headless, created a file, AND ran `docker version` inside — all good. (Claude Max via the
  user's `~/.claude` creds.)
- ✅ **Live session + mid-session messaging**: started `claude` in a tmux session in the box;
  injected a message and read the reply back (this is exactly the "send to a running agent"
  capability — works via the toolbox/PTY, not SSH).
- ✅ **`git clone` of a 640 MB private repo works on the host** via `gh` (owner-example-p, scope
  `repo`). In-box clone from GitHub (with a token) avoids the AgentBox 413 entirely.

---

## 5. Thin orchestrator — architecture

One small control program ("orchestrator") on a server (or laptop for now), talking to the
Daytona API. Per project:

```
PM trigger (repo, task)
        │
        ▼
[orchestrator]
  1. ensure sandbox for project P  (create from custom snapshot, or reuse running one)
  2. in-box: git clone P  (first time)        ← clone FROM GitHub with a token (no upload!)
  3. per task: git worktree add ../task-T -b task-T   (COMPOSE_PROJECT_NAME=task-T)
  4. run Claude Code on the task in that worktree (headless `claude -p` OR live PTY)
  5. agent: implement → docker compose up (Sail) → tests/static analysis → git push → gh pr
  6. stream logs back; allow mid-session messages (PTY send-input)
  7. teardown worktree / stop or destroy sandbox
```

Why this dodges the AgentBox pain:
- **No S3 / mount-s3 / volumes** — workspace comes from `git clone` *inside* the box, not an
  uploaded volume. (Optional later: a Daytona **volume** for a shared dep cache → would need
  the runner mount-s3 patch + S3; only if speed demands it.)
- **No CF upload limit** — the repo is pulled from GitHub by the box, not pushed through the
  API host.
- **No SSH attach** — interaction is via the toolbox API (exec + PTY), which works on
  self-hosted. We drive the agent; a human can also use the **Daytona dashboard terminal**
  (`tmux attach -t <session>`).
- **Worktree model** — exactly the user's preference; trivial to implement (it's just bash in
  the box).

Isolation: 1 sandbox = 1 container = 1 nested docker daemon per project → projects fully
separated. Within a project, tasks share the box but are isolated by worktree + distinct
`COMPOSE_PROJECT_NAME` + non-conflicting ports (or container-network only, no host publish).

---

## 6. Daytona technical reference (verified endpoints)

Base: `https://<daytona-host>/api`, header `Authorization: Bearer <API_KEY>`.
(The SDKs — `@daytonaio/sdk` TS, `daytona` Python — wrap these; both read
`DAYTONA_API_URL` / `DAYTONA_API_KEY` / `DAYTONA_ORGANIZATION_ID` from env. SDK
sandbox/process/fs calls go through the toolbox — **S3-free**; only declarative image builds
and volumes touch S3, which we avoid.)

Snapshots:
- `POST /api/snapshots` `{name, imageName, cpu, memory, disk, entrypoint?}` — from an **image
  name** (no build context → no S3). Poll `GET /api/snapshots/:id` until `state:"active"`.
- `GET /api/snapshots?limit=`, `POST /api/snapshots/:id/activate`, `DELETE /api/snapshots/:id`.

Sandboxes:
- `POST /api/sandbox` `{snapshot, env?, cpu?, memory?, disk?, autoStopInterval?}` → poll
  `GET /api/sandbox/:id` until `state:"started"`.
- `POST /api/sandbox/:id/start`, `/stop`, `DELETE /api/sandbox/:id`, `GET /api/sandbox`.
- Preview URL for a port: `GET /api/sandbox/:id/ports/:port/preview-url` and
  `…/signed-preview-url` (token-bearing, bypasses OIDC — for sharing a live app/VNC).

Toolbox (per sandbox; this is the interaction surface):
- Exec (sync): `POST /api/toolbox/:id/toolbox/process/execute` `{command, cwd?, timeout, env?}`
  → `{exitCode, result}`.
- PTY (live / mid-session): `POST /api/toolbox/:id/toolbox/process/pty` (create),
  `GET …/process/pty/:sessionId`, `POST …/process/pty/:sessionId/resize`. Use the PTY to run
  interactive `claude` and feed follow-up input.
- Sessions: `POST …/process/session`, `…/session/:sid/exec`, `…/session/:sid/command/:cid/logs`.
- Files: `POST …/toolbox/files/upload`, plus fs list/read/write under `…/toolbox/files`.

Auth note: `/api/users/me` and `/api/organizations` reject the API key (they're user-context);
org-scoped resources (snapshots, sandbox, toolbox) accept it. That's expected.

---

## 7. Claude Code inside the sandbox

- **Install**: either bake it into the snapshot image (`npm i -g @anthropic-ai/claude-code`)
  or install at sandbox start.
- **Auth** (pick one, inject as sandbox `env`):
  - `CLAUDE_CODE_OAUTH_TOKEN` — user's **subscription** (Claude Max). Generate once with
    `claude setup-token`. Cheapest; watch subscription rate limits across ~10 parallel agents.
  - `ANTHROPIC_API_KEY` — API billing; more predictable at scale.
- **Headless run**: `claude -p "<task>" --dangerously-skip-permissions --output-format stream-json --verbose`
  (box is isolated → skipping permission prompts is fine).
- **Mid-session**: run `claude` interactively in a PTY (toolbox `process/pty`) and send
  additional user turns via the PTY input. (Stream-json input mode also exists; PTY is simpler
  here.)
- **CLI vs Agent SDK** — both are valid in-box runtimes and **honor the same auth**:
  the Claude Agent SDK *is* the Claude Code engine as a library, so it resolves credentials the
  same way (`CLAUDE_CODE_OAUTH_TOKEN` subscription **or** `ANTHROPIC_API_KEY`) — the SDK is **not**
  API-key-only. Pick by interface, not by billing: the **CLI** (`claude -p … --output-format
  stream-json` + PTY for mid-session) is the lightest path and needs nothing beyond the binary —
  recommended to start. The **Agent SDK** (Python/TS) gives programmatic turn control, structured
  events, and in-process hooks without scraping a PTY — reach for it when the orchestrator wants
  typed streaming instead of parsing terminal output. Avoid `tmux capture-pane` screen-scraping
  for control flow (brittle); use stream-json or the SDK's event stream.
- **Continue / reset**: `claude --resume <session_id>` / `--continue`; new session = run
  without `--resume`. `session_id` comes from `--output-format json`.

---

## 8. Docker-in-sandbox (Sail) — snapshot requirements

- Default `daytonaio/sandbox:0.5.0-slim` has **bash/node/python but NO docker**.
- For Sail/compose you need a snapshot whose image has **docker + dockerd (DinD)**. Verified:
  `docker:28-dind` works as a snapshot (dockerd + compose plugin present; Daytona injects its
  toolbox). DinD-in-the-runner works on our box (`/dev/fuse` present, runner privileged).
- **Recommended: build a custom "project" snapshot image** for Laravel:
  `FROM docker:28-dind` (or a debian base + install docker) **+ PHP+Composer + Node + git + gh
  + Claude Code**. Build it **externally** (host docker / CI), push to a registry the runner
  can pull (Docker Hub / GHCR / the in-stack registry), then
  `POST /api/snapshots {imageName: "<that image>", cpu:2, memory:4, disk:8}`.
  **Do NOT use Daytona declarative builds** (Dockerfile→snapshot) — those upload build context
  to S3 (the AgentBox path we're avoiding).
- Resource note: DinD wants ≥2 vCPU / 4 GiB. ~10 projects each running Sail (Postgres+mail) is
  heavy; the box also runs observability + Archestra. Budget CPU/RAM; run a few at a time.

GitHub access in-box (for clone + push + PR): inject a GitHub token as sandbox env (PAT,
fine-grained token, or a GitHub App installation token). Clone `https://<token>@github.com/…`,
push, and `gh pr create` with the same token. Repo `BluefinOrg/holidayshop-dorfberg` is the
intended first target (Laravel + Sail, 640 MB — clone-in-box handles it fine).

---

## 9. Infra: keep vs revert (for minimal surface)

Everything below is already committed in `daytona/` and `proxy/`.

**KEEP (core to Daytona working / dashboard / previews):**
- runner `ENVIRONMENT=development`, registry CORS value, dex `skipApprovalScreen`.
- nginx vhosts: `<daytona-host>` (dashboard+API) and `*.meshnet.pro` + apex (previews +
  toolbox + auth callback). CF **Full(strict)** on the `meshnet.pro` zone.

**KEEP (decided 2026-06-17) — useful findings, fully documented in `daytona/DEVIATIONS.md`:**
- The **custom runner with `mount-s3`** (`daytona/runner/`, `bluefin-daytona-runner-mounts3`) — the
  legit fix for Daytona **Volumes** on self-hosted (needed if we later add a shared dep cache).
- The **public MinIO** (`s3.meshnet.pro` grey-cloud + Let's Encrypt + certbot, `S3_ENDPOINT`
  public + `MINIO_SERVER_URL` + bucket `daytona`) — working SDK-upload / Volumes capability.
- The thin orchestrator does **not need** either, but they stay as documented deviations (see
  DEVIATIONS.md §1, §2) so any future debugging knows exactly where we drift from stock Daytona.

**DELETED in cleanup (AgentBox experiment leftovers):**
- demo sandboxes `abdemo-*` + the `error`-state sandboxes, and the `agentbox-base-…` snapshot.
- local: the `@madarco/agentbox` CLI, `~/.agentbox/` (incl. the copied claude-credentials), the
  `/tmp/agentbox-src` + `/tmp/daytona-vendor` clones, and `~/work/abdemo` / `~/work/holidayshop-dorfberg`.
- `dind-test` snapshot kept (generic docker-in-box snapshot, handy for testing).

**Long-run S3 (only if we add volumes for caching):** the clean answer is **internal MinIO +
orchestrator running server-side** (inside/next to the daytona network) → `minio:9000` serves
STS+volumes with zero public exposure. Or managed S3 with STS = **AWS S3 only** (R2 / DO
Spaces have **no S3 STS AssumeRole**, which Daytona's `getPushAccess` hard-requires).

---

## 10b. Decisions made + MVP built (2026-06-17)

The orchestrator MVP now lives in [`orchestrator/`](orchestrator/) (see its README). Decisions:

| # | Decision | Choice |
|---|---|---|
| 10.1 | Snapshot image | `docker:28-dind` + git + gh + Node + Claude Code, **no PHP/Composer** (Sail provides them in-container); bare `php`/`composer`/`artisan` shimmed → `sail`. Hosted on **GHCR**. |
| 10.2 | CC auth | `CLAUDE_CODE_OAUTH_TOKEN` (Claude Max subscription) |
| 10.3 | GitHub auth | **GitHub App** installation tokens, re-minted per task |
| 10.4 | Language/shape | **TypeScript** + `@daytonaio/sdk` 0.187.0 |
| 10.5 | State store | JSON file (`orchestrator/state.json`) |
| 10.6 | Lifecycle | **Warm sandbox per project**, worktree per task |

**Validated live (2026-06-17)** against the box, end-to-end except the final push+PR (held back
to avoid a junk PR): sandbox create/reuse, boot **`provisionTooling`** (git/gh/node/Claude Code +
sail shims onto the existing **`dind-test`** snapshot — no GHCR push needed yet), **GitHub App
auth + clone** of `holidayshop-dorfberg` (640 MB, ~15 s), and **Claude Code headless** (`exit 0`,
returned `READY`). Gotchas found + fixed:
- **`IS_SANDBOX=1`** is required — CC refuses `--dangerously-skip-permissions` as root (dind runs
  as root); set it in sandbox `envVars` + inline on the claude command.
- **GitHub auth**: reuse the existing **`pedalix-factory`** App (App ID `3215982`, pem in
  `agentic-factory-core/.factory-data/config/github-app.pem`) — Contents+PR write org-wide,
  installation id auto-discovered. No new App needed. (Personal `gh` token also works but lacks
  `write:packages`, so it can't push the GHCR image.)
- CC token for the test = the `accessToken` from this box's `~/.claude/.credentials.json`
  (expires; use `claude setup-token` for sustained use).

Remaining: run a full `task:run` (opens a real draft PR), then bake+push the GHCR image to make
cold-starts faster (turns `provisionTooling` into a no-op).

## 10. Open decisions for the new session

1. **Snapshot image**: build the custom Laravel image (docker + PHP/Composer/Node + gh + CC)?
   Where to host it (GHCR? Docker Hub? in-stack registry)?
2. **CC auth**: `CLAUDE_CODE_OAUTH_TOKEN` (subscription) vs `ANTHROPIC_API_KEY` (billing).
3. **GitHub auth in-box**: PAT vs fine-grained token vs GitHub App.
4. **Orchestrator language/shape**: Python or TS; raw REST vs `@daytonaio/sdk` / `daytona` SDK.
5. **State store**: SQLite/JSON for projects ↔ sandboxes ↔ tasks.
6. **Sandbox lifecycle**: 1 persistent sandbox per project (warm, faster) vs ephemeral per
   trigger. Worktrees argue for persistent-per-project.
7. **UI**: start headless (CLI/JSON); add a thin web UI (task list + log stream + message box)
   later once the loop is stable.
8. **Where the orchestrator runs**: laptop now, server-side later (PM triggers).
9. **Revert the AgentBox-only infra** now (§9) or leave it?

---

## 11. First steps in the new session

1. Decide §10.1–§10.4.
2. Build + push the custom Laravel snapshot image; register it as a Daytona snapshot
   (`POST /api/snapshots {imageName}`).
3. Write the orchestrator MVP:
   - create/reuse a sandbox from that snapshot (with CC + GitHub env);
   - in-box `git clone BluefinOrg/holidayshop-dorfberg`;
   - `git worktree add` for a task;
   - `claude -p "<task>"` (headless) in the worktree, stream logs via toolbox exec/session;
   - add mid-session via PTY;
   - `git push` + `gh pr create`.
4. Validate on `holidayshop-dorfberg`: bring up Sail, run `php artisan test`, open a draft PR.
5. (Optional) revert AgentBox-only infra per §9.

Verified working patterns to copy from this session live in the conversation transcript and in
`daytona/README.md` (deployment) — this doc is the orchestrator-specific distillation.
```
