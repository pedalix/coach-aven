import { readFileSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';

loadDotenv();

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

// Resolve the Claude Code subscription token. Prefer an explicit env var (a stable
// `claude setup-token` value, recommended for production). On a dev box with Claude
// installed, fall back to the live, auto-refreshing access token in ~/.claude — this
// avoids the "baked a token that later expired" trap for warm sandboxes.
function resolveClaudeToken(): string {
  const explicit = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (explicit) return explicit;
  const credPath = `${process.env.HOME}/.claude/.credentials.json`;
  try {
    const cred = JSON.parse(readFileSync(credPath, 'utf8'));
    const tok = cred?.claudeAiOauth?.accessToken;
    if (tok) return tok;
  } catch {
    /* fall through to error */
  }
  throw new Error(
    'No Claude token: set CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) or have ~/.claude credentials present',
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

// Which sandbox provider backs a project (see driver.ts). Global default via
// SANDBOX_DRIVER; overridable per project in projects.config.json (`driver` field).
export type SandboxDriverKind = 'daytona' | 'ssh-docker';

export interface Config {
  // Provider configs are optional — only the drivers actually selected need theirs set
  // (a pure ssh-docker deployment shouldn't have to fake DAYTONA_* vars, and vice versa).
  daytona?: { apiUrl: string; apiKey: string; organizationId: string };
  // ssh-docker: `host` is an ssh target (user@host or an ~/.ssh/config alias; key auth,
  // BatchMode). `runtime` picks how containers get DinD for Laravel Sail.
  sshDocker?: { host: string; runtime: 'sysbox-runc' | 'privileged' };
  sandboxDriver: SandboxDriverKind;
  snapshot: { name: string; image: string; cpu: number; memory: number; disk: number };
  // namePrefix isolates dev from prod on a SHARED Daytona: dev → `dev-proj-<slug>`,
  // prod → `proj-<slug>`, so the two never share a warm sandbox (set SANDBOX_NAME_PREFIX).
  sandbox: { autoStopMinutes: number; workDir: string; namePrefix: string };
  claudeOauthToken: string;
  github: GitHubAuth;
  // Slack is only needed for the `slack` command; undefined otherwise.
  slack?: { botToken: string; appToken: string };
  // YouTrack support-ticket investigation pilot; undefined (off) unless YOUTRACK_URL +
  // YOUTRACK_TOKEN are set. `label` is the trigger tag; `ping` is the Slack user ids to
  // @-mention with each finding. The token is a read-only YouTrack permanent token.
  youtrack?: { baseUrl: string; token: string; label: string; ping: string[] };
  // Channel→project registry: one bot, many channels, one isolated sandbox per project.
  projectsConfigPath: string;
  // Sentry error/perf/log reporting; undefined (off) unless SENTRY_DSN is set. `logs` opt-in
  // (SENTRY_LOGS=1) since it sends log content to Sentry's cloud.
  sentry?: { dsn: string; environment: string; release?: string; tracesSampleRate: number; logs: boolean };
}

export function loadConfig(): Config {
  const driver = process.env.SANDBOX_DRIVER || 'daytona';
  if (driver !== 'daytona' && driver !== 'ssh-docker') {
    throw new Error(`SANDBOX_DRIVER must be 'daytona' or 'ssh-docker', got: ${driver}`);
  }
  const sshRuntime = process.env.SSHDOCKER_RUNTIME || 'privileged';
  if (sshRuntime !== 'privileged' && sshRuntime !== 'sysbox-runc') {
    throw new Error(`SSHDOCKER_RUNTIME must be 'sysbox-runc' or 'privileged', got: ${sshRuntime}`);
  }
  return {
    daytona: process.env.DAYTONA_API_URL
      ? {
          apiUrl: req('DAYTONA_API_URL'),
          apiKey: req('DAYTONA_API_KEY'),
          organizationId: req('DAYTONA_ORGANIZATION_ID'),
        }
      : undefined,
    sshDocker: process.env.SSHDOCKER_HOST
      ? { host: process.env.SSHDOCKER_HOST, runtime: sshRuntime }
      : undefined,
    sandboxDriver: driver,
    snapshot: {
      name: req('SNAPSHOT_NAME'),
      image: req('SNAPSHOT_IMAGE'),
      cpu: num('SANDBOX_CPU', 2),
      memory: num('SANDBOX_MEMORY', 4),
      disk: num('SANDBOX_DISK', 20),
    },
    sandbox: {
      autoStopMinutes: num('SANDBOX_AUTOSTOP_MINUTES', 30),
      workDir: process.env.SANDBOX_WORK_DIR || '/root/work',
      namePrefix: process.env.SANDBOX_NAME_PREFIX || 'proj-',
    },
    claudeOauthToken: resolveClaudeToken(),
    github: githubAuth(),
    slack:
      process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN
        ? { botToken: process.env.SLACK_BOT_TOKEN, appToken: process.env.SLACK_APP_TOKEN }
        : undefined,
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
          }
        : undefined,
    projectsConfigPath:
      process.env.PROJECTS_CONFIG_PATH ||
      new URL('../projects.config.json', import.meta.url).pathname,
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
