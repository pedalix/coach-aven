import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clusterPoints, MIN } from './cluster.js';
import { commitBlocks } from './git.js';
import { decodeProjectDir, promptOf, sessionBlocks } from './claude.js';
import { blockId, containerOfRemote, scrubActivity, shortContainer } from './normalise.js';
import { containerForCwd, diffDay, pullLocal } from './pull.js';
import { buildStore } from '../store.js';
import { callTool } from '../../../snapshot/plain/sources-mcp.mjs';
import type { PullContext } from '../types.js';

const C = 'github.com/brandhaus-tools/platform';

test('clusterPoints: gap joins, lead-in, minimum', () => {
  const T = Date.parse('2026-10-05T09:00:00Z');
  const b = clusterPoints([0, 40, 200].map((m) => ({ t: T + m * MIN, ref: String(m) })), 90, 20, 20);
  assert.deepEqual(b.map((x) => x.minutes), [60, 20]);
  assert.equal(new Date(b[0]!.start).toISOString(), '2026-10-05T08:40:00.000Z');
});

test('commitBlocks clusters per local day (Moscow), dedupes shas across worktrees, titles carry the first subject', () => {
  const commits = [
    { sha: 'a1'.padEnd(40, '0'), iso: '2026-10-05T20:50:00+03:00', subject: 'feat: one' },
    { sha: 'b2'.padEnd(40, '0'), iso: '2026-10-05T21:30:00+03:00', subject: 'fix: two' },
    { sha: 'b2'.padEnd(40, '0'), iso: '2026-10-05T21:30:00+03:00', subject: 'fix: two' }, // same commit seen from a worktree
    { sha: 'c3'.padEnd(40, '0'), iso: '2026-10-06T00:10:00+03:00', subject: 'three (next local day)' },
  ];
  const days = commitBlocks(C, commits, 'Europe/Moscow', 'box');
  assert.deepEqual([...days.keys()].sort(), ['2026-10-05', '2026-10-06']);
  const d5 = days.get('2026-10-05')!;
  assert.equal(d5.length, 1);
  assert.equal(d5[0]!.minutes, 60);
  assert.equal(d5[0]!.items.length, 2);
  assert.match(d5[0]!.title, /^brandhaus-tools\/platform: 2 commits — feat: one$/);
  assert.equal(d5[0]!.items[0]!.text, 'a100000 feat: one');
  assert.equal(days.get('2026-10-06')![0]!.minutes, 20);
  assert.equal(d5[0]!.id, blockId('git', C, d5[0]!.start));
});

test('decodeProjectDir resolves lossy dashes against the filesystem, including dot-dirs', () => {
  const fs = new Set(['/home', '/home/ubuntu', '/home/ubuntu/phpstorm', '/home/ubuntu/phpstorm/hcg', '/home/ubuntu/phpstorm/hcg/campaign-manager',
    '/home/ubuntu/phpstorm/bluefin', '/home/ubuntu/phpstorm/bluefin/lumora', '/home/ubuntu/phpstorm/bluefin/lumora/.claude', '/home/ubuntu/phpstorm/bluefin/lumora/.claude/worktrees', '/home/ubuntu/phpstorm/bluefin/lumora/.claude/worktrees/release-r5-languages']);
  const ex = (p: string) => fs.has(p);
  assert.equal(decodeProjectDir('-home-ubuntu-phpstorm-hcg-campaign-manager', ex), '/home/ubuntu/phpstorm/hcg/campaign-manager');
  assert.equal(decodeProjectDir('-home-ubuntu-phpstorm-bluefin-lumora--claude-worktrees-release-r5-languages', ex), '/home/ubuntu/phpstorm/bluefin/lumora/.claude/worktrees/release-r5-languages');
  assert.equal(decodeProjectDir('-home-ubuntu-nope', ex), null);
});

test('promptOf takes the first human text, skips commands, reminders, tool results and meta lines', () => {
  assert.equal(promptOf(JSON.stringify({ type: 'user', message: { role: 'user', content: 'Fix the  login\nbug' } })), 'Fix the login bug');
  assert.equal(promptOf(JSON.stringify({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } })), undefined);
  assert.equal(promptOf(JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } })), undefined);
  assert.equal(promptOf(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } })), undefined);
  assert.equal(promptOf(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'add a test' }] } })), 'add a test');
});

test('sessionBlocks: gap 60, min 10, one item per session with its first prompt', () => {
  const m0 = Math.floor(Date.parse('2026-10-05T09:00:00Z') / MIN);
  const days = sessionBlocks('/w/cm', [
    { file: '/p/a.jsonl', minutes: [m0, m0 + 10, m0 + 25], prompt: 'build the store' },
    { file: '/p/b.jsonl', minutes: [m0 + 100, m0 + 110] },
  ], 'UTC', 'box');
  const b = days.get('2026-10-05')!;
  assert.deepEqual(b.map((x) => x.minutes), [25, 10]);
  assert.match(b[0]!.title, /^claude in w\/cm \(1 session\): build the store$/);
  assert.equal(b[1]!.items[0]!.text, '(no prompt)');
});

test('containers: remotes collapse to host/owner/name; cwd maps to the enclosing repo', () => {
  assert.equal(containerOfRemote('git@github.com:brandhaus-tools/platform.git'), C);
  assert.equal(containerOfRemote('https://x-access-token:abc@github.com/brandhaus-tools/platform.git'), C);
  assert.equal(shortContainer(C), 'brandhaus-tools/platform');
  assert.equal(shortContainer('/home/ubuntu/phpstorm/hcg/discovery'), 'hcg/discovery');
  const repos = [{ path: '/w/a', remote: '', container: 'R' }];
  assert.equal(containerForCwd('/w/a/sub', repos), 'R');
  assert.equal(containerForCwd('/w/ab', repos), '/w/ab');
});

test('diffDay tombstones blocks that a recompute merged away; scrubActivity redacts secrets in items', () => {
  const rec = { source: 'git' as const, account: 'box', id: 'new', container: C, start: 's', end: 'e', minutes: 1, title: 't', items: [] };
  const d = diffDay(['old', 'new'], [rec], 'git', C);
  assert.deepEqual(d.ids, ['new']);
  assert.deepEqual(d.write.map((r) => ('deleted' in r ? `x:${r.id}` : r.id)), ['new', 'x:old']);
  const s = scrubActivity({ ...rec, items: [{ ts: 't', text: 'set DATABASE_URL=postgres://u:hunter2secret@db/x' }] });
  assert.ok(!JSON.stringify(s).includes('hunter2secret'));
  assert.ok(s.scrub!.redactions >= 1);
});

function git(dir: string, args: string[], date?: string) {
  execFileSync('git', ['-C', dir, ...args], {
    stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Owen Hale', GIT_AUTHOR_EMAIL: 'owen@home.example', GIT_COMMITTER_NAME: 'Owen Hale', GIT_COMMITTER_EMAIL: 'owen@home.example', ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
  });
}

test('pullLocal end to end: git + claude → raw, cursor resume extends a block, store + activity tool read it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'local-'));
  const repo = join(root, 'code', 'platform');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['remote', 'add', 'origin', `https://${C}.git`]);
  const commit = (msg: string, date: string) => {
    writeFileSync(join(repo, 'f.txt'), msg);
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', msg], date);
  };
  commit('feat: first', '2026-10-05T09:00:00Z');
  commit('feat: second', '2026-10-05T09:40:00Z');
  const projects = join(root, 'claude');
  mkdirSync(join(projects, '-x'), { recursive: true });
  writeFileSync(
    join(projects, '-x', 's1.jsonl'),
    [
      JSON.stringify({ type: 'user', cwd: repo, timestamp: '2026-10-05T10:00:00Z', message: { role: 'user', content: 'refactor the store build' } }),
      JSON.stringify({ type: 'assistant', cwd: repo, timestamp: '2026-10-05T10:30:00Z', message: { role: 'assistant', content: 'ok' } }),
    ].join('\n') + '\n',
  );
  const raw = join(root, 'raw');
  const ctx: PullContext = { slug: 't', outDir: raw, tokenPath: '/dev/null', log: () => undefined };
  const cfg = { roots: [join(root, 'code')], authors: ['Hale'], claudeProjectsDir: projects, since: '2026-10-01' };
  const s1 = await pullLocal(ctx, cfg, { tz: 'UTC', host: 'box' });
  assert.equal(s1.ok, true, s1.errors.join('; '));
  assert.deepEqual([s1.counts.git, s1.counts.claude, s1.counts.tombstones], [1, 1, 0]);
  // nothing new → nothing written
  const s2 = await pullLocal(ctx, cfg, { tz: 'UTC', host: 'box' });
  assert.deepEqual([s2.counts.git, s2.counts.claude], [0, 0]);
  // a later commit within 90 min extends the SAME block (same id, upsert)
  commit('fix: third', '2026-10-05T10:50:00Z');
  const s3 = await pullLocal(ctx, cfg, { tz: 'UTC', host: 'box' });
  assert.equal(s3.counts.git, 1);
  const lines = readFileSync(join(raw, 'local', 'activity.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const gitLines = lines.filter((l) => l.source === 'git');
  assert.equal(gitLines.length, 2);
  assert.equal(gitLines[0].id, gitLines[1].id);
  assert.equal(gitLines[1].items.length, 3);
  buildStore({ slug: 't', rawDir: raw, storePath: join(root, 'store.sqlite'), replicaDir: join(root, 'replica'), log: () => undefined });
  const db = join(root, 'replica', 'store.sqlite');
  const act = callTool(db, 'activity', { since: '2026-10-05', until: '2026-10-05' }) as { activity: { source: string; minutes: number; container: string; items: unknown[] }[] };
  assert.deepEqual(act.activity.map((a) => a.source).sort(), ['claude', 'git']);
  assert.equal(act.activity.find((a) => a.source === 'git')!.minutes, 130); // 09:00→10:50 + 20 lead-in
  assert.equal(act.activity.find((a) => a.source === 'claude')!.container, C); // cwd inside the repo → repo container
  const hit = callTool(db, 'activity', { q: 'refactor' }) as { activity: { source: string }[] };
  assert.deepEqual(hit.activity.map((a) => a.source), ['claude']);
  const stats = callTool(db, 'stats', {}) as { activity: { source: string; n: number }[] };
  assert.deepEqual(stats.activity.map((a) => a.source), ['claude', 'git']);
});
