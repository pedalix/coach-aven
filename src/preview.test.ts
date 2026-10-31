// The preview builder over the REAL quickstart templates (OpenSpec ship-dispatcher, spec `worktree-preview`): a
// template change that drops a key the preview relies on fails here, in the same PR.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { branchSlug, buildPreview, childEnv, parseEnvFile, previewPrefix, type PreviewFiles } from './preview.js';

const ROOT = new URL('../', import.meta.url).pathname;
const T = {
  envExample: readFileSync(`${ROOT}quickstart/.env.example`, 'utf8'),
  projectsExample: readFileSync(`${ROOT}quickstart/projects.config.example.json`, 'utf8'),
};
const OPERATOR = { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test', GITHUB_TOKEN: 'github_pat_test', PREVIEW_REPO: 'acme/scratch' };
const O = { port: 8790, branch: 'fix/thread', sandboxImage: 'ghcr.io/pedalix/coach-aven-sandbox-plain:v0.48.0' };
const files = (r: ReturnType<typeof buildPreview>): PreviewFiles => {
  assert.ok(!('missing' in r), 'missing' in r ? r.missing.join(', ') : '');
  return r as PreviewFiles;
};

test('First preview on a machine: demo on the scratch repo, the quickstart\'s unprivileged sandboxes, the web chat on loopback', () => {
  const f = files(buildPreview(T, OPERATOR, O));
  const env = parseEnvFile(f.env);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-test');
  assert.equal(env.GITHUB_TOKEN, 'github_pat_test');
  assert.deepEqual([env.WEB_AUTH, env.WEB_BIND, env.WEB_PORT, env.WEB_BASE_URL], ['none', '127.0.0.1', '8790', 'http://127.0.0.1:8790']);
  assert.deepEqual([env.SANDBOX_DRIVER, env.SANDBOX_HOST], ['ssh-docker', 'local'], 'the quickstart\'s sandboxes on this machine\'s Docker');
  assert.deepEqual([env.SANDBOX_NAME_PREFIX, env.SANDBOX_MANAGED_BY, env.SANDBOX_IMAGE], ['pv-fix-thread-proj-', 'coach-aven-preview', O.sandboxImage]);
  assert.equal(f.env.match(/^WEB_AUTH=/gm)?.length, 1, 'the template\'s WEB_AUTH=link is replaced, not shadowed');
  const cfg = JSON.parse(f.projects) as { projects: { slug: string; repos: string[]; sandbox?: unknown }[] };
  assert.deepEqual(cfg.projects.map((p) => [p.slug, p.repos, p.sandbox]), [['demo', ['acme/scratch'], undefined]], 'no sandbox block: plain and unprivileged');
});

test('Missing operator file values: nothing is built, the missing keys are named', () => {
  assert.deepEqual(buildPreview(T, {}, O), { missing: ['CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY', 'GITHUB_TOKEN, or GITHUB_APP_ID with an absolute GITHUB_APP_PRIVATE_KEY_PATH', 'PREVIEW_REPO (owner/repo)'] });
  assert.deepEqual(buildPreview(T, { ...OPERATOR, PREVIEW_REPO: 'just-a-name' }, O), { missing: ['PREVIEW_REPO (owner/repo)'] });
});

test('Home runs on the same machine: no Slack, Teams, hub, tracker or error-tracker setting reaches a preview, even from preview.env', () => {
  const f = files(buildPreview(T, { ...OPERATOR, SLACK_BOT_TOKEN: 'xoxb-1', HUB_URL: 'wss://hub.example', YOUTRACK_TOKEN: 'perm', SENTRY_DSN: 'https://x', INSTALLATION_ID: 'home', CLAUDE_MODEL: 'claude-opus-5-5' }, O));
  const env = parseEnvFile(f.env);
  assert.deepEqual(Object.keys(env).filter((k) => /^(SLACK_|TEAMS_|HUB_|YOUTRACK_|SENTRY_)|^INSTALLATION_ID$/.test(k)), []);
  assert.equal(env.CLAUDE_MODEL, 'claude-opus-5-5', 'other operator values pass through');
  assert.deepEqual(Object.keys(parseEnvFile(T.envExample)).filter((k) => /^(SLACK_|TEAMS_|HUB_|YOUTRACK_|SENTRY_)/.test(k)), [], 'the quickstart template carries none either');
});

test('an API key instead of the subscription token; preview.env cannot move the preview off its own port, prefix or directory', () => {
  const env = parseEnvFile(files(buildPreview(T, { ANTHROPIC_API_KEY: 'sk-ant-api03-x', GITHUB_TOKEN: 'g', PREVIEW_REPO: 'a/b', WEB_PORT: '80', SANDBOX_NAME_PREFIX: 'proj-', AVEN_DIR: '/srv/home' }, O)).env);
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-api03-x');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.deepEqual([env.WEB_PORT, env.SANDBOX_NAME_PREFIX, env.AVEN_DIR], ['8790', 'pv-fix-thread-proj-', undefined]);
});

test('branch names make container-safe prefixes', () => {
  assert.equal(branchSlug('fix/Thread_42'), 'fix-thread-42');
  assert.equal(previewPrefix('feat/ship-dispatcher'), 'pv-feat-ship-dispatcher-');
  assert.equal(branchSlug('HEAD'), 'head');
  assert.equal(branchSlug('///'), 'detached');
  assert.ok(branchSlug('a'.repeat(80)).length <= 30);
  const a = branchSlug('feat/ship-dispatcher-preview-github-app'), b = branchSlug('feat/ship-dispatcher-preview-github-token');
  assert.notEqual(a, b, 'two long branches with one prefix get different slugs');
  assert.match(a, /^feat-ship-dispatcher-pr-[0-9a-f]{6}$/);
});

test('the bot process inherits only the basics and AVEN_DIR — a tracker token in the operator\'s shell stays out', () => {
  const env = childEnv({ PATH: '/usr/bin', HOME: '/home/me', YOUTRACK_TOKEN: 'perm', GRAFANA_SERVICE_ACCOUNT_TOKEN: 'g', SLACK_BOT_TOKEN: 'x' }, '/wt/.preview');
  assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/home/me', AVEN_DIR: '/wt/.preview' });
});

test('a GitHub App instead of a token: its settings pass through, the template\'s empty GITHUB_TOKEN stays empty (the bot then mints per turn, scoped to the project\'s repo)', () => {
  const op = { CLAUDE_CODE_OAUTH_TOKEN: 't', PREVIEW_REPO: 'acme/scratch', GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY_PATH: '/home/me/app.pem' };
  const env = parseEnvFile(files(buildPreview(T, op, O)).env);
  assert.deepEqual([env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY_PATH, env.GITHUB_TOKEN ?? ''], ['123', '/home/me/app.pem', '']);
  assert.deepEqual(buildPreview(T, { ...op, GITHUB_APP_PRIVATE_KEY_PATH: 'app.pem' }, O), { missing: ['GITHUB_TOKEN, or GITHUB_APP_ID with an absolute GITHUB_APP_PRIVATE_KEY_PATH'] }, 'a relative key path would resolve inside .preview/');
});
