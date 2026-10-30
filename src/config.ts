import { parseSurfaces } from './chat/surfaces.js';
import type { ChatDriverName } from './chat/drivers.js';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { config as loadDotenv } from 'dotenv';
import { isValidCliVersion } from './cliversion.js';
import { messagingEnv, type MessagingEnv } from './messaging/config.js';
import type { Credit } from './credit.js';

// The checkout's .env configures a RUNNING bot. Under the test runner (node --test sets
// NODE_TEST_CONTEXT in every test process) it must not leak into tests: a developer's
// SLACK_CHANNEL_PREFIX or flags would make the recorded-call snapshots machine-dependent.
if (!process.env.NODE_TEST_CONTEXT) loadDotenv();

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name} (see .env.example)`);
  return v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be a number, got: ${v}`);
  return n;
}

// The Sentry release (version) to tag issues with. Explicit env wins; otherwise read the
// `.release` file the deploy writes (package root, next to state.json) so CI can stamp the
// git tag per deploy without touching the runtime .env. Undefined → no release tag.
function resolveRelease(): string | undefined {
  if (process.env.SENTRY_RELEASE) return process.env.SENTRY_RELEASE;
  try {
    return readFileSync(new URL('../.release', import.meta.url).pathname, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

// CLAUDE_CLI_VERSION must be a plain x.y.z — it is interpolated into a sandbox shell
// command (cliversion.ts) — so anything else is refused loudly at boot, not ignored.
function cliVersionEnv(): string | undefined {
  const v = process.env.CLAUDE_CLI_VERSION;
  if (!v) return undefined;
  if (!isValidCliVersion(v)) throw new Error(`CLAUDE_CLI_VERSION must be x.y.z (got '${v}')`);
  return v;
}

// The model credit (OpenSpec api-key-credit D1): exactly one of ANTHROPIC_API_KEY (an API key — the path for
// an installation that serves a team or clients) and CLAUDE_CODE_OAUTH_TOKEN (a `claude setup-token` value —
// the quick way to try it). Both set stops the boot: the CLI would silently prefer the key, and the operator
// would not know which credit pays. A value whose prefix belongs to the OTHER variable stops it too (the
// commonest paste mistake); an unknown prefix passes, so a future key format is not refused. Neither set →
// on a dev box with Claude installed, the live, auto-refreshing access token in `home`/.claude (avoids the
// "baked a token that later expired" trap for warm sandboxes), as a subscription. Pure over env + home;
// every message names variables, never a value. "Set" means non-empty after trimming.
export function resolveCredit(env: Record<string, string | undefined>, home: string | undefined): Credit {
  const key = env.ANTHROPIC_API_KEY?.trim();
  const token = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (key && token) {
    throw new Error('Both ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN are set: keep exactly one (an API key or a subscription token)');
  }
  if (key) {
    if (key.startsWith('sk-ant-oat')) throw new Error('ANTHROPIC_API_KEY holds a subscription token (sk-ant-oat…): it belongs in CLAUDE_CODE_OAUTH_TOKEN');
    return { kind: 'api-key', value: key, source: 'ANTHROPIC_API_KEY' };
  }
  if (token) {
    if (token.startsWith('sk-ant-api')) throw new Error('CLAUDE_CODE_OAUTH_TOKEN holds an API key (sk-ant-api…): it belongs in ANTHROPIC_API_KEY');
    return { kind: 'subscription', value: token, source: 'CLAUDE_CODE_OAUTH_TOKEN' };
  }
  try {
    const cred = JSON.parse(readFileSync(`${home}/.claude/.credentials.json`, 'utf8'));
    const tok = cred?.claudeAiOauth?.accessToken;
    if (typeof tok === 'string' && tok.trim()) return { kind: 'subscription', value: tok.trim(), source: '~/.claude' };
  } catch {
    /* fall through to error */
  }
  throw new Error(
    'No model credit: set ANTHROPIC_API_KEY (an API key from the Anthropic console) or CLAUDE_CODE_OAUTH_TOKEN (claude setup-token), exactly one',
  );
}

function githubPrivateKey(): string {
  const path = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (path) return readFileSync(path, 'utf8');
  const inline = process.env.GITHUB_APP_PRIVATE_KEY;
  if (inline) return inline.replace(/\\n/g, '\n');
  throw new Error('Provide GITHUB_APP_PRIVATE_KEY_PATH or GITHUB_APP_PRIVATE_KEY');
}

// GitHub auth in-box can come from EITHER:
//   - GITHUB_TOKEN  — a plain token (PAT or `gh auth token`). Simplest; used as-is.
//   - a GitHub App  — short-lived installation tokens minted per task (production).
// The plain token wins if set.
export type GitHubAuth =
  | { kind: 'token'; token: string }
  // installationId is optional — if absent it's discovered from the repo owner.
  | { kind: 'app'; appId: string; installationId?: string; privateKey: string };

function githubAuth(): GitHubAuth {
  const token = process.env.GITHUB_TOKEN;
  if (token) return { kind: 'token', token };
  return {
    kind: 'app',
    appId: req('GITHUB_APP_ID'),
    installationId: process.env.GITHUB_APP_INSTALLATION_ID,
    privateKey: githubPrivateKey(),
  };
}

// Multi-workspace OAuth install flow (Public Distribution). Active only when the client
// credentials are set — a plain SLACK_BOT_TOKEN dev run stays single-workspace with zero
// OAuth moving parts. `homeTeamId` names OUR workspace (pollers/alerts/recovery run there;
// see slack.ts); when unset it's resolved via auth.test on SLACK_BOT_TOKEN at boot.
export interface SlackOauthConfig {
  clientId: string;
  clientSecret: string;
  stateSecret: string;
  scopes: string[]; // bot scopes requested at install (user scopes deliberately not requested)
  port: number; // the OAuth HTTP listener (install + redirect routes) — see SocketModeReceiver
  homeTeamId?: string;
}

// The bot scopes from slack-app-manifest.json — the default install request. Keep in sync
// when the manifest grows a scope (a mismatch = clients install without the new scope and
// hit missing_scope until they reinstall).
const DEFAULT_BOT_SCOPES = [
  'app_mentions:read',
  'bookmarks:read',
  'bookmarks:write',
  'channels:history',
  'channels:join',
  'channels:manage',
  'channels:read',
  'chat:write',
  'chat:write.customize',
  'commands',
  'conversations.connect:manage',
  'conversations.connect:read',
  'conversations.connect:write',
  'emoji:read',
  'files:read',
  'files:write',
  'groups:history',
  'groups:read',
  'groups:write',
  'im:history',
  'im:read',
  'im:write',
  'links:read',
  'links:write',
  'metadata.message:read',
  'mpim:history',
  'mpim:write',
  'pins:read',
  'pins:write',
  'reactions:write',
  'reactions:read',
  'team:read',
  'usergroups:read',
  'users:read.email',
  'users:read',
];

// Which sandbox driver backs a project (see driver.ts): ssh-docker, the only one since the Daytona
// driver was removed (OpenSpec retire-daytona-driver). Installation-wide via SANDBOX_DRIVER, per
// project via projects.config.json's `driver` field — both optional, any other value refused
// (sandboxDriverEnv, loadProjects), and both still written out in the templates: v0.42.0 and every
// earlier release default to daytona, so the line keeps a rollback safe.
export type SandboxDriverKind = 'ssh-docker';

export interface Config {
  // ssh-docker: `host` is an ssh target (user@host or an ~/.ssh/config alias; key auth,
  // BatchMode), or the literal `local` to drive this machine's own Docker daemon via
  // `sh -c` with no sshd at all (single-box self-hosted instance — see
  // docs/sandbox-drivers.md "Local mode"). `runtime` picks how containers get DinD for
  // Laravel Sail; irrelevant for projects that run with `sandbox.privileged: false`.
  sshDocker?: { host: string; runtime: 'sysbox-runc' | 'privileged' };
  sandboxDriver: SandboxDriverKind;
  // SNAPSHOT_IMAGE: the image every project container is created from. The Daytona-era name stays
  // on purpose (retire-daytona-driver D2): every installation sets it, and a rename would change no
  // behaviour.
  snapshot: { image: string };
  // namePrefix keeps two installations (dev and prod) apart on ONE Docker host: dev →
  // `dev-proj-<slug>`, prod → `proj-<slug>`, so the two never share a container (set
  // SANDBOX_NAME_PREFIX). The idle stop and a wake's clean-up assume one bot per container;
  // SANDBOX_MANAGED_BY alone does not keep two installations apart (sandbox-idle-stop D10).
  sandbox: { autoStopMinutes: number; workDir: string; namePrefix: string };
  // The model credit the sandboxes' Claude Code runs on (credit.ts, resolveCredit above). The value goes into
  // the sandbox's credit file only; logs, commands and errors name its kind and source.
  credit: Credit;
  // Model for the sandbox claude processes (`--model`). Unset → the Claude Code default,
  // which historically resolved to Sonnet — set CLAUDE_MODEL explicitly (e.g.
  // claude-opus-5-5) so the fleet's model is a deliberate choice, not a CLI default.
  claudeModel?: string;
  // REPO_SKILLS=1: a multi-repo project's sessions load each repo's own Claude Code skills (`--add-dir
  // <checkout>` per repo, OpenSpec agent-skills), as a local Claude Code started in that repo would. Off by
  // default (bucket 3): unset or anything else keeps every spawn line as it was. Single-repo projects are
  // unaffected either way: their session starts in the repo.
  repoSkills: boolean;
  // Pin for the sandbox Claude Code CLI (x.y.z). Warm sandboxes converge to it in place at
  // chat prep / nightly housekeeping; the image build bakes the same pin. Unset → sandboxes
  // keep whatever their image shipped (and the daily drift check nags). See cliversion.ts.
  claudeCliVersion?: string;
  github: GitHubAuth;
  // Slack is only needed for the `slack` command; undefined otherwise. appToken is always
  // required (Socket Mode); botToken is optional once `oauth` is set — the home workspace's
  // token then comes from the installation store (botToken, when present, seeds it).
  slack?: { botToken?: string; appToken: string; oauth?: SlackOauthConfig };
  // Teams is only needed for the `teams` command; undefined otherwise (OpenSpec
  // teams-chat-driver). The three ids are the `infra/teams` module's outputs; `operators` are
  // Entra object ids allowed the operator-only verbs; `targeted` turns on targeted (private)
  // channel messages once the tenant has them (PR 2).
  teams?: TeamsConfig;
  // The web chat surface (OpenSpec web-chat-driver): only for `orch web` / `CHAT_SURFACES=web`; undefined when
  // no WEB_* setting is set. Login is OIDC against the installation's issuer, or none on a loopback listener.
  web?: WebConfig;
  // CHAT_SURFACES: the chat drivers this installation runs beside its run mode's (OpenSpec
  // multi-driver-installation); validated against the drivers this build has. Empty = the run mode only.
  chatSurfaces: ChatDriverName[];
  // YouTrack support-ticket investigation pilot; undefined (off) unless YOUTRACK_URL +
  // YOUTRACK_TOKEN are set. `label` is the trigger tag; `ping` is the Slack user ids to
  // @-mention with each finding. The token is a read-only YouTrack permanent token.
  // `englishTaggers` are YouTrack logins/emails whose tag means "this one's for us, not for
  // support": the writeup comes back in English instead of the ticket's language.
  youtrack?: { baseUrl: string; token: string; label: string; ping: string[]; englishTaggers: string[] };
  // Channel→project registry: one bot, many channels, one isolated sandbox per project.
  projectsConfigPath: string;
  // Sentry error/perf/log reporting; undefined (off) unless SENTRY_DSN is set. `logs` opt-in
  // (SENTRY_LOGS=1) since it sends log content to Sentry's cloud.
  sentry?: { dsn: string; environment: string; release?: string; tracesSampleRate: number; logs: boolean };
  // Agent messaging (OpenSpec agent-messaging, design D8/D18): this installation's id in every address
  // (INSTALLATION_ID, default `local`), and the hub client's settings when HUB_URL is set — without it
  // there is no socket. A HUB_URL the client cannot use is reported in `hubProblem`, never a boot failure.
  messaging: MessagingEnv;
}

// Slack config resolves in two shapes: classic single-workspace (bot + app token) and
// OAuth multi-workspace (client credentials + app token; bot token optional as a seed).
// Absent app token → no Slack (the non-slack CLI commands don't need it). Partial OAuth
// credentials throw rather than silently running single-workspace.
function slackConfig(): Config['slack'] {
  const appToken = process.env.SLACK_APP_TOKEN;
  const botToken = process.env.SLACK_BOT_TOKEN;
  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  const stateSecret = process.env.SLACK_STATE_SECRET;
  if (!appToken) return undefined;
  let oauth: SlackOauthConfig | undefined;
  if (clientId || clientSecret || stateSecret) {
    if (!clientId || !clientSecret || !stateSecret) {
      throw new Error(
        'Partial Slack OAuth config: set ALL of SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_STATE_SECRET (or none).',
      );
    }
    oauth = {
      clientId,
      clientSecret,
      stateSecret,
      scopes: process.env.SLACK_SCOPES
        ? process.env.SLACK_SCOPES.split(',').map((s) => s.trim()).filter(Boolean)
        : DEFAULT_BOT_SCOPES,
      port: num('SLACK_OAUTH_PORT', 3000),
      homeTeamId: process.env.SLACK_HOME_TEAM_ID,
    };
  }
  if (!botToken && !oauth) return undefined; // app token alone can't run the bot
  return { botToken, appToken, oauth };
}

export interface TeamsConfig {
  appId: string;
  appPassword: string;
  tenantId: string;
  port: number;
  statusMinMs: number;
  operators: string[];
  targeted: boolean;
  // TEAMS_TRACE: 'shape' (=1) — one journal line per inbound activity with its shape (type, scope, attachment
  // content types/names/hosts), never the text; 'full' — the whole inbound body and every API request and
  // response, secrets scrubbed, for a staging installation collecting what Teams really sends. Else 'off'.
  trace: 'off' | 'shape' | 'full';
}

export interface WebConfig {
  port: number; // WEB_PORT — the loopback listener (nginx is the public face); default 8787
  bind: string; // WEB_BIND — the address the listener binds; default 127.0.0.1
  baseUrl: string; // WEB_BASE_URL — the public origin, for the login redirect URI and permalinks (no trailing slash)
  auth: 'oidc' | 'none'; // WEB_AUTH — `none` only on a loopback listener with a localhost base URL (the e2e harness)
  oidc?: { issuer: string; clientId: string; clientSecret: string; groupsClaim: string };
  org: string; // WEB_ORG — the organization behind the issuer, the surface's tenant id (D6)
  operators: string[]; // WEB_OPERATORS — OIDC subjects or e-mails: operator verbs + access admins
  allow: string[]; // WEB_ALLOW — e-mails or `group:<name>`; empty = everyone the issuer lets in (open mode)
  sessionSecret: string; // WEB_SESSION_SECRET — signs the session cookie (≥ 32 chars); generated per boot under `none`
  maxFileMb: number; // WEB_MAX_FILE_MB — per file and per post; default 20
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const isLocalUrl = (u: string): boolean => {
  try {
    return LOCAL_HOSTS.has(new URL(u).hostname);
  } catch {
    return false;
  }
};

/**
 * Pure: the web surface's settings from the environment. No WEB_* key at all → undefined (the surface is
 * not configured). Anything set → a complete block or an error naming the missing setting: with OIDC the
 * issuer, client id and secret, the public base URL and the session secret are all required; `WEB_AUTH=none`
 * is accepted only for a loopback listener with a localhost base URL — a public listener never runs without
 * a login (web-chat-driver D3).
 */
export function webConfigFrom(env: Record<string, string | undefined>): WebConfig | undefined {
  if (!Object.keys(env).some((k) => k.startsWith('WEB_') && env[k] !== undefined && env[k] !== '')) return undefined;
  const port = numFrom(env, 'WEB_PORT', 8787);
  const bind = env.WEB_BIND || '127.0.0.1';
  const list = (k: string) => (env[k] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const authRaw = env.WEB_AUTH || 'oidc';
  if (authRaw !== 'oidc' && authRaw !== 'none') throw new Error(`WEB_AUTH must be 'oidc' or 'none', got: ${authRaw}`);
  const maxFileMb = numFrom(env, 'WEB_MAX_FILE_MB', 20);
  if (authRaw === 'none') {
    const baseUrl = (env.WEB_BASE_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, '');
    if (!LOCAL_HOSTS.has(bind)) throw new Error(`WEB_AUTH=none needs a loopback listener (WEB_BIND=127.0.0.1), got WEB_BIND=${bind}`);
    if (!isLocalUrl(baseUrl)) throw new Error(`WEB_AUTH=none needs a localhost WEB_BASE_URL, got ${baseUrl}`);
    return {
      port,
      bind,
      baseUrl,
      auth: 'none',
      org: env.WEB_ORG || 'local',
      operators: list('WEB_OPERATORS'),
      allow: list('WEB_ALLOW'),
      sessionSecret: env.WEB_SESSION_SECRET || randomBytes(32).toString('hex'),
      maxFileMb,
    };
  }
  const missing = ['WEB_OIDC_ISSUER', 'WEB_OIDC_CLIENT_ID', 'WEB_OIDC_CLIENT_SECRET', 'WEB_BASE_URL', 'WEB_SESSION_SECRET'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`Partial web config: missing ${missing.join(', ')} (the web surface logs people in through OIDC; WEB_AUTH=none is for a localhost listener only).`);
  const issuer = env.WEB_OIDC_ISSUER!.replace(/\/+$/, '');
  if (!/^https:\/\//.test(issuer)) throw new Error(`WEB_OIDC_ISSUER must be an https URL, got ${issuer}`);
  const baseUrl = env.WEB_BASE_URL!.replace(/\/+$/, '');
  if (!/^https?:\/\//.test(baseUrl)) throw new Error(`WEB_BASE_URL must be an http(s) origin, got ${baseUrl}`);
  if (env.WEB_SESSION_SECRET!.length < 32) throw new Error('WEB_SESSION_SECRET must be at least 32 characters (e.g. `openssl rand -hex 32`)');
  return {
    port,
    bind,
    baseUrl,
    auth: 'oidc',
    oidc: { issuer, clientId: env.WEB_OIDC_CLIENT_ID!, clientSecret: env.WEB_OIDC_CLIENT_SECRET!, groupsClaim: env.WEB_OIDC_GROUPS_CLAIM || 'cognito:groups' },
    org: env.WEB_ORG || new URL(issuer).hostname,
    operators: list('WEB_OPERATORS'),
    allow: list('WEB_ALLOW'),
    sessionSecret: env.WEB_SESSION_SECRET!,
    maxFileMb,
  };
}

function numFrom(env: Record<string, string | undefined>, key: string, dflt: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number, got: ${raw}`);
  return n;
}

// Any of the three TEAMS_* ids set → all three must be (a half-configured Teams installation
// should fail loudly at boot, not answer 401 to every activity); none → no Teams.
function teamsConfig(): TeamsConfig | undefined {
  const appId = process.env.TEAMS_APP_ID;
  const appPassword = process.env.TEAMS_APP_PASSWORD;
  const tenantId = process.env.TEAMS_TENANT_ID;
  if (!appId && !appPassword && !tenantId) return undefined;
  const missing = [!appId && 'TEAMS_APP_ID', !appPassword && 'TEAMS_APP_PASSWORD', !tenantId && 'TEAMS_TENANT_ID'].filter(Boolean);
  if (missing.length) throw new Error(`Partial Teams config: missing ${missing.join(', ')} (set all three TEAMS_* ids, or none).`);
  return {
    appId: appId!,
    appPassword: appPassword!,
    tenantId: tenantId!,
    port: num('TEAMS_PORT', 3978),
    statusMinMs: num('TEAMS_STATUS_MIN_MS', 2000),
    operators: (process.env.TEAMS_OPERATORS || '').split(',').map((s) => s.trim()).filter(Boolean),
    targeted: process.env.TEAMS_TARGETED === '1',
    trace: process.env.TEAMS_TRACE === 'full' ? 'full' : process.env.TEAMS_TRACE === '1' ? 'shape' : 'off',
  };
}

/**
 * Pure: switches that were retired and now change nothing (OpenSpec `retire-agent-dispatch` D4). Still set,
 * each gets one warning at boot so the operator removes it — never a refusal to start, never honoured.
 */
export function retiredEnvWarnings(env: Record<string, string | undefined>): string[] {
  const on = (v: string | undefined): boolean => v === '1' || v === 'true';
  return on(env.DISPATCH) ? ['config: DISPATCH is retired — agent messaging replaces it'] : [];
}

export function loadConfig(): Config {
  const sandboxDriver = sandboxDriverEnv(process.env.SANDBOX_DRIVER);
  const sshRuntime = process.env.SSHDOCKER_RUNTIME || 'privileged';
  if (sshRuntime !== 'privileged' && sshRuntime !== 'sysbox-runc') {
    throw new Error(`SSHDOCKER_RUNTIME must be 'sysbox-runc' or 'privileged', got: ${sshRuntime}`);
  }
  return {
    sshDocker: process.env.SSHDOCKER_HOST
      ? { host: process.env.SSHDOCKER_HOST, runtime: sshRuntime }
      : undefined,
    sandboxDriver,
    snapshot: { image: req('SNAPSHOT_IMAGE') },
    sandbox: {
      autoStopMinutes: autoStopMinutesEnv(process.env.SANDBOX_AUTOSTOP_MINUTES),
      workDir: process.env.SANDBOX_WORK_DIR || '/root/work',
      namePrefix: process.env.SANDBOX_NAME_PREFIX || 'proj-',
    },
    credit: resolveCredit(process.env, process.env.HOME),
    claudeModel: process.env.CLAUDE_MODEL || undefined,
    repoSkills: repoSkillsEnv(process.env.REPO_SKILLS),
    claudeCliVersion: cliVersionEnv(),
    github: githubAuth(),
    slack: slackConfig(),
    teams: teamsConfig(),
    web: webConfigFrom(process.env),
    chatSurfaces: parseSurfaces(process.env.CHAT_SURFACES),
    youtrack:
      process.env.YOUTRACK_URL && process.env.YOUTRACK_TOKEN
        ? {
            baseUrl: process.env.YOUTRACK_URL,
            token: process.env.YOUTRACK_TOKEN,
            label: process.env.YOUTRACK_LABEL || 'AI auto review',
            ping: (process.env.YOUTRACK_PING || '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
            englishTaggers: (process.env.YOUTRACK_ENGLISH_TAGGERS || '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          }
        : undefined,
    projectsConfigPath:
      process.env.PROJECTS_CONFIG_PATH ||
      new URL('../projects.config.json', import.meta.url).pathname,
    messaging: messagingEnv(process.env),
    sentry: process.env.SENTRY_DSN
      ? {
          dsn: process.env.SENTRY_DSN,
          environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'production',
          release: resolveRelease(),
          tracesSampleRate: num('SENTRY_TRACES_SAMPLE_RATE', 1),
          logs: process.env.SENTRY_LOGS === '1',
        }
      : undefined,
  };
}

/**
 * SANDBOX_DRIVER: unset or empty → ssh-docker, the only sandbox driver (OpenSpec retire-daytona-driver D3),
 * as is `ssh-docker` itself. Any other value — `daytona` above all — stops the boot in one sentence: it was
 * written for a driver this build does not have, and a project is never moved to a new, empty sandbox on a
 * guess. Nothing else the Daytona driver read (DAYTONA_*, SNAPSHOT_NAME, SANDBOX_CPU/_MEMORY/_DISK) is read.
 */
export function sandboxDriverEnv(raw: string | undefined): SandboxDriverKind {
  if (!raw || raw === 'ssh-docker') return 'ssh-docker';
  throw new Error(`SANDBOX_DRIVER=${raw}: the Daytona driver was removed after v0.42.0; ssh-docker is the only sandbox driver`);
}

/**
 * SANDBOX_AUTOSTOP_MINUTES: idle minutes before the bot stops a project's ssh-docker container (OpenSpec
 * sandbox-idle-stop, which also applies a 10-minute floor).
 * Trimmed: unset, empty or only spaces → 30 (`num()` read spaces as 0, i.e. "never"); 0 or negative →
 * never; not a number → the boot fails naming the key.
 */
export function autoStopMinutesEnv(raw: string | undefined): number {
  const v = (raw ?? '').trim();
  if (!v) return 30;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Env var SANDBOX_AUTOSTOP_MINUTES must be a number, got: ${raw}`);
  return n;
}

/** REPO_SKILLS: exactly `1` → on (agent-skills: repo skills load in multi-repo projects); unset or anything else → off. */
export const repoSkillsEnv = (v: string | undefined): boolean => (v ?? '').trim() === '1';
