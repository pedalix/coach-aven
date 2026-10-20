import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SandboxDriverKind } from './config.js';
import { daytonaDefaultRefusal, driverRefusal, type DaytonaDefault } from './driverkind.js';
import { resolveSandboxOptions, type SandboxOptions } from './sandboxopts.js';
import { validateSourcesConfig } from './sources/config.js';
import { ConfigError } from './sources/errors.js';
import type { SourcesConfig } from './sources/types.js';
import { validateMessagingConfig, type MessagingConfig } from './messaging/config.js';
import { validateGatewayOAuth, type GatewayOAuth } from './gwtoken.js';
import { log } from './log.js';

// Registry of the projects the bot serves. ONE bot, MANY channels: each Slack channel
// is bound to a project, and each project gets its OWN isolated sandbox (proj-<slug>).
// Channel = context = the VM the bot works against. Channels auto-bind by name via the
// wildcard `aven-{project}` (e.g. aven-caldora, aven-cms-general,
// aven-dorfberg-monitoring) — the <project> part is the slug, so no channel ids to
// wire (an explicit `slackChannel` id still overrides). A project owns its repos, MCP
// servers, and env/secrets. ALL repos are cloned side by side (e.g. cms-general's
// several codebases); `mcp` and `env` are modeled now, wired later.
// A per-project MCP server (Claude Code mcpServers entry shape). Two forms: a local
// stdio command (`command`/`args`/`env`) or a remote HTTP endpoint (`url`/`headers` —
// e.g. the shared mcp-grafana at observe.example.com/mcp, so sandboxes need no
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
  // `gateway-m2m`: a remote server behind the MCP gateway (engine.example.com/gw/<slug>/mcp)
  // that the bot reaches as its project's machine client. The orchestrator mints and caches the
  // token (gwtoken.ts) and writes it into the sandbox; Claude Code picks it up via the server's
  // `headersHelper` (mcp.ts). Without `oauth`: the Auth0 client coach-aven-<slug>, needs
  // AUTH0_M2M_<SLUG>_ID/_SECRET + AUTH0_M2M_TOKEN_URL.
  auth?: 'gateway-m2m';
  // Only on a `gateway-m2m` entry: mint with a standard OAuth 2.0 client-credentials request
  // instead (any RFC 6749 server — Amazon Cognito first). No secret here: the client id and
  // secret come from GATEWAY_OAUTH_<SLUG>_ID/_SECRET. Stays on the bot side — buildMcpServers
  // never copies it into the sandbox's MCP config. See docs/runtime-config.md → *MCP gateway*.
  oauth?: GatewayOAuth;
}

export const GIT_FLOWS = ['pr', 'direct'] as const;
export type GitFlow = (typeof GIT_FLOWS)[number];

export interface ProjectConfig {
  slug: string; // short id + sandbox suffix (proj-<slug>); channel = aven-<slug>
  repos: string[]; // ["Org/name", ...]; repos[0] is primary (v1 clones/uses it)
  slackChannel?: string; // optional explicit channel-id override (else bound by name)
  // A Teams installation binds by id only (channels have no name wildcard there): the channel's
  // `19:…@thread.tacv2` id, exactly as Teams delivers it (OpenSpec teams-chat-driver).
  teamsChannel?: string;
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
  // Which sandbox driver hosts this project's sandbox (see driver.ts). Optional: omitted → the
  // installation's SANDBOX_DRIVER, and either can only say "ssh-docker", the one driver since the
  // Daytona driver's removal. loadProjects refuses any other value, and a project without the field
  // under an old Daytona default (OpenSpec retire-daytona-driver D3/D4): both would move it to a new,
  // empty sandbox. The templates still write "ssh-docker": earlier releases default to daytona.
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
  // External systems the BOT reads on this project's behalf (mail, chat, calendar, files) into
  // a scrubbed archive under data/<slug>/ that the sandbox will later get read-only. Tokens live
  // in ~/.config/coach-aven/sources/<slug>/ and are bootstrapped with `orch sources auth`. See
  // docs/sources.md. Validated at boot (sources/config.ts).
  sources?: SourcesConfig;
  // Agent messaging (OpenSpec agent-messaging, design D2): whether this project's agent may send tasks
  // to other agents, and which agents may ask it. Absent = exactly today's behaviour. Read at call
  // time, so `/aven reload` changes what the next call may do. Refused on a project several tenants
  // share — its domain would be ambiguous (src/messaging/config.ts).
  messaging?: MessagingConfig;
}

// A workspaces entry: the short form is just the slug list; the object form adds
// per-workspace settings — today `channelPrefix`, the channel-name wildcard for THAT
// workspace ("" = channel name IS the slug, e.g. #coach-aven). Our home keeps the
// legacy `aven-` default; a client workspace shouldn't be forced to carry it.
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

// `daytonaDefault`: the setting that made Daytona the installation's default before the driver was
// removed (Config.daytonaDefault), so the boot, `/aven reload` and the `orch sources` commands refuse the
// same configurations in the same words. Required, though usually undefined: a caller that forgot it would
// load every project an old default would move, and only the typecheck can see that omission.
export function loadProjects(path: string, daytonaDefault: DaytonaDefault | undefined): ProjectsRegistry {
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
    // Any driver but ssh-docker is refused, never run elsewhere in its place (D3): `daytona` names the
    // removed driver, and anything else is a typo — which used to select Daytona silently. A JSON `null`
    // is an absent field, as it always was (the old selection read `driver ?? SANDBOX_DRIVER`): dropped
    // here, so it loads where an absent field loads and is refused where one is (D4, below).
    const driver: unknown = p.driver;
    if (driver === null) delete (p as { driver?: unknown }).driver;
    else if (driver !== undefined && driver !== 'ssh-docker') {
      throw new ConfigError(`${path}: ${driverRefusal(`project "${p.slug}" driver`, driver)}`);
    }
    // Validate at boot: a bad mount or a privileged:false/dind:true contradiction must fail
    // here, not at the first turn of that project.
    try {
      resolveSandboxOptions(p.sandbox);
    } catch (e) {
      throw new Error(`${path}: project "${p.slug}" ${e instanceof Error ? e.message : String(e)}`);
    }
    if (p.sources !== undefined) {
      // The store never rides into the sandbox: the bot serves the `sources` tools over the
      // session's control channel from the replica on its own disk (hostrouter.ts), or the project
      // declares a `sources` MCP entry with a `url` and reaches a daemon that way (docs/sources.md →
      // "Remote access"). Either way the sandbox options stay exactly what the config says.
      try {
        p.sources = validateSourcesConfig(p.sources, `project "${p.slug}" sources`);
      } catch (e) {
        throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (p.messaging !== undefined) {
      try {
        p.messaging = validateMessagingConfig(p.messaging, `project "${p.slug}" messaging`);
      } catch (e) {
        throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // The dispatch primitive is retired (OpenSpec `retire-agent-dispatch` D4): a leftover block changes nothing,
    // so it warns once per load, naming the project, and is dropped — never a refusal to start.
    if ((p as { dispatch?: unknown }).dispatch !== undefined) {
      log.warn(`${path}: project "${p.slug}" dispatch is retired — agent messaging replaces it; the block is ignored`);
      delete (p as { dispatch?: unknown }).dispatch;
    }
    for (const s of p.mcp ?? []) {
      if (!s.name || (!s.command && !s.url)) {
        throw new Error(`${path}: mcp server entries need a "name" and a "command" or "url"`);
      }
      if (s.auth === 'gateway-m2m' && (!s.url || !/^[A-Za-z0-9_-]+$/.test(s.name))) {
        // The name becomes a sandbox file name (gw-token-<name>) — keep it path-safe.
        throw new Error(`${path}: a gateway-m2m mcp entry needs a "url" and a [A-Za-z0-9_-] "name"`);
      }
      if (s.oauth !== undefined) {
        // A malformed request (or a secret pasted into the config) fails the load, not the first
        // turn of that project; the credentials themselves are checked at first mint, as today.
        if (s.auth !== 'gateway-m2m') {
          throw new Error(`${path}: project "${p.slug}" mcp "${s.name}": "oauth" only goes on an entry with "auth": "gateway-m2m"`);
        }
        try {
          s.oauth = validateGatewayOAuth(s.oauth, `project "${p.slug}" mcp "${s.name}" oauth`);
        } catch (e) {
          throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }
  // Under an old Daytona default, a project without a `driver` field was meant to run on Daytona, and
  // the new default would move it (D4): refused, every such project named at once. When each project
  // names its driver, the old default moves nothing — it loads, and the setting only warns at boot.
  if (daytonaDefault) {
    const unset = reg.projects.filter((p) => p.driver === undefined).map((p) => p.slug);
    if (unset.length) throw new ConfigError(`${path}: ${daytonaDefaultRefusal(unset, daytonaDefault)}`);
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
    // A project several tenants share has no single domain (design D14), so it cannot take part in
    // messaging: its block is dropped, loudly, and the project behaves as before.
    for (const p of reg.projects) {
      if (p.messaging === undefined) continue;
      const tenants = sharingTenants(reg, p.slug);
      if (tenants.length > 1) {
        log.error(`${path}: project "${p.slug}" is shared by ${tenants.length} tenants — its messaging configuration is refused (a shared project's domain would be ambiguous)`);
        delete p.messaging;
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

// The registry a bot boots with (`orch slack`, `orch teams`): loadProjects under the installation's old
// Daytona default, then the boot's warnings for retired settings — only once the configuration has
// loaded (OpenSpec retire-daytona-driver D5). A boot that a Daytona leftover refuses prints the refusal
// alone: a warning that its cause "changes nothing — remove it" would point at the wrong fix, since
// deleting that setting lifts the refusal and the projects then move without a word.
export function loadBootRegistry(
  cfg: { projectsConfigPath: string; daytonaDefault?: DaytonaDefault },
  bootWarnings: readonly string[],
  warn: (line: string) => void = log.warn,
): ProjectsRegistry {
  const reg = loadProjects(cfg.projectsConfigPath, cfg.daytonaDefault);
  for (const w of bootWarnings) warn(w);
  return reg;
}

export function resolveByChannel(
  reg: ProjectsRegistry,
  channelId: string,
): ProjectConfig | undefined {
  return reg.projects.find((p) => p.slackChannel === channelId || p.teamsChannel === channelId);
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

/** The tenants whose workspaces entry lists the slug (more than one = a shared project). */
export function sharingTenants(reg: ProjectsRegistry, slug: string): string[] {
  return Object.entries(reg.workspaces ?? {})
    .filter(([, e]) => entrySlugs(e)?.includes(slug))
    .map(([t]) => t);
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
