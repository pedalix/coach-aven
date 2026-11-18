// reapWorktrees runs a shell script in the sandbox: these tests run that script against real git repositories in a
// temp dir (sh, as in the sandbox), so the idle rule is checked on what git actually writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reapWorktrees } from './project.js';
import type { SandboxHandle } from './driver.js';

const TEN_DAYS_AGO = `@${Math.floor(Date.now() / 1000) - 10 * 86400}`;
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, stdio: 'pipe' }).toString().trim();

// A pushed repo whose only commit is ten days old — like `origin/develop` of a client repo nobody touched this week.
function repoWithOldCommit() {
  const root = mkdtempSync(join(tmpdir(), 'reap-'));
  git(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  git(root, 'clone', '-q', 'origin.git', 'repo');
  const repo = join(root, 'repo');
  writeFileSync(join(repo, 'README'), 'hello\n');
  git(repo, 'add', 'README');
  execFileSync('git', ['commit', '-q', '-m', 'old'], {
    cwd: repo,
    env: { ...env, GIT_AUTHOR_DATE: TEN_DAYS_AGO, GIT_COMMITTER_DATE: TEN_DAYS_AGO },
  });
  git(repo, 'push', '-q', 'origin', 'main');
  return { root, repo };
}

const localSandbox = {
  exec: async (cmd: string) => ({ exitCode: 0, result: execFileSync('sh', ['-c', cmd], { env }).toString() }),
} as unknown as SandboxHandle;

// Make a worktree look untouched for two days: its admin files, the only activity record the reaper reads.
const ageAdminFiles = (wt: string) => {
  const gd = git(wt, 'rev-parse', '--absolute-git-dir');
  execFileSync('touch', ['-c', '-d', '2 days ago', join(gd, 'HEAD'), join(gd, 'index'), join(gd, 'logs', 'HEAD')]);
};

test('reapWorktrees: a worktree made just now on a ten-day-old commit is kept (the commit date is not its activity)', async () => {
  const { root, repo } = repoWithOldCommit();
  try {
    git(repo, 'worktree', 'add', '-q', '--detach', join(root, 'wt'), 'origin/main');
    assert.equal(await reapWorktrees(localSandbox, repo), 0);
    assert.match(git(repo, 'worktree', 'list'), /\/wt /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reapWorktrees: the same worktree with no git activity for longer than WORKTREE_REAP_HOURS is reaped', async () => {
  const { root, repo } = repoWithOldCommit();
  try {
    const wt = join(root, 'wt');
    git(repo, 'worktree', 'add', '-q', '--detach', wt, 'origin/main');
    ageAdminFiles(wt);
    assert.equal(await reapWorktrees(localSandbox, repo), 1);
    assert.doesNotMatch(git(repo, 'worktree', 'list'), /\/wt /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reapWorktrees: an idle worktree with uncommitted work is kept, and checking it does not make it look active', async () => {
  const { root, repo } = repoWithOldCommit();
  try {
    const wt = join(root, 'wt');
    git(repo, 'worktree', 'add', '-q', '--detach', wt, 'origin/main');
    writeFileSync(join(wt, 'notes.txt'), 'work in progress\n');
    ageAdminFiles(wt);
    const gd = git(wt, 'rev-parse', '--absolute-git-dir');
    const indexAge = () => execFileSync('stat', ['-c', '%Y', join(gd, 'index')]).toString().trim();
    const before = indexAge();
    assert.equal(await reapWorktrees(localSandbox, repo), 0);
    assert.equal(indexAge(), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
