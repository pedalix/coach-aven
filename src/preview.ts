// A worktree's preview bot (OpenSpec ship-dispatcher, spec `worktree-preview`): the quickstart's installation, run from
// source, on a scratch project. Pure: from the two quickstart templates and the operator's preview.env, the preview's
// `.env` and projects config, plus the process environment the bot starts with. No installation is ever a source —
// home included, which is a live node — so nothing here reads one (design D10).
import { createHash } from 'node:crypto';

// Settings that give a bot an identity, a tracker or an error sink: never in a preview, whatever preview.env says.
const FORBIDDEN = /^(SLACK_|TEAMS_|HUB_|YOUTRACK_|SENTRY_|INSTALLATION_ID$|CHAT_SURFACES$|DAEMON_LISTEN$)/;
// Settings the preview sets itself: the web chat on loopback, the isolation, the image.
const OWN = new Set(['WEB_AUTH', 'WEB_BIND', 'WEB_PORT', 'WEB_BASE_URL', 'SANDBOX_NAME_PREFIX', 'SANDBOX_MANAGED_BY', 'SANDBOX_IMAGE', 'AVEN_DIR', 'AVEN_DATA_DIR', 'PROJECTS_CONFIG_PATH']);
// The process environment the bot inherits: enough to find node, docker and the user, nothing that configures the bot
// (the operator's shell or a Claude session may export tracker tokens; dotenv never overrides what is already set).
const INHERIT = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL', 'TERM', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'XDG_RUNTIME_DIR'];

export const PREVIEW_PORT_FROM = 8790;

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

// `fix/Thread_42` → `fix-thread-42`: a container-name-safe slice of the branch. A name too long to keep whole is cut
// and carries a short hash of the full name, so two long branches with one prefix never share a sandbox.
export const branchSlug = (branch: string): string => {
  const s = branch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'detached';
  return s.length <= 30 ? s : `${s.slice(0, 23).replace(/-+$/, '')}-${createHash('sha256').update(branch).digest('hex').slice(0, 6)}`;
};

export const previewPrefix = (branch: string): string => `pv-${branchSlug(branch)}-`;

export interface PreviewFiles {
  env: string; // .preview/.env
  projects: string; // .preview/projects.config.json
}

export function buildPreview(
  t: { envExample: string; projectsExample: string },
  previewEnv: Record<string, string>,
  o: { port: number; branch: string; sandboxImage: string },
): PreviewFiles | { missing: string[] } {
  const credit = previewEnv.CLAUDE_CODE_OAUTH_TOKEN || previewEnv.ANTHROPIC_API_KEY;
  // GitHub access: a token, or a GitHub App. The bot mints an App's installation token per turn scoped to the
  // project's repositories (src/github.ts), so either way a preview agent reaches the scratch repository only. The key
  // path must be absolute: a relative one would resolve against .preview/, the preview's installation directory.
  const keyPath = previewEnv.GITHUB_APP_PRIVATE_KEY_PATH;
  const app = !!previewEnv.GITHUB_APP_ID && (!!previewEnv.GITHUB_APP_PRIVATE_KEY || (!!keyPath && keyPath.startsWith('/')));
  const missing = [
    ...(credit ? [] : ['CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY']),
    ...(previewEnv.GITHUB_TOKEN || app ? [] : ['GITHUB_TOKEN, or GITHUB_APP_ID with an absolute GITHUB_APP_PRIVATE_KEY_PATH']),
    ...(/^[\w.-]+\/[\w.-]+$/.test(previewEnv.PREVIEW_REPO ?? '') ? [] : ['PREVIEW_REPO (owner/repo)']),
  ];
  if (missing.length) return { missing };

  // The operator's values: everything preview.env sets except what a preview must not carry and what it sets itself.
  const theirs = Object.entries(previewEnv).filter(([k, v]) => v !== '' && k !== 'PREVIEW_REPO' && !FORBIDDEN.test(k) && !OWN.has(k));
  const credits = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];
  const set: [string, string][] = [
    ...theirs.filter(([k]) => !credits.includes(k)),
    previewEnv.CLAUDE_CODE_OAUTH_TOKEN ? ['CLAUDE_CODE_OAUTH_TOKEN', previewEnv.CLAUDE_CODE_OAUTH_TOKEN] : ['ANTHROPIC_API_KEY', previewEnv.ANTHROPIC_API_KEY],
    ['WEB_AUTH', 'none'],
    ['WEB_BIND', '127.0.0.1'],
    ['WEB_PORT', String(o.port)],
    ['WEB_BASE_URL', `http://127.0.0.1:${o.port}`],
    ['SANDBOX_NAME_PREFIX', `${previewPrefix(o.branch)}proj-`],
    ['SANDBOX_MANAGED_BY', 'coach-aven-preview'],
    ['SANDBOX_IMAGE', previewEnv.SANDBOX_IMAGE || o.sandboxImage],
  ];
  const keys = new Set([...set.map(([k]) => k), ...credits]);
  // The template stays the base (its comments say what each setting is); every line the preview replaces, and any
  // forbidden key, is dropped from it, and the preview's block is appended.
  const base = t.envExample
    .split('\n')
    .filter((line) => {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=/);
      return !m || (!keys.has(m[1]) && !FORBIDDEN.test(m[1]));
    })
    .join('\n')
    .trimEnd();
  const env = `${base}\n\n# ── preview (npm run preview; written on every start, edits are lost) ──\n${set.map(([k, v]) => `${k}=${v}`).join('\n')}\n`;

  const cfg = JSON.parse(t.projectsExample) as { projects: { slug: string; repos: string[] }[] };
  if (cfg.projects.length !== 1) throw new Error('quickstart/projects.config.example.json must hold exactly one project for the preview');
  cfg.projects[0].repos = [previewEnv.PREVIEW_REPO];
  return { env, projects: JSON.stringify(cfg, null, 2) + '\n' };
}

// What the bot process starts with: the inherited basics and AVEN_DIR; everything else comes from .preview/.env.
export function childEnv(processEnv: Record<string, string | undefined>, avenDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of INHERIT) if (processEnv[k]) out[k] = processEnv[k]!;
  out.AVEN_DIR = avenDir;
  return out;
}
