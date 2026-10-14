import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SandboxDriverKind } from './config.js';
import { resolveSandboxOptions, withSourcesMount, type SandboxOptions } from './sandboxopts.js';
import { dispatch, outboxDir, withOutboxMount, type DispatchConfig } from './dispatch.js';
import { ensureDir } from './sources/paths.js';
import { validateSourcesConfig } from './sources/config.js';
import { replicaDir } from './sources/paths.js';
import type { SourcesConfig } from './sources/types.js';

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
  // `gateway-m2m`: a remote server behind the MCP gateway (<gateway-host>/gw/<slug>/mcp)
  // that the bot reaches as its Auth0 M2M client coach-aven-<slug>. The orchestrator mints and
  // caches the token (gwtoken.ts) and writes it into the sandbox; Claude Code picks it up via
  // the server's `headersHelper` (mcp.ts). Needs AUTH0_M2M_<SLUG>_ID/_SECRET + AUTH0_M2M_TOKEN_URL.
  auth?: 'gateway-m2m';
}

export const GIT_FLOWS = ['pr', 'direct'] as const;
export type GitFlow = (typeof GIT_FLOWS)[number];

export interface ProjectConfig {
  slug: string; // short id + sandbox suffix (proj-<slug>); channel = bluefin-aven-<slug>
  repos: string[]; // ["Org/name", ...]; repos[0] is primary (v1 clones/uses it)
  slackChannel?: string; // optional explicit channel-id override (else bound by name)
  // Project-specific system-prompt layer, APPENDED after the orchestrator's base prompt
  // (never overrides it). Project context the orchestrator can't know: domain, what each
  // repo is + how they relate, merge/deploy-order rules, docs links. Repo CODING
  // conventions belong in each repo's own CLAUDE.md, not here.
  systemPrompt?: string;
  // How the agent gets changes OUT of the sandbox — told in the base system prompt (prompt.ts).
  // `pr` (default): a dedicated worktree off the remote default branch and a pull request —
  // code under review. `direct`: `git pull --rebase --autostash`, commit on the checkout's
  // current branch, push — a repo with no review flow (an ops ledger the agent itself keeps).
  // Explicit on purpose: never inferred from repo names or `sources`. Applies to new sessions.
  gitFlow?: GitFlow;
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
  // How this project's container is run (ssh-docker): privileged/dind (the fleet default, for
  // Sail) or a plain unprivileged container, plus read-only host mounts. See sandboxopts.ts.
  // Applies to NEW containers only — an existing proj-<slug> keeps its flags until recreated
  // (`docker rm` it on the sandbox host; the next turn creates it with the new options).
  sandbox?: SandboxOptions;
  // Redact passwords, tokens and connection strings from everything users type before it
  // reaches the Claude process (scrub.ts). Default TRUE for every project — the API boundary
  // is the one place a pasted secret can't be recalled from. `false` opts a project out.
  scrubSecrets?: boolean;
  // Dispatch primitive tuning (dispatch.ts, DISPATCH=1): targets that execute without the Send
  // click and the per-day cap. Absent = every proposal is gated, cap 5.
  dispatch?: DispatchConfig;
  // External systems the BOT reads on this project's behalf (mail, chat, calendar, files) into
  // a scrubbed archive under data/<slug>/ that the sandbox will later get read-only. Tokens live
  // in ~/.config/coach-aven/sources/<slug>/ and are bootstrapped with `orch sources auth`. See
  // docs/sources.md. Validated at boot (sources/config.ts).
  sources?: SourcesConfig;
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
    // A typo here would silently fall back to the PR flow — fail the boot (and `/aven reload`).
    if (p.gitFlow !== undefined && !(GIT_FLOWS as readonly string[]).includes(p.gitFlow)) {
      throw new Error(
        `${path}: project "${p.slug}" gitFlow must be one of ${GIT_FLOWS.map((f) => `"${f}"`).join(', ')}, got ${JSON.stringify(p.gitFlow)}`,
      );
    }
    // Validate at boot: a bad mount or a privileged:false/dind:true contradiction must fail
    // here, not at the first turn of that project.
    try {
      resolveSandboxOptions(p.sandbox);
    } catch (e) {
      throw new Error(`${path}: project "${p.slug}" ${e instanceof Error ? e.message : String(e)}`);
    }
    if (p.sources !== undefined) {
      try {
        p.sources = validateSourcesConfig(p.sources, `project "${p.slug}" sources`);
        // The store replica rides into the sandbox automatically (docs/sources.md → "Replica").
        // Merged here, once, so every ensureSandbox caller — turns, /aven memory, pollers —
        // sees the same options without each knowing about sources. Re-validated so a
        // hand-written mount on the same target fails the boot as a duplicate.
        p.sandbox = withSourcesMount(p.sandbox, replicaDir(p.slug));
        resolveSandboxOptions(p.sandbox);
      } catch (e) {
        throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (p.dispatch !== undefined) {
      const dc = p.dispatch;
      if (!dc || typeof dc !== 'object' || Array.isArray(dc)) throw new Error(`${path}: project "${p.slug}" dispatch must be an object`);
      if (dc.auto !== undefined && (!Array.isArray(dc.auto) || dc.auto.some((x) => typeof x !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(x)))) {
        throw new Error(`${path}: project "${p.slug}" dispatch.auto must be an array of project slugs or channel ids`);
      }
      if (dc.maxPerDay !== undefined && (!Number.isInteger(dc.maxPerDay) || dc.maxPerDay < 0 || dc.maxPerDay > 100)) {
        throw new Error(`${path}: project "${p.slug}" dispatch.maxPerDay must be an integer in [0, 100]`);
      }
    }
    // While dispatch is on, every project gets a read-write outbox beside the read-only replica
    // (the `host` MCP tool writes proposals there). Created here, owner-only, BEFORE a container
    // can mount it — docker would otherwise create it root-owned and the bot could not claim files.
    if (dispatch.enabled) {
      try {
        p.sandbox = withOutboxMount(p.sandbox, ensureDir(outboxDir(p.slug)));
        resolveSandboxOptions(p.sandbox);
      } catch (e) {
        throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    for (const s of p.mcp ?? []) {
      if (!s.name || (!s.command && !s.url)) {
        throw new Error(`${path}: mcp server entries need a "name" and a "command" or "url"`);
      }
      if (s.auth === 'gateway-m2m' && (!s.url || !/^[A-Za-z0-9_-]+$/.test(s.name))) {
        // The name becomes a sandbox file name (gw-token-<name>) — keep it path-safe.
        throw new Error(`${path}: a gateway-m2m mcp entry needs a "url" and a [A-Za-z0-9_-] "name"`);
      }
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
