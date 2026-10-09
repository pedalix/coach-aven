---
name: manage-project
description: Add a new project to CoachAven prod OR edit an existing one (add/remove repos, change the system prompt, MCP / gateway route, YouTrack prefixes, sandbox driver, CLI pin, workspace membership) — sync from the box, edit infra/prod/runtime/projects.config.json + projects.d/<slug>.md, wire the bluefin-infra side (gateway route, Auth0 bot client) when needed, then export + /aven reload and verify. Use when the user wants to onboard, change, or remove a project/repo of the Slack coding agent.
---

# Add or edit a CoachAven project (prod)

A project is one entry in **`infra/prod/runtime/projects.config.json`** (gitignored **prod
truth**, NOT the repo-root `projects.config.json`, which is local dev) plus its system
prompt in **`infra/prod/runtime/projects.d/<slug>.md`**. `prod:export` uploads both;
`/aven reload` in Slack re-reads them without a restart. This skill drives the whole
loop: sync → gather → edit → (bluefin-infra side) → confirm → export → reload → verify.

Work against `infra/prod/runtime/` only. NEVER edit the repo-root files for this.

## Step 0 — make sure local runtime == the box (mandatory, before ANY edit)

An export uploads the whole runtime dir, so a stale local copy would silently overwrite
newer prod config (someone edited prod, or another session exported). Compare first:

```bash
source infra/prod/.env
tmp=$(mktemp -d)
ssh -o StrictHostKeyChecking=accept-new "${DEPLOY_USER}@${DEPLOY_HOST}" \
  "tar -C ${REMOTE_DIR} -cf - .env projects.config.json projects.d" | tar -C "$tmp" -xf -
diff -q "$tmp/.env" infra/prod/runtime/.env          # -q: never print secrets
diff -u "$tmp/projects.config.json" infra/prod/runtime/projects.config.json
diff -ru "$tmp/projects.d" infra/prod/runtime/projects.d
rm -rf "$tmp"
```

- **No differences** → proceed.
- **Differences and local has NO unexported work of ours** → `npm run prod:import`
  (pulls `.env`, `projects.config.json`, `projects.d/`, github key) and proceed.
- **Local has changes not on the box** (a half-finished earlier edit) → STOP, show the
  diff, ask the user which side wins. Never import over it or export it blindly.

If SSH/preflight fails, stop and surface the error — don't edit a possibly-stale copy.

## Step 1 — what is being done?

Ask (or infer from the request): **add** a new project, or **edit** an existing `<slug>`.
For an edit, print the project's current entry + whether `projects.d/<slug>.md` exists,
then gather only what changes. The field reference (shape in `src/projects.ts`):

| Field | What / notes | Applies |
|---|---|---|
| `slug` | kebab-case, unique. Sandbox `proj-<slug>`, channel `bluefin-aven-<slug>`, env names `AUTH0_M2M_<SLUG>_*`. **Never rename** an existing one (routing keys orphan live sessions) — add new + remove old instead. | — |
| `repos` | `["Org/repo", …]`, `repos[0]` primary, all cloned side by side. Token scope = repos + their composer deps (automatic, see below). | new sessions; an added repo is cloned at the next chat prep |
| prompt | `projects.d/<slug>.md` — a non-empty file **wins** over the legacy JSON `systemPrompt` (only `coach-aven` still uses the JSON field). Step 2 generates it. | new sessions |
| `mcp` | Gateway projects: exactly `[{"name":"gw","url":"https://<gateway-host>/gw/<slug>/mcp","auth":"gateway-m2m"}]` (name MUST be `gw`). No MCP → `[]`. Direct entries (`url`+`headers` or `command`/`args`/`env`, secrets as `${VAR}` from runtime `.env`) are legacy. | new sessions |
| `mcpDirectBackup` | Not read by the code — the pre-gateway direct list parked for rollback (move it back into `mcp` to bypass the gateway). Keep it when switching a project to `gw`. | — |
| `youtrackProjects` | `["CG","CAR",…]` — YouTrack prefixes whose tagged tickets the investigation poller routes here. A new prefix ALSO needs the bot's read scope in bluefin-infra (`YT_MCP_SCOPES`, see Step 4) or the agent can't read the ticket (CAR-14 lesson). | reload |
| `driver` | `"ssh-docker"` or omitted (= `SANDBOX_DRIVER`, daytona). Changing it means a fresh sandbox on the other provider (`docs/sandbox-drivers.md`). | next turn |
| `sandbox` | ssh-docker only: `{privileged, dind, mounts}` — container-creation flags; existing `proj-<slug>` must be `docker rm`'d to pick them up. | new container |
| `cliVersion` | per-project Claude Code CLI pin (canary over `CLAUDE_CLI_VERSION`). | next chat prep |
| `scrubSecrets` | default true; `false` opts out of redacting pasted secrets. | new sessions |
| `slackChannel` | explicit channel id override — avoid, name binding is the default. | reload |
| `sources` | mail/chat/calendar archive the bot pulls (`docs/sources.md`); needs `orch sources auth` on the host. Rare — follow that doc. | partly |
| `env` | reserved, keep `{}`. | — |
| top-level `workspaces` | tenant → slugs. When present, membership is **explicit-only**: a new slug MUST be added to a tenant (home `T0000FAKE01` unless told otherwise), and a removed slug MUST be removed there too (unknown slug = reload error). | reload |

Not config any more (don't ask for them): `composerAuth` — gone. Private composer deps
are found by the dependency scanner (`docs/project-facts.md`): `facts/<slug>.json`
widens the GitHub token scope and writes `auth.json` automatically, as long as the
GitHub App covers the package repos (it's installed org-wide).

**Removing a project:** drop the entry, its slug from `workspaces`, and its
`projects.d/<slug>.md` (export doesn't delete on the box, harmless — the loader ignores
unknown slugs). Its sandbox `proj-<slug>` and channel stay until removed by hand; say so.

Echo back the assembled entry (or the field diff for an edit) and confirm before writing.

## Step 2 — the system prompt (generate it, don't make the user write it)

Offer to generate/update `projects.d/<slug>.md` from the repos themselves:

1. Read each repo's `CLAUDE.md` / `README.md`
   (`gh api repos/<Org>/<repo>/contents/CLAUDE.md --jq .content | base64 -d`, same for
   README). Write a short factual section: what each repo is (stack/role), how they relate
   (frontend↔backend, shared lib, deploy/merge order), doc links. Coding conventions stay in
   each repo's own CLAUDE.md — the sandbox reads it as the 3rd prompt layer.
2. **Gateway project →** add a tool map: tool names arrive as `mcp__gw__<target>_<tool>`
   (e.g. `youtrack_search_issues`, `grafana_query_loki_logs`, `sentry_search_issues`).
   List which targets this project's route has (bluefin-infra `engine/config.yaml`, the
   project's backend `targets`) and what each is for. Model it on `projects.d/caldora.md`
   / `holidayshop-hsx.md`.
3. **Grafana on the shared stack →** every query must be scoped to this project and exclude
   siblings. Mine the real labels first (works before any sandbox exists):

   ```bash
   scripts/grafana-probe.sh '<selector>' '<metric_prefix>'   # e.g. 'app="holidayshop-dorfberg"' 'holidayshop_'
   ```

   Bake in: datasource catalog (Loki UID is `Loki`), this project's exact selectors,
   a tenant note if data splits by `tenant`/`site_id`, an explicit EXCLUDE list of siblings.
   (For an existing project, `scripts/peek-sandbox.ts <proj-slug> '<cmd>'` can mine real
   past queries from its sandbox — only if the API can't answer.)

For an edit, show the prompt diff, not the whole file. Don't belabor variants.

## Step 3 — edit the prod config

Edit `infra/prod/runtime/projects.config.json` (+ `projects.d/<slug>.md`). Minimal new entry:

```json
{
  "slug": "my-project",
  "repos": ["BluefinOrg/my-repo"],
  "env": {},
  "mcp": [{ "name": "gw", "url": "https://<gateway-host>/gw/my-project/mcp", "auth": "gateway-m2m" }]
}
```

Validate with the real loader (same checks the bot runs on reload — workspaces slugs,
gateway entry shape, sandbox options):

```bash
npx tsx -e "import('./src/projects.ts').then(m=>{const r=m.loadProjects('infra/prod/runtime/projects.config.json');console.log(r.projects.length,'projects:',r.projects.map(p=>p.slug).join(', '))})"
```

Must not throw. For direct `${VAR}` MCP refs, check each `VAR` is in `runtime/.env`; if a
secret is missing ask for it (never invent one), append, keep `chmod 600`.

## Step 4 — the other side: GitHub, gateway, identity (only what this change needs)

**GitHub (new repos):** `gh api repos/<Org>/<repo> --jq .full_name` for each. A 404 means
the GitHub App isn't installed on it — warn, let the user decide.

**Gateway + identity (new `gw` project, or new/changed MCP sources)** live in the
bluefin-infra repo (`/home/ubuntu/phpstorm/bluefin/bluefin-infra`; `engine/README.md` → *Adding
things*, `id/auth0/README.md`). Prepare the change there (on a branch, as a bluefin-infra PR)
and tell the user what to apply — don't apply Terraform or deploy bluefin-infra yourself
unless asked:

1. **Auth0** (`id/auth0/main.tf`): add the slug to `local.projects` → `terraform apply`
   creates the API (identifier = the route URL) + M2M client `coach-aven-<slug>` + grant.
   `terraform output -json m2m_clients` → `id/auth0/.env.clients`; never print secrets.
2. **Gateway** (`engine/config.yaml`): a backend with the project's `targets` (analytics
   first — instructions are cut at 2048 chars) + a route `/gw/<slug>/mcp` with its
   `mcpAuthorization` policy block (copy an existing one; `<slug>:bot` must get the tools
   the bot needs, e.g. `youtrack`). Upstream credentials → `engine/.env`. Then
   `./dep env:upload bluefin-engine && ./dep deploy bluefin-engine`.
3. **YouTrack prefix** (new project or new `youtrackProjects` entry): the bot's `youtrack`
   target is our read-only mcp-youtrack, scoped per basic-auth user via `YT_MCP_SCOPES`
   in the observability `.env` — add the prefix there (and an htpasswd user +
   `YT_MCP_BASIC_AUTH_<SLUG>` for a new project). Prefix in `youtrackProjects` without
   the scope = poller fires, agent can't read the ticket.
4. **CoachAven runtime `.env`:** `AUTH0_M2M_<SLUG>_ID` / `_SECRET` (slug upper-cased,
   `-`→`_`) from `.env.clients`; `AUTH0_M2M_TOKEN_URL` is already there. Any `.env`
   change means **`prod:restart`, not just `/aven reload`** — env is read at boot.

Verify the route before switching the bot to it (expect 200 + instructions; token
request in `engine/README.md` → *Bot identity*):

```bash
curl -s -X POST https://<gateway-host>/gw/<slug>/mcp -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

Order matters: the gateway route + Auth0 client + `.env` secrets must exist BEFORE the
`gw` entry ships, or the project's sessions start with no tools (401).

## Step 5 — show the diff and confirm deploy

Show what changed: config diff vs the Step 0 box copy (or the added block), the prompt
diff, `.env` keys added (names only), and anything still pending in bluefin-infra. Then ask:

> Выкатываем на прод сейчас? (export + reload)

Do not proceed to Step 6 without an explicit yes.

## Step 6 — deploy

```bash
npm run prod:export     # upload infra/prod/runtime/ (incl. projects.d/) → the box
```

- **Only `projects.config.json` / `projects.d/` changed** → ask the user to run
  `/aven reload` in Slack (home workspace, operator-only). No restart. New sessions get
  the new prompt/MCP; running conversations keep theirs until their claude process ends.
- **`.env` changed** (new M2M secrets, new `${VAR}`) or deployment-wide vars
  (`SNAPSHOT_*`, `SANDBOX_*`, `CLAUDE_CLI_VERSION`…) → `npm run prod:restart`
  (interrupts in-flight turns — say so).

## Step 7 — verify

- `/aven reload` reply: `Config reloaded — N project(s) (added: <slug> / removed: …)`.
- After a restart: `npm run prod:status` (active/running), then the startup line:

  ```bash
  source infra/prod/.env
  ssh "${DEPLOY_USER}@${DEPLOY_HOST}" \
    "journalctl -u ${SERVICE_NAME}.service --since '-90s' --no-pager | grep -E 'Slack bot running|project\\(s\\)' | tail -3"
  ```

  If it failed to start, show the last ~15 journal lines and stop.
- Gateway project: a test turn in the channel should show `mcp__gw__…` tool calls; the
  gateway audit (`./dep logs bluefin-engine` in bluefin-infra) shows `coach-aven-<slug>@bot`.

## Step 8 — Slack channel (new project, manual — tell the user)

1. Create **`bluefin-aven-<slug>`** (exact prefix; a client workspace may use its own
   `channelPrefix` from `workspaces`).
2. Invite the prod CoachAven bot.
3. Post a message — the channel binds by name on first use.

## Done

Summarize: project added/changed (fields), new project count, deploy path (reload vs
restart), bluefin-infra changes made or still pending (PR link, `terraform apply`,
`./dep deploy`), and any manual Slack step. Remind that the repo-root local-dev config
was untouched.
