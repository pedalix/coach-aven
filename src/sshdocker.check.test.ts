// The local Docker boot check (OpenSpec quickstart D6): retried for a minute, one error line after the last miss,
// nothing when Docker answers (late or at once), and no call at all for a remote sandbox host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLocalDocker, type SshRun } from './sshdocker.js';

function fake(answersAfterMs: number | undefined) {
  let clock = 0;
  const calls: string[] = [];
  const errors: string[] = [];
  const run: SshRun = async (host, cmd) => {
    calls.push(`${host}:${cmd}`);
    return answersAfterMs !== undefined && clock >= answersAfterMs ? { code: 0, stdout: '29.0.1', stderr: '' } : { code: 1, stdout: '', stderr: 'permission denied while trying to connect to the Docker daemon socket\nmore' };
  };
  const deps = { run, sleep: async (ms: number) => void (clock += ms), now: () => clock, error: (m: string) => void errors.push(m), groups: () => '1000' };
  return { deps, calls, errors };
}

test('failing throughout: retried for the window, then one error naming the socket, the groups and the fix', async () => {
  const f = fake(undefined);
  assert.equal(await checkLocalDocker('local', f.deps), false);
  assert.ok(f.calls.length >= 6, `retried (${f.calls.length} tries)`);
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0], /\/var\/run\/docker\.sock/);
  assert.match(f.errors[0], /groups: 1000/);
  assert.match(f.errors[0], /permission denied/);
  assert.doesNotMatch(f.errors[0], /more/, 'the first line of docker\'s answer only');
  assert.match(f.errors[0], /\.\/init\.sh/);
});

test('Docker answering after 30 s, or at once: nothing logged', async () => {
  for (const after of [30_000, 0]) {
    const f = fake(after);
    assert.equal(await checkLocalDocker('local', f.deps), true);
    assert.deepEqual(f.errors, []);
  }
});

test('a remote sandbox host (or none): no call, nothing logged', async () => {
  for (const host of ['aven@sandboxes.example.com', undefined]) {
    const f = fake(undefined);
    assert.equal(await checkLocalDocker(host, f.deps), true);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.errors, []);
  }
});

test('the boot path never awaits the check (a hung Docker CLI must not hold the boot)', async () => {
  const { readFileSync } = await import('node:fs');
  const root = readFileSync(new URL('./chat/root.ts', import.meta.url), 'utf8');
  assert.match(root, /\n\s*void checkLocalDocker\(cfg\.sshDocker\?\.host\)\.catch\(/);
  assert.doesNotMatch(root, /await checkLocalDocker/);
});
