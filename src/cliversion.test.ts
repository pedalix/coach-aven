import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidCliVersion,
  compareVersions,
  cliVersionCmd,
  cliUpgradeCmd,
  parseCliMarkers,
  cliUpgradeNotice,
  cliPinDrift,
  fetchCliDistTags,
} from './cliversion.js';

test('isValidCliVersion — plain x.y.z only (it lands in a shell command)', () => {
  assert.ok(isValidCliVersion('2.1.260'));
  assert.ok(!isValidCliVersion('latest'));
  assert.ok(!isValidCliVersion('2.1'));
  assert.ok(!isValidCliVersion('2.1.260; rm -rf /'));
  assert.ok(!isValidCliVersion(undefined));
});

test('compareVersions — numeric, not lexicographic', () => {
  assert.ok(compareVersions('2.1.183', '2.1.260') < 0);
  assert.ok(compareVersions('2.1.260', '2.1.236') > 0);
  assert.equal(compareVersions('2.1.260', '2.1.260'), 0);
  assert.ok(compareVersions('2.10.0', '2.9.9') > 0); // 10 > 9 as numbers, "1" < "9" as strings
  assert.ok(compareVersions('3.0.0', '2.99.99') > 0);
});

test('cliUpgradeCmd — pinned: compare, install only when different, emit all markers', () => {
  const cmd = cliUpgradeCmd('2.1.260');
  assert.match(cmd, /claude --version/);
  assert.match(cmd, /npm_config_cache=\/tmp\/cli-npm-cache npm install -g --prefix \/root\/\.local @anthropic-ai\/claude-code@2\.1\.260 >\/tmp\/cli-upgrade\.log/);
  assert.match(cmd, /rm -rf \/tmp\/cli-npm-cache/);
  assert.match(cmd, /PATH=\/root\/\.local\/bin:\$PATH claude --version/); // the override wins when present
  assert.match(cmd, /cli:upgrade=current/);
  assert.match(cmd, /cli:upgrade=installed/);
  assert.match(cmd, /cli:upgrade=failed/);
  assert.match(cmd, /cli:from=\$cur/);
  assert.match(cmd, /cli:version=/);
});

test('cliUpgradeCmd — an invalid pin degrades to the read-only probe (no shell injection)', () => {
  const cmd = cliUpgradeCmd('2.1.260; echo pwned');
  assert.equal(cmd, cliVersionCmd());
  assert.ok(!cmd.includes('pwned'));
  assert.ok(!cmd.includes('npm install'));
});

test('parseCliMarkers — picks markers out of mixed hk:/cli: output', () => {
  const out = 'hk:dockerd=ok\ncli:from=2.1.183\ncli:upgrade=installed\ncli:version=2.1.260 \nhk:disk=40\n';
  assert.deepEqual(parseCliMarkers(out), { from: '2.1.183', version: '2.1.260', upgrade: 'installed' });
  assert.deepEqual(parseCliMarkers('cli:version=2.1.183\n'), { from: undefined, version: '2.1.183', upgrade: undefined });
  assert.deepEqual(parseCliMarkers('garbage'), { from: undefined, version: undefined, upgrade: undefined });
  assert.equal(parseCliMarkers('cli:upgrade=weird\n').upgrade, undefined);
  assert.equal(parseCliMarkers('cli:version=\n').version, undefined); // claude missing → empty → undefined
});

test('cliUpgradeNotice — installed → info, failed → warning, current → nothing', () => {
  assert.deepEqual(cliUpgradeNotice({ from: '2.1.183', version: '2.1.260', upgrade: 'installed' }, 'proj-caldora'), {
    level: 'info',
    text: 'Claude Code 2.1.183 → 2.1.260 in proj-caldora',
  });
  const failed = cliUpgradeNotice({ from: '2.1.183', version: '2.1.183', upgrade: 'failed' }, 'proj-lumora')!;
  assert.equal(failed.level, 'warning');
  assert.match(failed.text, /FAILED in proj-lumora \(still 2\.1\.183\).*cli-upgrade\.log/);
  assert.equal(cliUpgradeNotice({ from: '2.1.260', version: '2.1.260', upgrade: 'current' }, 'x'), undefined);
  assert.equal(cliUpgradeNotice({}, 'x'), undefined);
});

test('cliPinDrift — behind stable → alert; equal or ahead → quiet; unset pin → nudge; no stable → quiet', () => {
  assert.match(cliPinDrift('2.1.183', '2.1.236')!, /pin 2\.1\.183 is behind npm stable 2\.1\.236/);
  assert.equal(cliPinDrift('2.1.236', '2.1.236'), undefined);
  assert.equal(cliPinDrift('2.1.260', '2.1.236'), undefined); // deliberate latest pin ≠ drift
  assert.match(cliPinDrift(undefined, '2.1.236')!, /CLAUDE_CLI_VERSION is not set/);
  assert.equal(cliPinDrift(undefined, undefined), undefined);
  assert.equal(cliPinDrift('2.1.183', undefined), undefined);
});

test('fetchCliDistTags — parses the registry tags, validates shapes, swallows failures', async () => {
  const ok = (body: unknown, status = 200) =>
    (async () => ({ ok: status < 400, status, json: async () => body })) as unknown as typeof fetch;
  assert.deepEqual(await fetchCliDistTags(ok({ stable: '2.1.236', latest: '2.1.260', next: '2.1.260' })), {
    stable: '2.1.236',
    latest: '2.1.260',
  });
  assert.deepEqual(await fetchCliDistTags(ok({ stable: 'weird' })), { stable: undefined, latest: undefined });
  assert.equal(await fetchCliDistTags(ok({}, 503)), undefined);
  assert.equal(
    await fetchCliDistTags((async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch),
    undefined,
  );
});
