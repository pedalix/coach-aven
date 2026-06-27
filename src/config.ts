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

export interface Config {
  daytona: { apiUrl: string; apiKey: string; organizationId: string };
  snapshot: { name: string; image: string; cpu: number; memory: number; disk: number };
  // namePrefix isolates dev from prod on a SHARED Daytona: dev → `dev-proj-<slug>`,
  // prod → `proj-<slug>`, so the two never share a warm sandbox (set SANDBOX_NAME_PREFIX).
  sandbox: { autoStopMinutes: number; workDir: string; namePrefix: string };
  claudeOauthToken: string;
  github: GitHubAuth;
  // Slack is only needed for the `slack` command; undefined otherwise.
  slack?: { botToken: string; appToken: string };
  // Channel→project registry: one bot, many channels, one isolated sandbox per project.
  projectsConfigPath: string;
  // Sentry error/perf/log reporting; undefined (off) unless SENTRY_DSN is set. `logs` opt-in
  // (SENTRY_LOGS=1) since it sends log content to Sentry's cloud.
  sentry?: { dsn: string; environment: string; release?: string; tracesSampleRate: number; logs: boolean };
}

export function loadConfig(): Config {
  return {
    daytona: {
      apiUrl: req('DAYTONA_API_URL'),
      apiKey: req('DAYTONA_API_KEY'),
      organizationId: req('DAYTONA_ORGANIZATION_ID'),
    },
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
    projectsConfigPath:
      process.env.PROJECTS_CONFIG_PATH ||
      new URL('../projects.config.json', import.meta.url).pathname,
    sentry: process.env.SENTRY_DSN
      ? {
          dsn: process.env.SENTRY_DSN,
          environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'production',
          release: process.env.SENTRY_RELEASE,
          tracesSampleRate: num('SENTRY_TRACES_SAMPLE_RATE', 1),
          logs: process.env.SENTRY_LOGS === '1',
        }
      : undefined,
  };
}
