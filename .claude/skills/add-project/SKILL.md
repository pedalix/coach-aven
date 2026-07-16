---
name: add-project
description: Add a new project to CoachAven prod — interactively gather slug/repos/prompt/MCP, edit infra/prod/runtime/projects.config.json, then export + restart the prod bot and verify. Use when the user wants to onboard a new project/repo to the Slack coding agent.
---

# Add a project to CoachAven (prod)

A project is one entry in **`infra/prod/runtime/projects.config.json`** — the
gitignored **prod truth** (separate from the repo-root `projects.config.json`, which
is local dev). The prod bot reads this file **once at boot**, so any change needs a
**restart** to take effect. This skill drives the whole onboarding: gather inputs →
edit the prod config → `export` → `restart` → verify, plus the Slack/GitHub checks.

Work against `infra/prod/runtime/` only. NEVER edit the repo-root files for this.

## Step 0 — ALWAYS sync from prod first (mandatory)

Before touching ANY file, pull the live prod runtime down so you edit the current
truth, never a stale local copy:

```bash
npm run prod:import     # download .env, projects.config.json, github key → infra/prod/runtime/
```

This is non-negotiable and runs every time — the local `infra/prod/runtime/` may have
drifted from the box (someone edited prod directly, or a half-finished change). Syncing
first guarantees the edit lands on top of what's actually running. If `import` fails
(SSH/preflight), stop and surface the error — do not edit against a possibly-stale copy.

## Step 1 — gather inputs (ask the user)

Use AskUserQuestion / plain questions to collect:

1. **slug** — short kebab-case id. It becomes the sandbox name `proj-<slug>` and the
   Slack channel `bluefin-aven-<slug>`. Must be unique — reject if the slug already
   exists in the config.
2. **repos** — one or more `Org/repo` (e.g. `BluefinOrg/caldora-admin`).
   `repos[0]` is primary. All are cloned side by side in the sandbox.
3. **systemPrompt** (optional) — project context appended after the base prompt:
   domain, what each repo is + how they relate, merge/deploy-order rules, doc links.
   (Repo coding conventions belong in each repo's own CLAUDE.md, not here.)
   Don't make the user write this from scratch — in Step 1.5 OFFER to generate it.
4. **MCP servers?** (optional) — e.g. a Grafana MCP like caldora's. For the shared
   observability stack, use the remote endpoint (NOT a docker-in-docker server):
   `{"name": "grafana", "url": "https://<grafana-host>/mcp", "headers": {"Authorization": "Basic ${GRAFANA_MCP_BASIC_AUTH}"}}`
   (one supervised mcp-grafana on the observe box; creds in `runtime/.env` +
   bluefin-infra `proxy/nginx/htpasswd-mcp`). Other servers: collect name, command,
   args, and any env values — or a url+headers pair for remote ones. Env secrets are
   referenced as `${VAR_NAME}` in the config and the real value goes into `runtime/.env`.

Echo back the assembled project object and confirm before writing.

## Step 1.5 — generate the systemPrompt (don't make the user write it)

Offer to generate it. Two cases:

**No shared-observability MCP →** write 2–4 factual sentences from the repos: what each
repo is (stack/role) and how they relate (frontend↔backend, shared lib, deploy order).
Read READMEs via `gh api repos/<Org>/<repo>/contents/README.md` if unsure. Coding
conventions stay in each repo's CLAUDE.md, not here. Done.

**Has a Grafana/observability MCP on a SHARED stack (holds other projects too) →** the
prompt must scope every query to this project and exclude siblings. Mine the REAL labels
first (one command), then bake them in:

```bash
scripts/grafana-probe.sh '<selector>' '<metric_prefix>'   # e.g. 'app="holidayshop-dorfberg"' 'holidayshop_'
```

It prints the datasource catalog, this project's scoped Loki labels/values, the matching
Prometheus metrics + their distinguishing label, and who else shares the metric prefix.
(It hits the Grafana API directly with the read-only token in `runtime/.env` — works for
a NEW project before any sandbox exists. For an EXISTING project you *can* instead mine
real past queries from its sandbox with `scripts/peek-sandbox.ts <proj-slug> '<cmd>'`,
but the probe is simpler — don't reach for the sandbox unless the API can't answer.)

Then write the prompt with: datasource catalog, this project's exact selectors
(metric prefix + label=value), a tenant note if data splits by a `tenant`/`site_id`
label, and an explicit EXCLUDE list of sibling projects. Model it on the existing
`caldora` / `holidayshop-dorfberg` prompts. Show it and move on — don't belabor variants.

## Step 2 — edit the prod config

Append the new project to the `projects` array in
`infra/prod/runtime/projects.config.json`. Minimal shape:

```json
{
  "slug": "my-project",
  "repos": ["BluefinOrg/my-repo"],
  "env": {},
  "mcp": []
}
```

The system prompt goes into its own markdown file —
`infra/prod/runtime/projects.d/<slug>.md` — NOT a JSON `systemPrompt` string (a
non-empty file wins over the JSON field; the JSON form is legacy fallback only).

**Workspace visibility (multi-tenant):** if the config has a top-level `workspaces`
block, membership is explicit-only — a project not listed under any tenant is invisible
to everyone (channels won't bind, slugs won't resolve). Add the new slug to the right
tenant's list (usually the home team's array) in the same edit. Ask the user which
workspace if unclear.

Then validate the file is well-formed JSON:
`node -e "JSON.parse(require('fs').readFileSync('infra/prod/runtime/projects.config.json','utf8')).projects.length"`
(must not throw; print the new project count).

If the project declares MCP servers with `${VAR}` env refs, make sure each `VAR` is
present in `infra/prod/runtime/.env`. If a secret is missing, ask the user for it and
append it to `runtime/.env` (keep the file at chmod 600). Do not invent secret values.

## Step 3 — GitHub App access check

For each repo, confirm it exists and is reachable, so the orchestrator's per-task
installation token will be able to mint against it:

`gh api repos/<Org>/<repo> --jq .full_name`

If a repo 404s or errors, warn the user: the GitHub App must be **installed on that
repository** (org-wide install or added to the repo) before the project will work.
This is a check + warning, not a blocker — let the user decide to proceed.

## Step 4 — show the diff and confirm deploy

Show the diff of `infra/prod/runtime/projects.config.json` (`git diff --no-index` won't
work since it's gitignored — use `git diff -- infra/prod/runtime/projects.config.json`
only if tracked; otherwise just display the added block). Then explicitly ask:

> Выкатываем на прод сейчас? (export + reload)

Do not proceed to Step 5 without an explicit yes.

## Step 5 — deploy

On confirmation:

```bash
npm run prod:export     # upload infra/prod/runtime/ (incl. projects.d/) → the box
```

Then ask the user to run `/aven reload` in Slack (any channel) — it re-reads the
registry without a restart. `npm run prod:restart` also works (e.g. if Slack is
unavailable) but interrupts in-flight turns.

## Step 6 — verify

`/aven reload`'s reply already confirms the new project count (`added: <slug>`). If a
restart was used instead, confirm the service is up and the new project loaded:

```bash
npm run prod:status     # expect: active (running)
```

Then check the startup line in the journal (the bot logs
`Slack bot running (Socket Mode) — N project(s), M channel-bound`):

```bash
source infra/prod/.env
ssh -o StrictHostKeyChecking=accept-new "${DEPLOY_USER}@${DEPLOY_HOST}" \
  "journalctl -u ${SERVICE_NAME}.service --since '-90s' --no-pager | grep -E 'Slack bot running|project\\(s\\)' | tail -3"
```

Confirm `N project(s)` reflects the new count. If the service failed to start, show the
last ~15 journal lines and stop (likely a malformed config or missing env var).

## Step 7 — Slack channel (manual, tell the user)

Channels auto-bind to a project **by name** — there's nothing to wire in code. Tell the
user to finish in Slack:

1. Create a channel named **`bluefin-aven-<slug>`** (exact prefix `bluefin-aven-`).
2. **Invite the prod CoachAven bot** to that channel.
3. Post a message there to test — the bot binds the channel to the project on first use.

(An explicit `slackChannel` id in the config can override name-binding, but the default
name convention is preferred — no ids to manage.)

## Done

Summarize: which project was added, the new project count, deploy result, and the
remaining manual Slack step. Remind that the change is live on prod and the repo-root
local-dev config was untouched.
