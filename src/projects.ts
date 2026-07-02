import { existsSync, readFileSync } from 'node:fs';

// Registry of the projects the bot serves. ONE bot, MANY channels: each Slack channel
// is bound to a project, and each project gets its OWN isolated sandbox (proj-<slug>).
// Channel = context = the VM the bot works against. Channels auto-bind by name via the
// wildcard `bluefin-aven-{project}` (e.g. bluefin-aven-caldora, bluefin-aven-cms-general,
// bluefin-aven-dorfberg-monitoring) — the <project> part is the slug, so no channel ids to
// wire (an explicit `slackChannel` id still overrides). A project owns its repos, MCP
// servers, and env/secrets. ALL repos are cloned side by side (e.g. cms-general's
// several codebases); `mcp` and `env` are modeled now, wired later.
// A per-project MCP server (Claude Code mcpServers entry shape). Two forms: a local
// stdio command (`command`/`args`/`env`) or a remote HTTP endpoint (`url`/`headers` —
// e.g. the shared mcp-grafana at <grafana-host>/mcp, so sandboxes need no
// docker-in-docker). `env` and `headers` values may use ${ENV_NAME} refs, resolved from
// the ORCHESTRATOR's process.env at materialization — so secrets (a Grafana token, an
// endpoint's auth header) live in the orchestrator's .env, not this config.
export interface McpServerSpec {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface ProjectConfig {
  slug: string; // short id + sandbox suffix (proj-<slug>); channel = bluefin-aven-<slug>
  repos: string[]; // ["Org/name", ...]; repos[0] is primary (v1 clones/uses it)
  slackChannel?: string; // optional explicit channel-id override (else bound by name)
  // Project-specific system-prompt layer, APPENDED after the orchestrator's base prompt
  // (never overrides it). Project context the orchestrator can't know: domain, what each
  // repo is + how they relate, merge/deploy-order rules, docs links. Repo CODING
  // conventions belong in each repo's own CLAUDE.md, not here.
  systemPrompt?: string;
  env?: Record<string, string>; // per-project env/secrets seeded into the sandbox (reserved)
  mcp?: McpServerSpec[]; // per-project MCP servers → materialized into --mcp-config in the sandbox
  // YouTrack project prefixes that route to this project (the investigation pilot). A tagged
  // ticket whose id is "<PREFIX>-<n>" is investigated in this project's sandbox/channel. One
  // project may carry several (e.g. caldora ← its several help-desk projects). See youtrack.ts.
  youtrackProjects?: string[];
}

export interface ProjectsRegistry {
  projects: ProjectConfig[];
}

export function loadProjects(path: string): ProjectsRegistry {
  if (!existsSync(path)) {
    throw new Error(
      `Project registry not found at ${path}. Copy projects.config.example.json → ` +
        `projects.config.json (or set PROJECTS_CONFIG_PATH).`,
    );
  }
  const reg = JSON.parse(readFileSync(path, 'utf8')) as ProjectsRegistry;
  if (!Array.isArray(reg.projects) || reg.projects.length === 0) {
    throw new Error(`${path}: expected { "projects": [ … ] } with at least one project`);
  }
  for (const p of reg.projects) {
    if (!p.slug || !Array.isArray(p.repos) || p.repos.length === 0) {
      throw new Error(`${path}: each project needs a "slug" and at least one repo in "repos"`);
    }
    for (const s of p.mcp ?? []) {
      if (!s.name || (!s.command && !s.url)) {
        throw new Error(`${path}: mcp server entries need a "name" and a "command" or "url"`);
      }
    }
  }
  return reg;
}

export function resolveByChannel(
  reg: ProjectsRegistry,
  channelId: string,
): ProjectConfig | undefined {
  return reg.projects.find((p) => p.slackChannel === channelId);
}

export function resolveBySlug(reg: ProjectsRegistry, slug: string): ProjectConfig | undefined {
  return reg.projects.find((p) => p.slug === slug);
}
