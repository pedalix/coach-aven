import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pruneThreshold,
  dockerdGuardCmd,
  housekeepingScript,
  lastPassText,
  lastTurnBySlug,
  serialRounds,
  passDue,
  parseHousekeepingReport,
} from './housekeeping.js';

test('pruneThreshold: default 80, env override, garbage rejected', () => {
  assert.equal(pruneThreshold(undefined), 80);
  assert.equal(pruneThreshold('70'), 70);
  assert.equal(pruneThreshold('0'), 80); // out of range
  assert.equal(pruneThreshold('150'), 80);
  assert.equal(pruneThreshold('nope'), 80);
});

test('dockerd guard emits exactly one marker in every branch', () => {
  const cmd = dockerdGuardCmd();
  assert.match(cmd, /hk:dockerd=ok/);
  assert.match(cmd, /hk:dockerd=restarted/);
  assert.match(cmd, /hk:dockerd=failed/);
});

test('dockerd guard clears stale pid files, keeps live dockerd/containerd ones', () => {
  const cmd = dockerdGuardCmd();
  // Both pid files that survive an unclean sandbox stop must be checked…
  assert.match(cmd, /\/var\/run\/docker\.pid/);
  assert.match(cmd, /\/var\/run\/docker\/containerd\/containerd\.pid/);
  // …verified against the pid's real process name, and only removed when stale.
  assert.match(cmd, /\/proc\/\$p\/comm/);
  assert.match(cmd, /dockerd\|containerd\) ;; \*\) rm -f "\$f"/);
  // Cleanup happens in the dead-daemon branch, before the restart attempt.
  assert.ok(cmd.indexOf('rm -f "$f"') < cmd.indexOf('(dockerd >>'));
});

test('dockerd guard nests cgroups before a start: v2 only, not where the subtree has every controller', () => {
  const cmd = dockerdGuardCmd();
  const nest = cmd.indexOf('/sys/fs/cgroup/init/cgroup.procs');
  assert.ok(nest > 0 && nest < cmd.indexOf('(dockerd >>'), 'the processes move before dockerd starts');
  assert.ok(cmd.indexOf('hk:dockerd=ok') < nest, 'a running dockerd is left as it is');
  assert.match(cmd, /\[ -f \/sys\/fs\/cgroup\/cgroup\.controllers \] && \[ "\$\(cat \/sys\/fs\/cgroup\/cgroup\.controllers\)" != "\$\(cat \/sys\/fs\/cgroup\/cgroup\.subtree_control\)" \]/);
  assert.match(cmd, /> \/sys\/fs\/cgroup\/cgroup\.subtree_control 2>\/dev\/null \|\| :/);
});

test('housekeeping script: threshold gates the prune, and volumes are NEVER pruned', () => {
  const s = housekeepingScript(85, undefined, true);
  assert.match(s, /"\$usage" -ge 85/);
  assert.match(s, /docker container prune -f/);
  // A stopped Sail stack (an idle project's normal state since the idle stop) keeps its containers,
  // and so its images: only containers without a compose project label are pruned.
  assert.match(s, /docker container prune -f --filter "label!=com\.docker\.compose\.project"/);
  assert.match(s, /docker image prune -af --filter "until=168h"/);
  assert.match(s, /docker builder prune -f/);
  // The guardrail: Sail volumes hold project databases — no volume pruning, ever.
  assert.doesNotMatch(s, /--volumes/);
  assert.doesNotMatch(s, /volume prune/);
});

test('parse: healthy no-prune run', () => {
  const r = parseHousekeepingReport('hk:dockerd=ok\nhk:disk=52\nhk:reclaimable=Images:1.2GB\nhk:prune=skipped\n', 0);
  assert.equal(r.dockerd, 'ok');
  assert.equal(r.diskPct, 52);
  assert.equal(r.prune, 'skipped');
  assert.equal(r.digest, 'dockerd ok · disk 52% · no prune · 0 worktrees reaped');
});

test('parse: restarted dockerd + prune with before/after disk', () => {
  const r = parseHousekeepingReport(
    'hk:dockerd=restarted\nhk:disk=87\nhk:prune=done\nhk:diskafter=71\n',
    2,
  );
  assert.equal(r.dockerd, 'restarted');
  assert.equal(r.prune, 'done');
  assert.equal(r.digest, 'dockerd restarted · disk 87%→71% · pruned · 2 worktrees reaped');
});

test('parse: garbage output degrades to unknowns, digest still one line', () => {
  const r = parseHousekeepingReport('docker: command not found\n', 1);
  assert.equal(r.dockerd, 'unknown');
  assert.equal(r.prune, 'unknown');
  assert.equal(r.digest, 'dockerd unknown · disk ? · no prune · 1 worktree reaped');
  assert.ok(!r.digest.includes('\n'));
});

test('script: a CLI pin adds the in-place upgrade step; no pin → version probe only', () => {
  const pinned = housekeepingScript(80, '2.1.260', true);
  assert.match(pinned, /npm install -g --prefix \/root\/\.local @anthropic-ai\/claude-code@2\.1\.260/);
  assert.match(pinned, /cli:upgrade=/);
  const probe = housekeepingScript(80, undefined, true);
  assert.match(probe, /cli:version=/);
  assert.ok(!probe.includes('npm install'));
});

test('parse: cli markers ride along in the report and digest', () => {
  const out = 'cli:from=2.1.183\ncli:upgrade=installed\ncli:version=2.1.260\nhk:dockerd=ok\nhk:disk=40\nhk:prune=skipped\n';
  const r = parseHousekeepingReport(out, 0);
  assert.deepEqual(r.cli, { from: '2.1.183', version: '2.1.260', upgrade: 'installed' });
  assert.equal(r.digest, 'dockerd ok · disk 40% · no prune · 0 worktrees reaped · cli 2.1.260 (from 2.1.183)');
  const failed = parseHousekeepingReport(out.replace('installed', 'failed').replace('version=2.1.260', 'version=2.1.183'), 0);
  assert.match(failed.digest, /cli 2\.1\.183 \(upgrade FAILED\)$/);
  assert.match(parseHousekeepingReport(out.replace('installed', 'current'), 0).digest, /cli 2\.1\.260$/);
});

// ── when a project has a pass (OpenSpec nightly-housekeeping D2) ────────────────────────────────────
test('passDue — only a project that had a turn since its last pass', () => {
  assert.equal(passDue({}), false, 'no turn on record: nothing to clean, nothing is woken');
  assert.equal(passDue({ lastPassAt: '2026-03-02T03:00:00.000Z' }), false);
  assert.equal(passDue({ lastTurnAt: '2026-03-02T14:00:00.000Z' }), true, 'never had a pass');
  assert.equal(passDue({ lastPassAt: '2026-03-02T03:00:00.000Z', lastTurnAt: '2026-03-02T14:00:00.000Z' }), true);
  assert.equal(passDue({ lastPassAt: '2026-03-03T03:00:00.000Z', lastTurnAt: '2026-03-02T14:00:00.000Z' }), false, 'quiet since the pass');
});

test('lastTurnBySlug — the newest usage record per project, whatever the order', () => {
  const m = lastTurnBySlug([
    { slug: 'skishop', at: '2026-03-02T14:00:00.000Z' },
    { slug: 'glacier', at: '2026-03-01T09:00:00.000Z' },
    { slug: 'skishop', at: '2026-03-02T09:00:00.000Z' },
  ]);
  assert.deepEqual([...m], [['skishop', '2026-03-02T14:00:00.000Z'], ['glacier', '2026-03-01T09:00:00.000Z']]);
});

test('lastTurnBySlug — the nightly tidy is not the project working', () => {
  const m = lastTurnBySlug([
    { slug: 'skishop', at: '2026-03-02T14:00:00.000Z', key: 'T0ABCDEF:thread:1.2' },
    { slug: 'skishop', at: '2026-03-03T03:07:00.000Z', key: 'cron:tidy:skishop' },
    { slug: 'glacier', at: '2026-03-03T03:09:00.000Z', key: 'T0ABCDEF:cron:tidy:glacier' },
  ]);
  assert.deepEqual([...m], [['skishop', '2026-03-02T14:00:00.000Z']]);
});

test('serialRounds — one project at a time, no second round over a running one, a failure does not stop the round', async () => {
  const log: string[] = [];
  const failed: unknown[] = [];
  const gates = new Map<string, () => void>();
  const start = serialRounds<string>(
    (slug) =>
      new Promise<void>((resolve, reject) => {
        log.push(`start ${slug}`);
        gates.set(slug, () => {
          log.push(`end ${slug}`);
          if (slug === 'glacier') reject(new Error('boom'));
          else resolve();
        });
      }),
    (e) => failed.push(e),
  );
  const settle = (): Promise<void> => new Promise((r) => setImmediate(r));
  assert.equal(start(['skishop', 'glacier', 'lodge']), true);
  await settle();
  assert.deepEqual(log, ['start skishop'], 'the second project waits for the first');
  assert.equal(start(['skishop']), false, 'the next tick starts nothing while the round runs');
  gates.get('skishop')!();
  await settle();
  gates.get('glacier')!();
  await settle();
  gates.get('lodge')!();
  await settle();
  assert.deepEqual(log, ['start skishop', 'end skishop', 'start glacier', 'end glacier', 'start lodge', 'end lodge']);
  assert.equal(failed.length, 1);
  assert.equal(start([]), true, 'a finished round frees the next one');
});

test('lastPassText — the last pass, or that none ran yet; always that it runs by itself', () => {
  assert.match(lastPassText('skishop', undefined, '/aven'), /no pass yet\. It runs by itself at night/);
  const t = lastPassText('skishop', { at: '2026-03-02T03:04:05.000Z', summary: 'woke · disk 41%' }, '/aven');
  assert.match(t, /Last pass: 2026-03-02 03:04 UTC — _woke · disk 41%_/);
  assert.match(t, /`\/aven housekeeping now` runs one/);
});
