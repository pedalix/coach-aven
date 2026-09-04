import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pruneThreshold,
  dockerdGuardCmd,
  housekeepingScript,
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

test('housekeeping script: threshold gates the prune, and volumes are NEVER pruned', () => {
  const s = housekeepingScript(85);
  assert.match(s, /"\$usage" -ge 85/);
  assert.match(s, /docker container prune -f/);
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
  const pinned = housekeepingScript(80, '2.1.260');
  assert.match(pinned, /npm install -g --prefix \/root\/\.local @anthropic-ai\/claude-code@2\.1\.260/);
  assert.match(pinned, /cli:upgrade=/);
  const probe = housekeepingScript(80);
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
