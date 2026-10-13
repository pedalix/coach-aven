import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sq, safeToken, execScript, startSessionScript, streamSessionScript, runningProbeScript, parseContainerStates, ensureSandboxScript, transportArgv, LOCAL_HOST } from './sshdocker.js';

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
  // No daemon restart policy: the daemon would start the container before the host fs
  // is exported (Docker Desktop/WSL) and bind mounts come up empty. The orchestrator
  // wakes stopped containers itself; old ones are migrated in place.
  assert.equal(s.includes('--restart unless-stopped'), false);
  assert.ok(s.includes(`docker update --restart=no 'proj-caldora' >/dev/null 2>&1 || true`));
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
    `  docker run -d --init --name 'proj-owen-ops' -v '/srv/owen-ops/sources:/data/sources:ro' \\`,
  );
  assert.equal(s.includes('--privileged'), false);
  assert.equal(s.includes('--runtime'), false);
  // No dockerd in there → the sysbox exec-probe/recycle block is pointless and skipped.
  // (The mount probe below can still revive it — that one is per mount, not per runtime.)
  assert.equal(s.includes('exec probe failed'), false);
  assert.equal(s.includes('docker exec \'proj-owen-ops\' true'), false);
  assert.ok(s.trim().endsWith('echo "$outcome"'));
  // Mount paths are re-validated at the shell boundary even though sandboxopts checked them.
  assert.throws(() => ensureSandboxScript('proj-x', 'x', 'img', '', [{ source: '/srv/a b', target: '/data', mode: 'ro' }], false));
  assert.throws(() => ensureSandboxScript('proj-x', 'x', 'img', '', [{ source: '/srv/../etc', target: '/data', mode: 'ro' }], false));
});

test('ensureSandboxScript — default (no options) is byte-identical to the historical dind script', () => {
  const a = ensureSandboxScript('proj-caldora', 'caldora', 'img', '--privileged');
  const b = ensureSandboxScript('proj-caldora', 'caldora', 'img', '--privileged', [], true);
  assert.equal(a, b);
  assert.ok(a.includes(`docker run -d --init --name 'proj-caldora' --privileged \\`));
  assert.equal(a.includes('ls -A'), false); // no mounts → no mount probe
});

test('ensureSandboxScript — a bind mount that came up empty is recycled, not served', () => {
  const s = ensureSandboxScript(
    'proj-owen-ops',
    'owen-ops',
    'img',
    '',
    [{ source: '/srv/owen-ops/replica', target: '/data/sources', mode: 'ro' }],
    false,
  );
  // Host side has content, container side doesn't → the mount attached before the host
  // fs was exported to the engine (Docker Desktop/WSL after a daemon restart).
  assert.ok(s.includes(`if [ -n "$(ls -A '/srv/owen-ops/replica' 2>/dev/null)" ] && [ -z "$(docker exec 'proj-owen-ops' ls -A '/data/sources' 2>/dev/null)" ]; then`));
  assert.ok(s.includes(`docker stop -t 10 'proj-owen-ops'`));
  assert.ok(s.includes(`docker start 'proj-owen-ops' >/dev/null 2>&1`));
  assert.ok(s.includes('outcome=revived'));
  // Still empty after the recycle → a FAILED ensure (the turn fails and says why on stderr), not a
  // note: a run against a missing replica reports empty data as fact (2026-10-13).
  assert.ok(s.includes(`echo "mount /data/sources still empty after recycle" >&2; exit 1; fi`));
  assert.equal(s.split('exit 1').length - 1, 3); // the wake and create failures, and the dead mount
  // The sysbox exec dance stays off for a plain project even with the mount probe on.
  assert.equal(s.includes('exec probe failed'), false);
  assert.ok(s.trim().endsWith('echo "$outcome"'));
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

test('transportArgv — a real host goes over ssh in BatchMode with the remote command verbatim', () => {
  const t = transportArgv('aven-sbx', "docker exec -i 'proj-x' sh -s");
  assert.equal(t.cmd, 'ssh');
  assert.deepEqual(t.args, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'aven-sbx', "docker exec -i 'proj-x' sh -s"]);
});

test('transportArgv — the literal `local` host runs the same command through sh -c, no ssh', () => {
  const cmd = "docker exec -i 'proj-x' sh -s";
  const t = transportArgv(LOCAL_HOST, cmd);
  assert.equal(t.cmd, 'sh');
  assert.deepEqual(t.args, ['-c', cmd]);
  // Only the exact literal switches transport — `localhost` is still an ssh target.
  assert.equal(transportArgv('localhost', cmd).cmd, 'ssh');
});
