import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sq, safeToken, execScript, startSessionScript, streamSessionScript, runningProbeScript, parseContainerStates, ensureSandboxScript } from './sshdocker.js';

test('sq — single-quotes and survives embedded quotes', () => {
  assert.equal(sq('plain'), `'plain'`);
  assert.equal(sq(`it's`), `'it'\\''s'`);
});

test('safeToken — accepts bot-generated ids, rejects shell smuggling', () => {
  assert.equal(safeToken('proj-caldora'), 'proj-caldora');
  assert.equal(safeToken('claude-sess-1751000000-42'), 'claude-sess-1751000000-42');
  assert.throws(() => safeToken('x; rm -rf /'));
  assert.throws(() => safeToken('../escape'));
  assert.throws(() => safeToken('a b'));
});

test('execScript — folds stderr, applies cwd/env/timeout', () => {
  const s = execScript('composer install', {
    cwd: '/root/work/caldora',
    env: { COMPOSE_PROJECT_NAME: 'caldora' },
    timeout: 300,
  });
  assert.ok(s.startsWith('exec 2>&1'));
  assert.ok(s.includes(`cd '/root/work/caldora' || exit 1`));
  assert.ok(s.includes(`export COMPOSE_PROJECT_NAME='caldora'`));
  assert.ok(s.includes(`timeout 300 sh -c 'composer install'`));
});

test('execScript — no timeout runs the command bare (multi-line scripts intact)', () => {
  const s = execScript('line1\nline2');
  assert.ok(s.endsWith('line1\nline2'));
  assert.ok(!s.includes('timeout '));
});

test('startSessionScript — fifo, EOF holder, pid recorded and echoed', () => {
  const s = startSessionScript('claude-sess-1-2', `claude --verbose 'it'\\''s'`);
  assert.ok(s.includes(`d='/tmp/aven-sess/claude-sess-1-2'`));
  assert.ok(s.includes('mkfifo "$d/in"'));
  assert.ok(s.includes('sleep 2147483647 > "$d/in" &')); // holder — no EOF between turns
  assert.ok(s.includes('< "$d/in" > "$d/out.log" 2>&1 &'));
  assert.ok(s.includes('echo $! > "$d/pid"'));
  assert.ok(s.trim().endsWith('cat "$d/pid"')); // stdout of the script IS the cmdId
});

test('streamSessionScript — replays from byte 1, follows, dies with the pid', () => {
  const s = streamSessionScript('claude-sess-1-2');
  assert.ok(s.includes('tail -c +1 -f')); // full replay — claudeSession skips the snapshot prefix itself
  assert.ok(s.includes('kill -0 "$pid"')); // watcher ends the tail when the process exits
  // Zombie-aware: a dead-but-unreaped process must NOT keep the stream open (E2E-caught).
  assert.ok(s.includes(`grep -q '^State:.*Z'`));
});

test('runningProbeScript — zombie counts as down, id is validated', () => {
  const s = runningProbeScript('12345');
  assert.ok(s.includes(`kill -0 '12345'`));
  assert.ok(s.includes(`grep -q '^State:.*Z'`)); // zombies pass kill -0 — must be excluded
  assert.ok(s.includes('echo up') && s.includes('echo down'));
  assert.throws(() => runningProbeScript('1; reboot')); // cmdId round-trips via state.json
});

test('ensureSandboxScript — reuses, wakes, or creates; --init and labels survive', () => {
  const s = ensureSandboxScript('proj-caldora', 'caldora', 'ghcr.io/x/dind:pilot', '--runtime sysbox-runc');
  assert.ok(s.includes(`docker inspect -f '{{.State.Running}}' 'proj-caldora'`));
  assert.ok(s.includes('outcome=ready'));
  assert.ok(s.includes(`docker start 'proj-caldora' >/dev/null || exit 1`));
  assert.ok(s.includes('--init')); // no tini → session processes rot as zombies
  assert.ok(s.includes('--restart unless-stopped'));
  assert.ok(s.includes('--runtime sysbox-runc'));
  assert.ok(s.includes(`--label project='caldora'`));
  assert.ok(s.trim().endsWith('echo "$outcome"'));
  assert.throws(() => ensureSandboxScript('a b', 'caldora', 'img', '--privileged'));
});

test('ensureSandboxScript — probes exec and recycles a running-but-wedged container', () => {
  const s = ensureSandboxScript('proj-coach-aven', 'coach-aven', 'img', '--privileged');
  // The sysbox-orphan case: `docker ps` says Up, every exec dies. Probe twice (a busy
  // daemon must not cost a live session), then stop+start, then re-probe.
  assert.ok(s.includes(`docker exec 'proj-coach-aven' true`));
  assert.ok(s.includes('sleep 2'));
  assert.ok(s.includes(`docker stop -t 10 'proj-coach-aven'`));
  assert.ok(s.includes(`docker start 'proj-coach-aven' >/dev/null 2>&1`));
  assert.ok(s.includes('outcome=revived'));
  // A sandbox that still refuses exec is a hard failure, not a silent "ready".
  assert.ok(s.includes('still no exec after recycle'));
  assert.ok(s.includes('exit 1'));
});

test('ensureSandboxScript — unprivileged plain project: no runtime flag, ro mount, no exec-probe dance', () => {
  const s = ensureSandboxScript(
    'proj-owen-ops',
    'owen-ops',
    'ghcr.io/x/plain:abc',
    '',
    [{ source: '/srv/owen-ops/sources', target: '/data/sources', mode: 'ro' }],
    false,
  );
  const run = s.split('\n').find((l) => l.includes('docker run'))!;
  assert.equal(
    run,
    `  docker run -d --init --name 'proj-owen-ops' -v '/srv/owen-ops/sources:/data/sources:ro' --restart unless-stopped \\`,
  );
  assert.equal(s.includes('--privileged'), false);
  assert.equal(s.includes('--runtime'), false);
  // No dockerd in there → the sysbox exec-probe/recycle block is pointless and skipped.
  assert.equal(s.includes('exec probe failed'), false);
  assert.equal(s.includes('outcome=revived'), false);
  assert.ok(s.trim().endsWith('echo "$outcome"'));
  // Mount paths are re-validated at the shell boundary even though sandboxopts checked them.
  assert.throws(() => ensureSandboxScript('proj-x', 'x', 'img', '', [{ source: '/srv/a b', target: '/data', mode: 'ro' }], false));
  assert.throws(() => ensureSandboxScript('proj-x', 'x', 'img', '', [{ source: '/srv/../etc', target: '/data', mode: 'ro' }], false));
});

test('ensureSandboxScript — default (no options) is byte-identical to the historical dind script', () => {
  const a = ensureSandboxScript('proj-caldora', 'caldora', 'img', '--privileged');
  const b = ensureSandboxScript('proj-caldora', 'caldora', 'img', '--privileged', [], true);
  assert.equal(a, b);
  assert.ok(a.includes(`docker run -d --init --name 'proj-caldora' --privileged --restart unless-stopped`));
});

test('parseContainerStates — docker states map onto started/stopped', () => {
  const out = 'proj-caldora\trunning\nproj-bluefin-infra\texited\n\nproj-art\tcreated\n';
  const states = parseContainerStates(out);
  assert.equal(states.get('proj-caldora'), 'started');
  assert.equal(states.get('proj-bluefin-infra'), 'stopped');
  assert.equal(states.get('proj-art'), 'stopped');
  assert.equal(states.size, 3);
});

test('parseContainerStates — empty/garbage input yields an empty map', () => {
  assert.equal(parseContainerStates('').size, 0);
  assert.equal(parseContainerStates('no-tabs-here\n').size, 0);
});
