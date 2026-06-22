import { readFileSync } from 'node:fs';
import type { Sandbox } from '@daytonaio/sdk';
import type { Config } from './config.js';
import type { McpServerSpec } from './projects.js';
import { exec } from './daytona.js';
import { log } from './log.js';

// Boot-time provisioning for a bare `docker:28-dind` (Alpine) sandbox: installs the
// same tooling the custom snapshot image would bake in (git, gh, node, Claude Code,
// sail shims). Idempotent — skips if `claude` is already present. Once we push the
// custom GHCR image and point SNAPSHOT_IMAGE at it, this becomes a no-op.
export async function provisionTooling(sandbox: Sandbox) {
  const have = await exec(sandbox, 'command -v claude >/dev/null 2>&1 && echo yes || echo no');
  if (have.result.trim() === 'yes') {
    log.info('tooling already provisioned');
    return;
  }
  log.step('provisioning tooling (apk + claude-code) — first boot only');
  await exec(
    sandbox,
    'apk add --no-cache bash git github-cli nodejs npm curl jq openssh-client ca-certificates',
    { check: true, timeout: 600 },
  );
  await exec(sandbox, 'npm install -g @anthropic-ai/claude-code', { check: true, timeout: 600 });

  // sail shims: bare php/composer/artisan → ./vendor/bin/sail
  const shim = readFileSync(new URL('../snapshot/shims/sail-shim.sh', import.meta.url), 'utf8');
  await sandbox.fs.uploadFile(Buffer.from(shim), '/usr/local/bin/sail-shim');
  await exec(
    sandbox,
    'chmod +x /usr/local/bin/sail-shim && for c in php composer artisan; do ln -sf /usr/local/bin/sail-shim /usr/local/bin/$c; done',
    { check: true },
  );
  log.info('tooling provisioned');
}

// Layout inside the sandbox: <workDir>/<slug>/<repoName> per repo (a project = one
// sandbox holding all its repos side by side).
export function projectDir(cfg: Config, slug: string) {
  return `${cfg.sandbox.workDir}/${slug}`;
}
export function repoName(repo: string): string {
  return repo.split('/')[1] ?? repo;
}
// Multi-repo chat layout: each repo cloned at <workDir>/<slug>/<repoName>, so a
// project (one sandbox) can hold several repos side by side (e.g. cms-general).
export function repoCheckout(cfg: Config, slug: string, repo: string) {
  return `${projectDir(cfg, slug)}/${repoName(repo)}`;
}

// Write the GitHub installation token into the sandbox WITHOUT it showing up in
// command logs (fs.uploadFile, not echo). A git credential helper + gh read it.
// Call this at the start of every task so the (≈1h) token is always fresh.
export async function seedGitHubAuth(sandbox: Sandbox, token: string) {
  await sandbox.fs.uploadFile(Buffer.from(token), '/root/.gh-token');
  await exec(sandbox, 'chmod 600 /root/.gh-token', { check: true });
  // git: credential helper that emits the token for github.com over https.
  await exec(
    sandbox,
    `git config --global credential.helper '!f() { echo username=x-access-token; echo "password=$(cat /root/.gh-token)"; }; f'`,
    { check: true },
  );
  // sane committer identity for the bot
  await exec(sandbox, `git config --global user.name "bluefin-agent"`, { check: true });
  await exec(sandbox, `git config --global user.email "agent@example.com"`, { check: true });
  // gh: authenticate so the agent's `gh pr create` works.
  await exec(sandbox, `gh auth login --with-token < /root/.gh-token`, { check: true });
}

// Write the Claude Code token into the sandbox (via fs, not echoed). claude reads
// CLAUDE_CODE_OAUTH_TOKEN; we set it per-command as `$(cat /root/.cc-token)` so the
// token never lands in command logs and a warm sandbox always uses the fresh token.
export async function seedClaudeAuth(sandbox: Sandbox, token: string) {
  await sandbox.fs.uploadFile(Buffer.from(token), '/root/.cc-token');
  await exec(sandbox, 'chmod 600 /root/.cc-token', { check: true });
}

// Prefix that injects the token without leaking it into the command string/logs.
export const CC_TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN=$(cat /root/.cc-token)';

const MCP_CONFIG_PATH = '/root/.mcp-config.json';

// Resolve ${ENV_NAME} refs in an MCP server's env from the orchestrator's process.env
// (so secrets live in the orchestrator's .env, not the project config / the sandbox config).
function resolveEnvRefs(env: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    out[k] = v.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => process.env[name] ?? '');
  }
  return out;
}

// Materialize the project's MCP servers into a --mcp-config file inside the sandbox
// (written via the file API, never echoed). Returns the in-sandbox path, or undefined
// when the project has no MCP servers. Combined with --strict-mcp-config, claude then
// loads ONLY these servers (the repo's own .mcp.json is ignored).
export async function seedMcpConfig(
  sandbox: Sandbox,
  mcp: McpServerSpec[] | undefined,
): Promise<string | undefined> {
  if (!mcp || mcp.length === 0) return undefined;
  const mcpServers: Record<string, unknown> = {};
  for (const s of mcp) {
    mcpServers[s.name] = { command: s.command, args: s.args ?? [], env: resolveEnvRefs(s.env) };
  }
  await sandbox.fs.uploadFile(Buffer.from(JSON.stringify({ mcpServers })), MCP_CONFIG_PATH);
  await exec(sandbox, `chmod 600 ${MCP_CONFIG_PATH}`, { check: true });
  return MCP_CONFIG_PATH;
}

// Integer hours (busybox `$(( ))` in the sandbox is integer-only — a float would break it).
const REAP_HOURS = Math.floor(Number(process.env.WORKTREE_REAP_HOURS)) || 12;

// Reap finished/orphaned git worktrees in a repo (agents work in per-task worktrees; some
// outlive their session). Removes only worktrees that are SAFE to drop: not the main
// checkout, clean (no uncommitted changes), with nothing unpushed/unmerged
// (`rev-list HEAD --not --remotes` empty → every commit is already on a remote, zero data
// loss), and idle longer than WORKTREE_REAP_HOURS (so an active conversation's worktree is
// left alone). Run at prepareChat — lazy, no background timer to lose across restarts.
export async function reapWorktrees(sandbox: Sandbox, repoDir: string) {
  const script =
    `cd ${repoDir} 2>/dev/null || exit 0\n` +
    `git worktree prune 2>/dev/null\n` +
    `main=$(git rev-parse --show-toplevel 2>/dev/null)\n` +
    `now=$(date +%s)\n` +
    `git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}' | while read wt; do\n` +
    `  [ "$wt" = "$main" ] && continue\n` +
    `  [ -d "$wt" ] || continue\n` +
    `  [ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ] && continue\n` +
    `  [ -n "$(git -C "$wt" rev-list HEAD --not --remotes 2>/dev/null)" ] && continue\n` +
    `  ct=$(git -C "$wt" log -1 --format=%ct 2>/dev/null || echo $now)\n` +
    `  [ $(( now - ct )) -lt $(( ${REAP_HOURS} * 3600 )) ] && continue\n` +
    `  git worktree remove "$wt" --force 2>/dev/null && echo "reaped $wt"\n` +
    `done`;
  const r = await exec(sandbox, script);
  const reaped = r.result.split('\n').filter((l) => l.startsWith('reaped ')).length;
  if (reaped > 0) log.info(`reaped ${reaped} finished worktree(s) under ${repoDir}`);
}

// Clone (or fetch) a single repo into its own <slug>/<repoName> dir. Used by the chat
// path so a project can hold N repos. Idempotent.
export async function cloneRepo(sandbox: Sandbox, cfg: Config, slug: string, repo: string) {
  const dir = repoCheckout(cfg, slug, repo);
  const exists = await exec(sandbox, `test -d ${dir}/.git && echo yes || echo no`);
  if (exists.result.trim() === 'yes') {
    log.step(`repo present — fetching ${repo}`);
    await exec(sandbox, `git -C ${dir} fetch --all --prune`, { check: true, timeout: 600 });
  } else {
    log.step(`cloning ${repo} → ${dir}`);
    await exec(sandbox, `mkdir -p ${projectDir(cfg, slug)}`, { check: true });
    await exec(sandbox, `git clone https://github.com/${repo}.git ${dir}`, {
      check: true,
      timeout: 900,
    });
  }
}

