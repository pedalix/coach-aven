import { readFileSync } from 'node:fs';
import type { Sandbox } from '@daytonaio/sdk';
import type { Config } from './config.js';
import type { ProjectRecord } from './state.js';
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

// Layout inside the sandbox:
//   <workDir>/<slug>/main          ← the canonical clone (default branch)
//   <workDir>/<slug>/task-<id>     ← per-task git worktree (own branch)
export function projectDir(cfg: Config, slug: string) {
  return `${cfg.sandbox.workDir}/${slug}`;
}
export function mainCheckout(cfg: Config, slug: string) {
  return `${projectDir(cfg, slug)}/main`;
}
export function worktreeDir(cfg: Config, slug: string, taskId: string) {
  return `${projectDir(cfg, slug)}/task-${taskId}`;
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

// First-time clone of the project's default branch into <slug>/main. Idempotent:
// if the checkout already has a .git, we fetch instead of re-cloning.
export async function ensureClone(
  sandbox: Sandbox,
  cfg: Config,
  proj: ProjectRecord,
): Promise<{ defaultBranch: string }> {
  const dir = mainCheckout(cfg, proj.slug);
  const exists = await exec(sandbox, `test -d ${dir}/.git && echo yes || echo no`);
  if (exists.result.trim() === 'yes') {
    log.step(`repo present — fetching latest in ${dir}`);
    await exec(sandbox, `git -C ${dir} fetch --all --prune`, { check: true, timeout: 600 });
  } else {
    log.step(`cloning ${proj.repo} → ${dir}`);
    await exec(sandbox, `mkdir -p ${projectDir(cfg, proj.slug)}`, { check: true });
    await exec(sandbox, `git clone https://github.com/${proj.repo}.git ${dir}`, {
      check: true,
      timeout: 900, // 640 MB repo over the box's link
    });
  }
  const branch = await exec(sandbox, `git -C ${dir} rev-parse --abbrev-ref HEAD`, { check: true });
  return { defaultBranch: branch.result.trim() };
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

// Create an isolated worktree + branch for a task. COMPOSE_PROJECT_NAME is derived
// from the task id so each task's Sail (Postgres/mail) stack is isolated.
export async function addWorktree(
  sandbox: Sandbox,
  cfg: Config,
  slug: string,
  taskId: string,
  baseBranch: string,
): Promise<{ worktreePath: string; branch: string; composeProject: string }> {
  const main = mainCheckout(cfg, slug);
  const wt = worktreeDir(cfg, slug, taskId);
  const branch = `task-${taskId}`;
  const composeProject = `t${taskId}`.replace(/[^a-z0-9]/gi, '').toLowerCase();

  const present = await exec(sandbox, `test -d ${wt} && echo yes || echo no`);
  if (present.result.trim() === 'yes') {
    log.step(`worktree ${wt} already exists — reusing`);
    return { worktreePath: wt, branch, composeProject };
  }
  log.step(`git worktree add ${wt} (branch ${branch} off ${baseBranch})`);
  await exec(sandbox, `git -C ${main} worktree add -b ${branch} ${wt} origin/${baseBranch}`, {
    check: true,
  });
  return { worktreePath: wt, branch, composeProject };
}
