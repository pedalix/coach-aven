# Chat-Driven Project Agent — v1 (half-page design)

A chat frontend over the existing [thin orchestrator](orchestrator/README.md). Slack first,
but the frontend is incidental — the real contract is **thread → task → Claude session**.

## Model

- **Sandbox = project** (1..N repos; 1:1 is the common case). Already how the orchestrator works:
  one warm sandbox per project.
- **Chat thread = one orchestrator task = one Claude Code session.** First message in a thread →
  `runTask` (worktree + branch + `claude` headless `stream-json`). Follow-up messages in the same
  thread → `attachTask` (mid-session message to the live agent). The bot keeps one map:
  `thread_ts → { project, taskId, claudeSessionId }`.
- **Frontend-agnostic.** Slack is just the first client; a web UI / interactive terminal can drive
  the same task contract later.

## What we explicitly do NOT build for v1

- **No new worktree code.** A task already runs in its own `git worktree` + branch, so
  thread-as-task gives isolation for free. (Concurrent threads on one project don't collide.)
- **No PR machinery.** Claude Code handles git/branches/PRs itself when asked in chat; the existing
  `task:run --draft` path already opens a draft PR when a task warrants it. We don't orchestrate it.
- **Not read-only.** The agent can read *and* build features. The guardrail is **sandbox isolation +
  branch/PR review** (+ existing Loki/Grafana audit), not locked-down tools. Headless runs permissive
  inside the sandbox (Claude can't answer interactive permission prompts anyway).

## v1 scope = the bot service only

1. Slack app (Socket Mode) → on mention/DM, resolve channel/command → **project**.
2. First message → `runTask(project, prompt)`; stream `stream-json` events back into the thread
   (placeholder message edited as the answer/work progresses).
3. Follow-up in the thread → `attachTask(taskId, text)`.
4. Persist the `thread_ts → taskId/sessionId` map (extend `state.json`, single-process for now).

Everything else is reused as-is: persistent sandbox per project, `CLAUDE_CODE_OAUTH_TOKEN` auth,
`pedalix-factory` GitHub App for clone/push/PR, snapshot tooling.

## Deferred (additive, no rework of the above)

- **MCP tools**, per-project + data-driven: YouTrack/U-track, Grafana, etc. → materialized into the
  sandbox's Claude config + secrets injected at provision time. Codebase Read/Grep is just the first tool.
- Approvals surfaced as Slack buttons (the `stream-json` channel already emits `control_request`).
- Web / interactive-terminal frontend on the same sandboxes.
- GitHub push webhook for repo freshness (today: fetch on each prepare).

## Known limitations (accepted for v1)

- Single-process orchestrator (`state.json`); one bot instance.
- GitHub install token ~1h — long single tasks may see a stale token (`attachTask` re-seeds).
- DinD sandboxes are heavy (≥2 vCPU / 4 GiB each) — run a few project sandboxes concurrently,
  not the whole fleet, given the box also runs observability + Archestra.

## Tokens (decided)

**Claude Code token.** Generate once with `claude setup-token` (Claude Max) → the orchestrator
holds it as `CLAUDE_CODE_OAUTH_TOKEN`. **Not baked into the snapshot** (would sit in image layers,
be shared by every project, and go stale). Instead it's **seeded into the running sandbox per turn**
via the toolbox file API (`/root/.cc-token`, written with `fs.uploadFile` so it never lands in
command logs) and injected inline as `CLAUDE_CODE_OAUTH_TOKEN=$(cat /root/.cc-token)`. Snapshot
stays secret-free. A per-project token override (project config) is a later add.

**GitHub token — scoped per project.** The `pedalix-factory` App is installed org-wide (many repos),
but `getGitHubToken()` mints an **installation token scoped to only the project's repo(s)**
(`repositoryNames`) with **least-privilege permissions** (`contents` + `pull_requests` write,
`metadata` read). So even with a broad App, each sandbox gets a token that can touch *only* that
project's repos. Token is short-lived (~1h) and re-seeded per turn (`seedGitHubAuth`). A plain
`GITHUB_TOKEN` (PAT) bypasses this and is **not** repo-scoped — use the App for least privilege.

## Slack integration (built)

**One bot, many channels — channel = project context.** Each Slack channel is bound to a project,
and **each project gets its own isolated sandbox** (`proj-<slug>`); the channel determines which
repo the bot works against. Channels **auto-bind by name** via the wildcard **`bluefin-aven-{project}`**
(e.g. `bluefin-aven-caldora`, `bluefin-aven-cms-general`, `bluefin-aven-dorfberg-monitoring`) — the
`{project}` part is the slug, so no channel ids to wire (an explicit `slackChannel` id still
overrides; prefix configurable via `SLACK_CHANNEL_PREFIX`). Registry: `projects.config.json` (app =
**CoachAven**, `/aven`; manifest in `orchestrator/slack-app-manifest.json`).

Project resolution per turn: **explicit channel-id binding** → **`bluefin-aven-<slug>` name wildcard**
→ leading `<slug>` token (for DMs) → the sole project if the registry has one. Sessions (one per
thread/DM, no shared context):

- **`@mention` / thread reply → public, shared thread** (`thread:<ts>`). Collaborate / build features.
- **DM → private** (`dm:<channel>:<slug>`); a DM needs a project hint (slug) since it isn't bound.
- **`/aven <q>` → private answer in the user's DM** (`cmd:<user>:<slug>`), resolving the project
  from the channel it's run in. Needs `im:write`; falls back to ephemeral in-channel.

Each session is a separate Claude conversation, persisted in `state.json` and resumed via `--resume`.
The agent reads *and* edits the repo; it pushes / opens a PR only if asked in chat. **Multi-repo
per project is wired**: all of a project's `repos[]` are cloned side by side in its sandbox — one
repo → cwd is that repo; many repos → cwd is the project root with each repo as a subdir, and the
GitHub token is scoped to exactly those repos. Special cases: **Sanity** = several codebases → a
`cms-general` channel (multiple `repos[]`) + per-client channels; **Caribou** = one codebase,
many clients → one channel.

```bash
cp projects.config.example.json projects.config.json   # bind bluefin-{project} channels → slug + repos
# .env: SLACK_BOT_TOKEN (xoxb-) + SLACK_APP_TOKEN (xapp-, connections:write) — scopes per manifest
npm run orch -- slack
```

**Enabled-but-not-yet-used (from the manifest), clean next steps:** `interactivity` →
tool-permission approvals as Slack buttons (the `stream-json` channel emits `control_request`);
`reactions:write` → 👀/✅ status acks instead of an edited placeholder; `users:read.email` → map a
Slack user to a GitHub identity for attribution/authz.

## First build step

Bot service → one Slack thread → `runTask` in a Daytona project sandbox → stream the result back →
`attachTask` on the next message. Prove that end-to-end before anything else.
