import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { limitConvergeLines, limitRunFlags, parseCpuLimit, parseMemoryLimit, sandboxLimitsFromEnv } from './sandboxlimits.js';
import { ensureSandboxScript } from './sshdocker.js';

test('parseMemoryLimit — docker sizes in bytes; anything else names the setting and the value', () => {
  assert.equal(parseMemoryLimit('6g'), 6 * 1024 ** 3);
  assert.equal(parseMemoryLimit('512M'), 512 * 1024 ** 2);
  assert.equal(parseMemoryLimit('1.5g'), 1.5 * 1024 ** 3);
  assert.equal(parseMemoryLimit('6442450944'), 6442450944);
  assert.equal(parseMemoryLimit(' 8192k '), 8192 * 1024, 'trimmed');
  for (const bad of ['', 'lots', '6gb', '-1g', '0', '1m', '6 g', '6g; reboot']) {
    assert.throws(() => parseMemoryLimit(bad), new RegExp(`SANDBOX_LIMIT_MEMORY must be a size.*got: ${bad.replace(/[;]/g, '.')}`), bad);
  }
});

test('parseCpuLimit — a positive number, fractions allowed, in nano-CPUs', () => {
  assert.equal(parseCpuLimit('4'), 4_000_000_000);
  assert.equal(parseCpuLimit('0.5'), 500_000_000);
  for (const bad of ['', '0', '-2', 'four', '4 cpus', '1e3', '0.0']) assert.throws(() => parseCpuLimit(bad), /SANDBOX_LIMIT_CPUS must be a positive number/, bad);
});

test('sandboxLimitsFromEnv — nothing set is no limits object; one setting alone is kept alone', () => {
  assert.equal(sandboxLimitsFromEnv({}), undefined);
  assert.equal(sandboxLimitsFromEnv({ SANDBOX_LIMIT_MEMORY: ' ', SANDBOX_LIMIT_CPUS: '' }), undefined);
  assert.deepEqual(sandboxLimitsFromEnv({ SANDBOX_LIMIT_MEMORY: '6g' }), { memoryBytes: 6442450944 });
  assert.deepEqual(sandboxLimitsFromEnv({ SANDBOX_LIMIT_MEMORY: '6g', SANDBOX_LIMIT_CPUS: '4' }), { memoryBytes: 6442450944, nanoCpus: 4_000_000_000 });
  // The removed driver's names stay ignored (sandbox-drivers: settings only the removed driver read).
  assert.equal(sandboxLimitsFromEnv({ SANDBOX_MEMORY: '8', SANDBOX_CPU: '4' }), undefined);
  assert.throws(() => sandboxLimitsFromEnv({ SANDBOX_LIMIT_CPUS: 'many' }), /SANDBOX_LIMIT_CPUS/);
});

test('limitRunFlags — memory with no swap beyond it, CPUs; nothing when unset', () => {
  assert.equal(limitRunFlags(undefined), '');
  assert.equal(limitRunFlags({ memoryBytes: 6442450944, nanoCpus: 4_000_000_000 }), '--memory 6442450944 --memory-swap 6442450944 --cpus 4');
  assert.equal(limitRunFlags({ nanoCpus: 500_000_000 }), '--cpus 0.5');
});

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

test('ensureSandboxScript — with no limits the script is the one the driver ran before the settings existed', () => {
  // Hashes of the scripts at the commit before this change (b137756), for a docker-in-docker and a plain project.
  assert.equal(sha(ensureSandboxScript('proj-caldora', 'caldora', 'img', '--runtime sysbox-runc', [], true)), '6057d4c69214936e07e0bf71ed1ad6228440b1b1f1452e27deec38e1d8cbe7c2');
  assert.equal(
    sha(ensureSandboxScript('proj-owen-ops', 'owen-ops', 'img', '', [{ source: '/srv/a', target: '/data', mode: 'ro' }], false, undefined)),
    '702b11bf38eca77bbe54447ede765e520401d879d89ecc74ebfa5339c0f9644d',
  );
});

test('ensureSandboxScript — limits go on docker run and into a compare-then-update step before the probes', () => {
  const s = ensureSandboxScript('proj-caldora', 'caldora', 'img', '--runtime sysbox-runc', [], true, { memoryBytes: 6442450944, nanoCpus: 4_000_000_000 });
  assert.ok(s.includes(`docker run -d --init --name 'proj-caldora' --runtime sysbox-runc --memory 6442450944 --memory-swap 6442450944 --cpus 4 \\`));
  assert.ok(s.includes(`if [ "$(docker inspect -f '{{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}' 'proj-caldora' 2>/dev/null)" != '6442450944 4000000000' ]; then`));
  assert.ok(s.indexOf('limits=failed') < s.indexOf('docker exec'), 'before the exec probe');
  assert.ok(s.trim().endsWith('echo "$outcome"'));
  // Only the memory setting: the CPU limit is neither read nor written.
  const m = limitConvergeLines(`'proj-caldora'`, { memoryBytes: 6442450944 }).join('\n');
  assert.ok(m.includes(`'{{.HostConfig.Memory}}'`));
  assert.equal(m.includes('NanoCpus'), false);
  assert.equal(m.includes('--cpus'), false);
  assert.deepEqual(limitConvergeLines(`'x'`, undefined), []);
});

// The step for real, against a fake `docker` on PATH that answers `inspect` from a file and records `update`.
test('the limits step for real — equal limits write nothing, different ones update, a refused update is a marker and not a failure', { skip: process.platform === 'win32' }, (t) => {
  const bin = mkdtempSync(join(tmpdir(), 'aven-docker-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const calls = join(bin, 'calls');
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/sh\ncase "$1" in\n  inspect) cat "${bin}/limits";;\n  update) echo "$*" >> "${calls}"; if [ -f "${bin}/refuse" ]; then echo "Error response from daemon: Cannot update container: memory limit below usage" >&2; echo "second line" >&2; exit 1; fi;;\nesac\n`,
    { mode: 0o755 },
  );
  const script = limitConvergeLines(`'proj-caldora'`, { memoryBytes: 6442450944, nanoCpus: 4_000_000_000 }).join('\n');
  const run = (): { stderr: string; updates: string } => {
    writeFileSync(calls, '');
    const stderr = execFileSync('sh', ['-c', `{ ${script}\n} 2>&1 >/dev/null`], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
    return { stderr: stderr.trim(), updates: readFileSync(calls, 'utf8').trim() };
  };
  writeFileSync(join(bin, 'limits'), '6442450944 4000000000\n');
  assert.deepEqual(run(), { stderr: '', updates: '' });
  writeFileSync(join(bin, 'limits'), '0 0\n');
  assert.deepEqual(run(), { stderr: 'limits=set', updates: 'update --memory 6442450944 --memory-swap 6442450944 --cpus 4 proj-caldora' });
  writeFileSync(join(bin, 'refuse'), '');
  const refused = run();
  assert.equal(refused.stderr, 'limits=failed Error response from daemon: Cannot update container: memory limit below usage');
  assert.ok(refused.updates.startsWith('update '));
});
