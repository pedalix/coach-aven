# Security: what goes where

What an installation sends to whom, what the sandbox can reach, how long things are kept, and the risks the design
accepts. To report a vulnerability, see [`SECURITY.md`](../SECURITY.md); the invariants behind this page are in
[`how-we-work.md`](how-we-work.md#invariants).

## The boundary

The **sandbox is the untrusted side**. Claude Code runs there as root with its permission prompts off, next to
whatever the project's repositories, dependencies and tools bring, and it reads text from people and documents. So
everything that enters a sandbox is treated as readable by the model and by any code that runs there.

The **orchestrator** (the bot) keeps its own long-lived credentials out of every sandbox: the GitHub App private key,
the chat platform's tokens, the gateway client secret, the sources' refresh tokens, the hub keys. It mints short-lived
tokens on the host and hands only those to a sandbox.

## Data flow

| From → to | What crosses | Enforced by |
|---|---|---|
| Chat → bot | mentions, direct messages, replies in threads the bot is in, commands, buttons, attachments. The chat driver never reads a channel's history (the sources extension does, for the channels you list) | Slack Socket Mode / Teams Bot Framework / the web chat's own login; the core's gates decide who may drive |
| Bot → sandbox, per turn | the model credit (`/root/.cc-token`), a GitHub token for the project's repositories and the same-organization dependency repositories its manifests name (`/root/.gh-token`: an App installation token, about an hour; or your `GITHUB_TOKEN` as is, with whatever scopes it has), the MCP configuration with the credentials the project declares and a gateway token with the lifetime its OAuth server issues, composer `auth.json` for private packages, attachments under `/root/inbox/`, the scrubbed message, the system prompt, the project's memory files | files written through the driver, owner-only; the scrubber (`src/scrub.ts`) on what people type, unless the project sets `scrubSecrets: false` |
| Sandbox → Anthropic | the whole Claude Code session: the system prompt and the repository's `CLAUDE.md`, the code it reads, build and test output, MCP results, attachments | your model credit and Anthropic's terms for it |
| Sandbox → GitHub | clone, fetch, push, pull requests — with an App token: `contents: write`, `pull_requests: write`, `checks: read`, `metadata: read` on those repositories | the token's scope (the App mint intersects with what the installation granted; a `GITHUB_TOKEN` is used as is); **branch protection** on your side |
| Sandbox → the internet | unrestricted egress, with the MCP credentials and the gateway token it holds | nothing in CoachAven — see *Accepted risks* |
| Bot → GitHub API | the App's JWT, installation tokens per turn and per poll, pull request and CI reads | the App's permissions |
| Bot → Docker host | container lifecycle, exec, file uploads — over SSH, or the local socket | the SSH key or the socket's group |
| Bot → error tracker (only with a DSN) | errors and traces (sampled at 1.0 by default); logs only with `SENTRY_LOGS` | the event message, exception text and log lines are scrubbed of token-shaped strings; breadcrumbs, contexts and traces are not |
| Bot → relay hub (only with `HUB_URL`) | sealed envelopes between installations; the hub sees installation names, sizes, times and allow-lists, and keeps an undelivered envelope 7 days | end-to-end sealing (`src/messaging/seal.ts`) |
| Sources (extension, only when configured) | mail, chat, calendars, trackers pulled with refresh tokens under `~/.config/coach-aven/sources/<slug>/`; raw and indexed data under `data/<slug>/`; the agent reaches it only through the bot's host tools | scrubbed at ingest; read-only tools |
| Teams (only on a Teams installation) | an inbound HTTPS endpoint behind your proxy; tenant-wide consent for the files people share | Microsoft's bot authentication |

Nothing goes to this project: an installation has **no telemetry**.

## Retention

| What | Where | Kept |
|---|---|---|
| Thread → session bindings | `state.json` | 45 days after a thread's last activity |
| Reviewed pull requests | `state.json` | 90 days |
| Agent-messaging tasks and held messages | `state.json` | 30 days after a task ends or a message was held |
| Usage and answer ratings | `usage/<month>.jsonl`, `feedback/<month>.jsonl` | until you delete them |
| Web chat history and uploads | `<data dir>/web/<slug>/` (`AVEN_DATA_DIR`, default `data/`) | until you delete them (no policy yet) |
| Chat event metadata | `events/` | only with `AVEN_EVENT_LOG=1` (raw bodies only with `=full`); until you delete them |
| Queued turns, report drafts, agent-messaging journals | `queue.jsonl`, `drafts/<slug>/`, `shadow/` | until the turn runs / you delete them |
| Session transcripts | inside the sandbox (`/root/.claude/projects/`) | until the container is recreated |
| Project memory | `memory/<slug>/` (a git repository) | until you delete it |
| Sources | `<data dir>/<slug>/` | until you delete them |

Back up `state.json` and the directories above together; delete a project's directories to forget it.

## Accepted risks

- **The agent can read every credential in its sandbox**, the model credit included, and so can any code it runs
  (package scripts, a client repository's tooling). Mitigation: per-project, short-lived GitHub tokens; on an API key, a
  dedicated key in its own Anthropic workspace with a monthly spend limit; MCP credentials behind the gateway, which
  hands the sandbox a token instead of the upstream secret.
- **No egress filtering.** A sandbox can reach any host, and a prompt-injected agent could send what it can read
  anywhere. CoachAven does not filter outbound traffic and has no plan to yet.
- **The `pr` git flow is an instruction, not a permission.** The token can push to any branch it is scoped to; require
  reviews on the default branch so that GitHub, not the prompt, enforces "people merge".
- **Privileged docker-in-docker** is what a project gets with `"sandbox": { "dind": true }`, and, until a later
  release, a project without a `sandbox` block (the boot names those). Such a container is root-equivalent on its
  Docker host. Prefer sysbox (`SANDBOX_DIND_RUNTIME=sysbox-runc`) and keep the sandbox host separate from the bot's in
  production; a project that needs no Docker inside runs plain (`"privileged": false, "dind": false`). On the bot's
  own machine a privileged project needs `SANDBOX_LOCAL_PRIVILEGED=1`, or the boot says why it should not run there.
- **Local sandboxes share the bot's machine.** With `SANDBOX_HOST=local` the bot holds the Docker socket
  (root-equivalent) and the sandboxes are its siblings. The quickstart runs them unprivileged; keep this mode for trials
  and single-operator installations.
- **Only what people type is scrubbed** (and sources at ingest), unless a project sets `scrubSecrets: false`. Attachments,
  MCP results, files the agent reads, build output and the agent's answers are not.
- **The web chat's sign-in link** (`WEB_AUTH=link`, the quickstart) is in the bot's log until the next restart; anyone
  who can read that log can sign in. A shared host uses OIDC.

## Before you adopt it

- Who may drive the agent, and which projects each workspace sees (`workspaces`, the access commands)?
- Which repositories does each project's token reach, and is the default branch protected?
- Which MCP servers does each project declare, with what credentials — and can they sit behind a gateway?
- Where do the sandboxes run, privileged or not, and on which host relative to the bot?
- Which model credit, with what spend limit?
- Is an error tracker or the relay hub configured, and do you accept what they see?
- Who backs up and deletes the installation directory's data?
