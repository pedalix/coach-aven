import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SandboxDriverKind } from './config.js';

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
  // Which sandbox provider hosts this project's sandbox (see driver.ts). Omitted → the
  // deployment default (SANDBOX_DRIVER, currently daytona). Lets the fleet migrate
  // provider by provider — e.g. move a docker-less project to ssh-docker first.
  driver?: SandboxDriverKind;
  // Pin THIS project's sandbox Claude Code CLI (x.y.z), overriding CLAUDE_CLI_VERSION — the
  // canary knob: roll a new version on one low-traffic project first (cliversion.ts).
  cliVersion?: string;
  // YouTrack project prefixes that route to this project (the investigation pilot). A tagged
  // ticket whose id is "<PREFIX>-<n>" is investigated in this project's sandbox/channel. One
  // project may carry several (e.g. caldora ← its several help-desk projects). See youtrack.ts.
  youtrackProjects?: string[];
  // Composer credentials for private packages, VERBATIM in composer's auth.json shape
  // (e.g. { "github-oauth": { "github.com": "ghp_…" } }, or "http-basic" for a Satis).
  // Seeded as <checkout>/auth.json into every repo checkout (git-excluded there): both
  // the Sail container and the composer bootstrap container mount the checkout, and
  // composer reads ./auth.json from its working dir — so one file covers every composer
  // path with no env plumbing into containers. The value lives HERE (this file is
  // gitignored prod runtime) rather than as an ${ENV} ref: it's a per-project static
  // secret (e.g. a fine-grained PAT for a package repo our GitHub App can't reach).
  composerAuth?: Record<string, unknown>;
}

// A workspaces entry: the short form is just the slug list; the object form adds
// per-workspace settings — today `channelPrefix`, the channel-name wildcard for THAT
// workspace ("" = channel name IS the slug, e.g. #coach-aven). Our home keeps the
// legacy `bluefin-aven-` default; a client workspace shouldn't be forced to carry it.
export type WorkspaceEntry = string[] | { projects: string[]; channelPrefix?: string };

export interface ProjectsRegistry {
  projects: ProjectConfig[];
  // Tenant → the projects that workspace may see and drive (multi-tenancy slice 2).
  // Keys are Slack tenant ids per the installation-store rule (enterpriseId ?? teamId →
  // "T…"/"E…"). ABSENT block = single-tenant back-compat: the home workspace owns every
  // project. PRESENT block = explicit-only — a tenant not listed (including home!) has
  // no projects and is politely refused by the gate. A slug MAY appear under several
  // tenants (sharing is a data-model capability, deliberately not a built feature);
  // pollers act for the slug's OWNER tenant only — see projectOwnerTeam.
  workspaces?: Record<string, WorkspaceEntry>;
}

// The slug list of a workspaces entry, whatever its shape.
export function entrySlugs(e: WorkspaceEntry | undefined): string[] | undefined {
  if (!e) return undefined;
  return Array.isArray(e) ? e : e.projects;
}

// The channel-name wildcard for a tenant, when its entry overrides the deployment
// default (undefined = use SLACK_CHANNEL_PREFIX; "" is a VALID override: bare slugs).
export function workspacePrefix(reg: ProjectsRegistry, tenantId: string | undefined): string | undefined {
  const e = tenantId ? reg.workspaces?.[tenantId] : undefined;
  return e && !Array.isArray(e) ? e.channelPrefix : undefined;
}

// Mutable handle to the loaded registry. Long-lived modules (turn engine, pollers,
// command router) hold the REF and read `.current` per use, so a runtime config reload
// can swap the registry in place without re-wiring anything.
export interface RegistryRef {
  current: ProjectsRegistry;
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
    if (
      p.composerAuth !== undefined &&
      (typeof p.composerAuth !== 'object' || p.composerAuth === null || Array.isArray(p.composerAuth))
    ) {
      throw new Error(`${path}: "${p.slug}".composerAuth must be an object in composer auth.json format`);
    }
  }
  // The workspaces block (when present) must reference real slugs — a typo would
  // silently hide a project from its tenant, so fail the boot instead.
  if (reg.workspaces) {
    const known = new Set(reg.projects.map((p) => p.slug));
    for (const [tenant, entry] of Object.entries(reg.workspaces)) {
      const slugs = entrySlugs(entry);
      if (!Array.isArray(slugs)) {
        throw new Error(`${path}: workspaces["${tenant}"] must be an array of slugs or { "projects": [...] }`);
      }
      for (const s of slugs) {
        if (!known.has(s)) throw new Error(`${path}: workspaces["${tenant}"] references unknown project "${s}"`);
      }
    }
  }
  // System prompts live as markdown files BESIDE the config — projects.d/<slug>.md —
  // instead of multi-KB one-line JSON strings (diffable, editable, no JSON escaping).
  // A file, when present and non-empty, WINS over the JSON `systemPrompt` field (kept as
  // a fallback so older configs keep working). Stray files for unknown slugs are ignored.
  const promptDir = join(dirname(path), 'projects.d');
  for (const p of reg.projects) {
    const f = join(promptDir, `${p.slug}.md`);
    if (existsSync(f)) {
      const body = readFileSync(f, 'utf8').trim();
      if (body) p.systemPrompt = body;
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

// The projects a tenant may see and drive. No workspaces block → single-tenant
// back-compat: the home tenant (and the unknown tenant of static-token mode, where
// homeTenant is undefined) gets everything, everyone else nothing. With the block,
// membership is explicit-only — order follows reg.projects (stable for UI lists).
export function teamProjects(
  reg: ProjectsRegistry,
  tenantId: string | undefined,
  homeTenant: string | undefined,
): ProjectConfig[] {
  if (!reg.workspaces) {
    const isHome = !tenantId || !homeTenant || tenantId === homeTenant;
    return isHome ? reg.projects : [];
  }
  const slugs = new Set(entrySlugs(reg.workspaces[tenantId ?? homeTenant ?? '']) ?? []);
  return reg.projects.filter((p) => slugs.has(p.slug));
}

// The single tenant a poller acts for on this project — the FIRST tenant whose
// workspaces entry lists the slug (config order = precedence, so put home first for
// shared projects). No block / not listed → home. Keeps auto-review/YouTrack from
// double-firing when a slug is shared across tenants.
export function projectOwnerTeam(
  reg: ProjectsRegistry,
  slug: string,
  homeTenant: string | undefined,
): string | undefined {
  if (!reg.workspaces) return homeTenant;
  for (const [tenant, entry] of Object.entries(reg.workspaces)) {
    if (entrySlugs(entry)?.includes(slug)) return tenant;
  }
  return homeTenant;
}
