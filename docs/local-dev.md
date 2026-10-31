# Local development

Three levels, each a superset of the one before. Most changes need only the first.

| Level | You need | You get |
|---|---|---|
| [1. Nothing configured](#level-1-nothing-configured) | Node 24, git | the whole test suite: the Slack and Teams drivers through their twins, the turn engine, the CLI recordings |
| [2. The bot on your machine](#level-2-the-bot-on-your-machine) | + Docker, a GitHub token, a Claude credit | a running bot: the web chat on `localhost`, or a dev Slack app |
| [3. Beside a production bot](#level-3-beside-a-production-bot) | + the isolation settings below | a dev bot that shares a Slack workspace or a Docker host with production without touching it |

Only want to *try* CoachAven, not change it? The quickstart runs the published image with no checkout of `src/`:
[`quickstart.md`](quickstart.md).

## Level 1: nothing configured

```bash
npm ci
npm run typecheck && npm test
```

No account, token or Docker. The tests are the contracts ([`how-we-work.md`](how-we-work.md#tests-as-contracts)):

- **The twins.** The Slack driver runs through the real Bolt app against a recorded Web API
  (`src/chat/slack/twin.ts`); every message, edit and modal it sends is pinned by snapshots under `src/fixtures/chat/`.
  Change the output on purpose and re-record: `UPDATE_SNAPSHOTS=1 npm test`, then read the diff
  ([`fixtures.md`](fixtures.md)). The Teams driver has its own recorded activities (`src/fixtures/chat/teams/`).
- **The CLI recordings.** What the bot relies on in Claude Code is replayed from `src/fixtures/cli/<version>/` through
  the real session code ([`cli-probe.md`](cli-probe.md)).
- **The system prompt** is golden-tested byte for byte (`src/fixtures/prompt/`).

The tests never read `.env` (the test runner skips it), so your settings never change a snapshot.

## Level 2: the bot on your machine

**The quickest: the web chat, no Slack.** From the checkout, with the sandboxes on your own Docker:

```bash
cp .env.example .env
```

Then set, in `.env`:

| Var | Value |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | a `claude setup-token` value (or `ANTHROPIC_API_KEY` — exactly one; neither: your `~/.claude` login) |
| `GITHUB_TOKEN` | a fine-grained token for one test repository (or the GitHub App, as production) |
| `SANDBOX_HOST` | `local` |
| `SANDBOX_IMAGE` | `ghcr.io/pedalix/coach-aven-sandbox-plain:<a release tag>` |
| `WEB_AUTH` | `none` (no login; the listener stays on `127.0.0.1`) |

and point `projects.config.json` (from `projects.config.example.json`) at a test repository (no `sandbox` block: the
plain, unprivileged container). Then:

```bash
npm run orch -- web          # "Web chat running (http://127.0.0.1:8787 …)"
```

Open `http://127.0.0.1:8787`, pick the project's room, ask. The first turn creates the sandbox and clones the
repository.

**With Slack.** You need a Slack app of your own — never production's (Level 3 says why):

1. https://api.slack.com/apps → **Create New App** → **From an app manifest**; pick the workspace, paste
   [`../slack-app-manifest.json`](../slack-app-manifest.json), and name it so it is obviously dev (`CoachAven (dev)`).
2. **Install to Workspace** → the **Bot User OAuth Token** (`xoxb-…`) is `SLACK_BOT_TOKEN`.
3. **Basic Information → App-Level Tokens** → one with `connections:write` → `SLACK_APP_TOKEN` (`xapp-…`).
4. **Socket Mode** → enable.
5. A channel per project, named `<SLACK_CHANNEL_PREFIX><slug>` (`aven-<slug>` by default), with the bot invited:
   channels bind to projects by name.

```bash
npm run orch -- slack        # "Slack bot running (Socket Mode) — N project(s)"
```

**Credentials, once more.** Set **exactly one** of `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY`; both set stops
the boot. `.env` never overrides your shell, so an `ANTHROPIC_API_KEY` your shell exports for another tool makes this a
key installation, or stops the boot beside a token in `.env`. The boot line (`credit: sandboxes run Claude Code on …`)
names the credit and the variable it took; `unset ANTHROPIC_API_KEY` before `npm run orch` if that is not what you
meant.

**Where things live.** `.env`, `projects.config.json` and the state the bot writes (`state.json`, `queue.jsonl`,
`usage/`, …) live in the checkout unless `AVEN_DIR` names another directory ([`runtime-config.md`](runtime-config.md) →
*Installation directory*); the working directory you start from never matters. `state.json` is your local journal:
delete it when it gets weird; you lose only thread → session resumes.

**Dev tasks open real pull requests** against the repositories a project lists: point your projects at a test
repository.

## Preview: a worktree's change before it merges

`npm run preview` in a checkout or worktree starts that checkout's code as a web-chat bot on loopback — the
[quickstart](quickstart.md)'s installation, run from source, on one scratch project (OpenSpec `ship-dispatcher`,
spec `worktree-preview`). It reads nothing from any installation on the machine: not its `.env`, projects, state or
data, so a live node beside it is never touched.

1. Once per machine, `~/.config/coach-aven/preview.env` (or a file named by `PREVIEW_ENV`):

   ```bash
   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…   # or ANTHROPIC_API_KEY=…
   PREVIEW_REPO=your-org/scratch            # a repository you can let an agent push to
   # GitHub access, either:
   GITHUB_APP_ID=123456                     # your GitHub App, installed on the scratch repository's owner,
   GITHUB_APP_PRIVATE_KEY_PATH=/abs/app.pem #   with an absolute key path
   # GITHUB_TOKEN=github_pat_…              # or a fine-grained token: the scratch repository only, Contents + Pull requests: read and write
   ```

   Either way a preview agent reaches the scratch repository only: the bot mints an App's installation token before
   every turn, scoped to the project's repositories (`src/github.ts`). Any other key in the file overrides the
   quickstart's (`CLAUDE_MODEL`, `SANDBOX_IMAGE`, …), except the ones a preview may not carry (Slack, Teams, hub,
   tracker, error tracker) and the ones it sets itself (web chat, port, sandbox prefix, directories).
2. `npm run preview` → `http://127.0.0.1:8790` (the first free port from 8790, so a second worktree gets 8791). No
   sign-in; one room, the `demo` project on `PREVIEW_REPO`.
3. `npm run preview -- stop` stops the bot and removes its sandboxes (`pv-<branch>-*`); `--clean` also removes
   `.preview/` (its `.env`, state and log; ignored by git).

Its turns are real: they spend the credit and may open pull requests on the scratch repository. The sandboxes run on
this machine's Docker from the plain sandbox image of the newest release (`SANDBOX_IMAGE` in `preview.env` for
another). A preview has the web chat only — check Slack- or Teams-specific rendering on the first stage after `ship`.

## Level 3: beside a production bot

Your machine and a production installation can share a Slack workspace and, if you point your dev bot at production's
sandbox host, a Docker host. This level is about keeping them apart.

### Why isolation matters

Two shared resources will bite you if you don't isolate them:

1. **Slack (Socket Mode).** Slack delivers each event to **only one** connected
   socket. If your local bot uses prod's Slack app, it steals ~half of prod's
   events — prod silently half-breaks. → **Use a separate dev Slack app.**
2. **Sandbox containers.** Sandboxes are containers named `proj-<slug>` on the Docker
   host `SANDBOX_HOST` names. They collide only when your dev bot and prod share that
   host: there, the same slug is the **same container**, so local and prod would trample
   each other's worktrees, and one bot's idle stop could end the other's sessions (the
   idle stop and a wake's cleanup assume one bot per container). → **Keep dev sandboxes
   on a Docker host no other installation uses** (`SANDBOX_HOST=local` on your machine,
   the template's value); **on a host another installation also uses, set a distinct
   name prefix** (`dev-proj-`).
   `SANDBOX_MANAGED_BY` — the label your bot's containers carry and its `/aven status`
   listing filter — may differ too (say `coach-aven-dev`), but it does not keep the two
   apart on its own: containers are chosen by name, so the prefix does.

Everything else (the Claude credit, the GitHub App, the Grafana token) is fine to share with
prod for dev.

### The settings

| Var | Dev value | Why |
|---|---|---|
| `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | your **dev** app's | Socket Mode delivers each event to one socket |
| `SLACK_CHANNEL_PREFIX` | `dev-aven-` | the dev bot answers only in its own channels |
| `SANDBOX_HOST` | `local` | dev sandboxes on your own Docker, apart from production's |
| `SANDBOX_NAME_PREFIX` | `dev-proj-` | required when another installation uses the same Docker host |
| `SANDBOX_MANAGED_BY` | `coach-aven-dev` | the label of your containers and your `/aven status` listing |
| `AVEN_DATA_DIR`, the hub settings | your own / unset | otherwise you share production's data and its identity on the hub |

### Gotchas

- **Never run local with prod's Slack tokens** while prod is up — see the Socket
  Mode warning above.
- **Don't ship `state.json` to prod.** `infra/deploy/deploy.sh` deliberately never
  uploads it; prod owns its own.
- A dev sandbox is a *real* container, and on a shared host it counts against prod's
  memory and disk. The idle stop stops it after `SANDBOX_AUTOSTOP_MINUTES`; remove the
  ones you're done with on their Docker host: `docker rm -f dev-proj-<slug>` (or
  `proj-<slug>` on your own machine). Nothing in the bot deletes a sandbox.
