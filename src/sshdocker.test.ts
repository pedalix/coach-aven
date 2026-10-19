import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sq, safeToken, execScript, startSessionScript, streamSessionScript, runningProbeScript, parseContainerStates, ensureSandboxScript, transportArgv, LOCAL_HOST, deleteSandboxScript, SshDockerDriver, bootScript, stopSandboxScript, runSsh, type SshRun, type SshRunOpts } from './sshdocker.js';
import type { Config } from './config.js';
import { sandboxActivity } from './idlestop.js';

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

test('runningProbeScript — zombie counts as down, the pid must hold this session\'s FIFO, ids are validated', () => {
  const s = runningProbeScript('claude-sess-1-2', '12345');
  assert.ok(s.includes(`kill -0 '12345'`));
  assert.ok(s.includes(`grep -q '^State:.*Z'`)); // zombies pass kill -0 — must be excluded
  // Identity, not just liveness: pids restart from 1 with every container start, so a reattach
  // record from before a boot can name a pid some other process holds now.
  assert.ok(s.startsWith(`f=$(readlink /proc/'12345'/fd/0 2>/dev/null)\n`));
  assert.ok(s.includes(`[ "$f" = '/tmp/aven-sess/claude-sess-1-2/in' ]`));
  // An unreadable link (no readlink, a runtime that hides it) is not proof of death: the session's
  // own pid file decides, as before — never a second claude on a live conversation.
  assert.ok(s.includes(`{ [ -z "$f" ] && [ "$(cat '/tmp/aven-sess/claude-sess-1-2/pid' 2>/dev/null)" = '12345' ]; }`));
  assert.ok(s.includes('echo up') && s.includes('echo down'));
  assert.throws(() => runningProbeScript('claude-sess-1-2', '1; reboot')); // cmdId round-trips via state.json
  assert.throws(() => runningProbeScript('../x', '12345'));
});

test('ensureSandboxScript — reuses, wakes, or creates; --init and labels survive', () => {
  const s = ensureSandboxScript('proj-caldora', 'caldora', 'ghcr.io/x/dind:pilot', '--runtime sysbox-runc');
  assert.ok(s.includes(`docker inspect -f '{{.State.Running}}' 'proj-caldora'`));
  assert.ok(s.includes('outcome=ready'));
  // A failed start is tried once more after two seconds: with the idle stop, starts are routine.
  assert.ok(s.includes(`docker start 'proj-caldora' >/dev/null || { sleep 2; docker start 'proj-caldora' >/dev/null; } || exit 1; outcome=started`));
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

test('deleteSandboxScript — removes the container and proves it is gone; the name is validated', () => {
  assert.equal(
    deleteSandboxScript('cli-probe-r1'),
    `docker rm -f 'cli-probe-r1' >/dev/null 2>&1; if docker inspect 'cli-probe-r1' >/dev/null 2>&1; then echo still-there; else echo gone; fi`,
  );
  assert.throws(() => deleteSandboxScript('x; docker rm -f proj-caldora'));
});

test('SshDockerDriver.deleteSandbox — refuses a project sandbox before touching the host', async () => {
  const cfg = { sshDocker: { host: 'ssh-unreachable.example', runtime: 'privileged' }, snapshot: { image: 'img' }, sandbox: { namePrefix: 'proj-' } } as unknown as Config;
  const driver = new SshDockerDriver(cfg);
  await assert.rejects(driver.deleteSandbox('proj-caldora'), /refusing to delete sandbox "proj-caldora"/);
  await assert.rejects(driver.deleteSandbox('caldora'), /refusing to delete sandbox/);
});


// ── the idle stop (OpenSpec sandbox-idle-stop) ─────────────────────────────

test('ensureSandboxScript — the boot step runs after the probes, on stderr, before the outcome line', () => {
  const s = ensureSandboxScript('proj-caldora', 'caldora', 'img', '--privileged');
  const lines = s.split('\n');
  const step = lines.findIndex((l) => l.startsWith('docker exec -e AVEN_BOOT="$boot" -e AVEN_OUTCOME="$outcome" '));
  assert.ok(step > lines.findIndex((l) => l.includes('outcome=revived')), 'after the exec probe and its recycle');
  assert.equal(lines[step - 1], `boot=$(docker inspect -f '{{.State.StartedAt}}' 'proj-caldora' 2>/dev/null)`);
  assert.ok(lines.slice(step).join('\n').endsWith(`>&2 || true\necho "$outcome"`), 'best effort, never on stdout');
  assert.ok(s.includes('hk:dockerd='), 'a dind project brings dockerd back on a new boot');
  const plain = ensureSandboxScript('proj-owen-ops', 'owen-ops', 'img', '', [{ source: '/srv/a', target: '/data', mode: 'ro' }], false);
  assert.ok(plain.includes('aven:fresh-boot') && !plain.includes('hk:dockerd='), 'a plain project gets the cleanup, no guard');
  assert.ok(plain.indexOf('AVEN_BOOT') > plain.indexOf('still empty after recycle'), 'after the mount probe too');
});

test('bootScript — a new boot is a changed marker (or first sight of a start); only provably dead sessions go; the dind guard also after an unfinished stop', () => {
  const s = bootScript(true);
  const lines = s.split('\n');
  assert.equal(lines[0], 'd=/tmp/aven-sess');
  assert.ok(s.includes('if [ -n "$AVEN_BOOT" ] && [ "$seen" != "$AVEN_BOOT" ]; then'), 'no boot time, or the same boot → not new');
  // First sight of a RUNNING container (no marker, `ready`): marker only — its live sessions are not touched.
  assert.ok(s.includes('  if [ -n "$seen" ] || [ "$AVEN_OUTCOME" != ready ]; then new=1; fi'));
  // Never the whole directory: each session directory goes unless its pid is alive and reads its FIFO.
  assert.equal(s.includes('rm -rf "$d"'), false);
  assert.ok(s.includes(`= "$s/in" ] && continue\n    [ -d "$s" ] && rm -rf "$s"`));
  const guard = lines.indexOf('if [ -n "$new" ] || [ -e "$d/.dockerd-stopped" ]; then');
  assert.ok(guard > lines.indexOf('  echo aven:fresh-boot'), 'the guard after the cleanup');
  assert.equal(lines[guard + 1], '  rm -f "$d/.dockerd-stopped"');
  assert.ok(lines[guard + 2]!.includes('hk:dockerd='));
  assert.equal(bootScript(false).includes('dockerd'), false, 'a plain project has no dockerd to bring back');
});

// The in-container scripts, run for real by the local sh (Linux: /proc), with a temp directory in place of
// /tmp/aven-sess: a session started by the driver's own script, the probe, and the boot step around it.
test('session scripts for real — the probe proves identity; a new boot removes only sessions that are provably gone', { skip: process.platform !== 'linux' }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aven-sess-'));
  const at = (script: string) => script.replaceAll('/tmp/aven-sess', root);
  const sh = (script: string, env: Record<string, string> = {}) =>
    execFileSync('sh', ['-c', at(script)], { env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const pid = sh(startSessionScript('claude-sess-t-1', 'exec sleep 30')).trim();
  const holder = existsSync(join(root, 'claude-sess-t-1', 'holder')) ? readFileSync(join(root, 'claude-sess-t-1', 'holder'), 'utf8').trim() : '';
  t.after(() => {
    for (const p of [pid, holder]) if (/^\d+$/.test(p)) spawnSync('kill', [p]);
    rmSync(root, { recursive: true, force: true });
  });
  assert.match(pid, /^\d+$/);
  assert.match(holder, /^\d+$/);
  for (let i = 0; i < 100; i++) {
    try {
      if (readlinkSync(`/proc/${pid}/fd/0`) === join(root, 'claude-sess-t-1', 'in')) break;
    } catch {
      /* not open yet */
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  const probe = (key: string, p: string) => sh(runningProbeScript(key, p)).trim();
  assert.equal(probe('claude-sess-t-1', pid), 'up');
  assert.equal(probe('claude-sess-t-2', pid), 'down', 'alive, but another session\'s process');
  assert.equal(probe('claude-sess-t-1', holder), 'down', 'a pid some other process holds now (a reused pid after a restart)');
  assert.equal(probe('claude-sess-t-1', '4194305'), 'down', 'above any pid_max: never alive');

  const dir = (key: string, p: string) => {
    mkdirSync(join(root, key), { recursive: true });
    writeFileSync(join(root, key, 'pid'), p);
  };
  const boot = (b: string, outcome: string) => sh(bootScript(false), { AVEN_BOOT: b, AVEN_OUTCOME: outcome }).trim();
  const left = () => readdirSync(root).sort();
  const marker = () => readFileSync(join(root, '.boot'), 'utf8');
  // First sight of a running container (no marker, `ready`): the marker only, nothing removed.
  dir('claude-sess-dead', '4194305');
  assert.equal(boot('B0', 'ready'), '');
  assert.deepEqual(left(), ['.boot', 'claude-sess-dead', 'claude-sess-t-1']);
  assert.equal(marker(), 'B0');
  assert.equal(boot('B0', 'ready'), '', 'the same boot: nothing');
  assert.equal(boot('', 'started'), '', 'no boot time: nothing');
  assert.deepEqual(left(), ['.boot', 'claude-sess-dead', 'claude-sess-t-1']);
  // A new boot whose first warm-up could not write the marker, then a session opened in it: the next
  // warm-up sees a marker from the earlier boot — dead and reused pids go, the live session stays.
  dir('claude-sess-reused', holder);
  assert.equal(boot('B1', 'ready'), 'aven:fresh-boot');
  assert.deepEqual(left(), ['.boot', 'claude-sess-t-1']);
  assert.equal(marker(), 'B1');
  assert.equal(probe('claude-sess-t-1', pid), 'up');
  // A start the bot made (`started`) with no marker at all is a new boot as well.
  rmSync(join(root, '.boot'));
  dir('claude-sess-dead', '4194305');
  assert.equal(boot('B2', 'started'), 'aven:fresh-boot');
  assert.deepEqual(left(), ['.boot', 'claude-sess-t-1']);
  assert.ok(existsSync(join(root, 'claude-sess-t-1', 'in')));
});

test('runSsh — local mode: a timeout ends the whole call, the processes its script started included', { skip: process.platform !== 'linux' }, async () => {
  const t0 = Date.now();
  const r = await runSsh(LOCAL_HOST, 'sh -s', { stdin: 'sleep 5\necho finished\n', timeoutMs: 300 });
  assert.ok(Date.now() - t0 < 3000, `returned after ${Date.now() - t0} ms`);
  assert.equal(r.stdout.includes('finished'), false);
  assert.notEqual(r.code, 0);
  assert.equal((await runSsh(LOCAL_HOST, 'sh -s', { stdin: 'echo hi\n' })).stdout, 'hi\n', 'a call without a timeout as before');
});

test('stopSandboxScript — by name, labels proven in the same call, the inner dockerd first on dind, then docker stop', () => {
  const s = stopSandboxScript('proj-caldora', 'caldora', 'coach-aven', true);
  assert.ok(s.startsWith(`info=$(docker inspect -f '{{.State.Running}}|{{index .Config.Labels "managedBy"}}|{{index .Config.Labels "project"}}' 'proj-caldora' 2>/dev/null) || { docker version >/dev/null 2>&1 || exit 1; echo missing; exit 0; }`));
  assert.ok(s.includes(`if [ "$mb" != 'coach-aven' ] || [ "$pj" != 'caldora' ]; then echo "foreign managedBy=$mb, project=$pj"; exit 0; fi`));
  assert.ok(s.includes('[ "$running" = true ] || { echo not-running; exit 0; }'));
  const lines = s.split('\n');
  const inner = lines.findIndex((l) => l.startsWith(`docker exec 'proj-caldora' sh -c `));
  const stop = lines.indexOf(`docker stop -t 10 'proj-caldora' >/dev/null || exit 1`);
  assert.ok(inner > lines.findIndex((l) => l.includes('not-running')) && stop > inner, 'labels → running → inner dockerd → stop');
  assert.ok(lines[inner]!.includes('kill -TERM') && lines[inner]!.includes('/var/run/docker.pid') && lines[inner]!.includes('-lt 30'));
  // The mark for the boot step comes before the signal: a stop that ends here still gets dockerd back.
  assert.ok(lines[inner]!.indexOf(': > /tmp/aven-sess/.dockerd-stopped') < lines[inner]!.indexOf('kill -TERM'));
  assert.equal(lines.at(-1), 'echo stopped');
  assert.equal(stopSandboxScript('proj-owen-ops', 'owen-ops', 'coach-aven', false).includes('docker.pid'), false, 'no inner dockerd on a plain project');
  assert.ok(stopSandboxScript('proj-x', 'x', `it's`, false).includes(`[ "$mb" != 'it'\\''s' ]`), 'the label value is quoted');
  assert.throws(() => stopSandboxScript('x; docker rm -f proj-y', 'x', 'coach-aven', false));
  assert.throws(() => stopSandboxScript('proj-x', 'x y', 'coach-aven', false));
});

// A fake sandbox host: answers the driver's host scripts and in-container calls by what they contain.
function fakeHost(answer: (remoteCmd: string, script: string, opts: SshRunOpts) => Promise<{ code?: number; stdout?: string; stderr?: string }> | { code?: number; stdout?: string; stderr?: string }) {
  const seen: { cmd: string; script: string }[] = [];
  const run: SshRun = async (_host, remoteCmd, opts = {}) => {
    const script = typeof opts.stdin === 'string' ? opts.stdin : opts.stdin ? opts.stdin.toString('utf8') : '';
    seen.push({ cmd: remoteCmd, script });
    const r = await answer(remoteCmd, script, opts);
    return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const cfg = { sshDocker: { host: 'sandboxes.example', runtime: 'privileged' }, snapshot: { image: 'img' }, sandbox: { namePrefix: 'proj-' } } as unknown as Config;
  return { seen, driver: new SshDockerDriver(cfg, run) };
}
const isEnsure = (s: string) => s.includes('outcome=ready');
const isStop = (s: string) => s.includes('echo stopped');
const isPeek = (s: string) => s.includes(`|| echo missing`) && !isStop(s);

test('SshDockerDriver — every handle call is activity: in flight while it runs; a stream counts by its chunks, never in flight', async () => {
  let release!: () => void;
  let chunk!: (c: string) => void;
  let endStream!: () => void;
  const { driver } = fakeHost(async (cmd, script, opts) => {
    if (isEnsure(script)) return { stdout: 'ready\n' };
    if (script.includes('sleep 5')) await new Promise<void>((r) => (release = r));
    if (script.includes('tail -c +1 -f')) {
      chunk = opts.onStdout!;
      await new Promise<void>((r) => (endStream = r));
    }
    return { stdout: 'ok' };
  });
  const h = await driver.ensureSandbox('proj-track', 'track');
  const before = sandboxActivity.view('proj-track').lastActivity;
  const exec = h.exec('sleep 5');
  assert.equal(sandboxActivity.view('proj-track').inFlight, 1);
  release();
  await exec;
  assert.equal(sandboxActivity.view('proj-track').inFlight, 0);
  assert.ok(sandboxActivity.view('proj-track').lastActivity >= before);
  const stream = h.streamSessionCommandLogs('claude-sess-1-1', '42', () => {});
  await new Promise((r) => setImmediate(r));
  assert.equal(sandboxActivity.view('proj-track').inFlight, 0, 'an open stream is not a call in flight');
  const t = sandboxActivity.view('proj-track').lastActivity;
  await new Promise((r) => setTimeout(r, 5));
  chunk('{"type":"assistant"}\n');
  assert.ok(sandboxActivity.view('proj-track').lastActivity > t, 'a chunk is activity');
  endStream();
  await stream;
  await h.uploadFile(Buffer.from('x'), '/root/a');
  assert.equal(sandboxActivity.view('proj-track').inFlight, 0);
});

test('SshDockerDriver — a peek records nothing; a failing warm-up still clears the parked mark', async () => {
  const { driver } = fakeHost((_cmd, script) => (isPeek(script) ? { stdout: 'false\n' } : { code: 1, stdout: '', stderr: 'Error response from daemon: cannot start' }));
  sandboxActivity.park('proj-peek');
  const before = sandboxActivity.view('proj-peek');
  const h = await driver.getSandbox('proj-peek');
  assert.equal(h?.started, false);
  assert.deepEqual(sandboxActivity.view('proj-peek'), before, 'getSandbox is host-level: no touch, mark kept');
  await assert.rejects(driver.ensureSandbox('proj-peek', 'peek'), /ensureSandbox proj-peek failed \(exit 1\)/);
  assert.equal(sandboxActivity.view('proj-peek').parked, false, 'any attempt may have started the container');
});

test('SshDockerDriver.stopSandbox — the re-check comes first; a stop ends the sessions before the mark and before a queued warm-up runs', async () => {
  const order: string[] = [];
  let releaseStop!: () => void;
  const { driver, seen } = fakeHost(async (_cmd, script) => {
    if (isStop(script)) {
      order.push('stop-script');
      await new Promise<void>((r) => (releaseStop = r));
      return { stdout: 'stopped\n' };
    }
    if (isEnsure(script)) {
      order.push(`ensure-script parked=${sandboxActivity.view('proj-lock').parked}`);
      return { stdout: 'started\n', stderr: 'aven:fresh-boot\nhk:dockerd=restarted\n' };
    }
    if (isPeek(script)) {
      order.push('peek-script');
      return { stdout: 'false\n' };
    }
    return {};
  });
  // Work arrived since the sweep looked: no host call at all.
  assert.deepEqual(await driver.stopSandbox({ name: 'proj-lock', slug: 'lock', dind: true, recheck: () => false, onStopped: () => order.push('sessions') }), { kind: 'skipped' });
  assert.equal(seen.length, 0);
  const stop = driver.stopSandbox({
    name: 'proj-lock',
    slug: 'lock',
    dind: true,
    recheck: () => true,
    onStopped: () => order.push(`sessions parked=${sandboxActivity.view('proj-lock').parked}`),
  });
  await new Promise((r) => setImmediate(r));
  const peek = driver.getSandbox('proj-lock'); // housekeeping or /aven memory during the stop
  const wake = driver.ensureSandbox('proj-lock', 'lock'); // a turn during the stop
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, ['stop-script'], 'the peek and the warm-up wait for the stop');
  releaseStop();
  const out = await stop;
  assert.equal(out.kind, 'stopped');
  assert.equal((await peek)?.started, false, 'the peek reports the state after the stop');
  await wake;
  assert.deepEqual(order, ['stop-script', 'sessions parked=false', 'peek-script', 'ensure-script parked=false']);
  assert.ok(seen.find((x) => isStop(x.script))!.script.includes(`'coach-aven'`), 'the label value is this installation\'s SANDBOX_MANAGED_BY');
});

test('SshDockerDriver.stopSandbox — not ours, not running or missing: parked, nothing ended; a failing host throws with docker\'s words', async () => {
  for (const [stdout, kind] of [['foreign managedBy=someone-else, project=x\n', 'foreign'], ['not-running\n', 'not-running'], ['missing\n', 'missing']] as const) {
    const name = `proj-out-${kind}`;
    const { driver } = fakeHost(() => ({ stdout }));
    let ended = false;
    const out = await driver.stopSandbox({ name, slug: 'x', dind: false, recheck: () => true, onStopped: () => (ended = true) });
    assert.equal(out.kind, kind);
    if (out.kind === 'foreign') assert.equal(out.labels, 'managedBy=someone-else, project=x');
    assert.equal(ended, false);
    assert.equal(sandboxActivity.view(name).parked, true);
  }
  const { driver } = fakeHost(() => ({ code: 255, stderr: 'ssh: connect to host sandboxes.example port 22: Connection refused' }));
  await assert.rejects(
    driver.stopSandbox({ name: 'proj-out-down', slug: 'x', dind: false, recheck: () => true, onStopped: () => {} }),
    /stopSandbox proj-out-down failed \(exit 255\)[\s\S]*Connection refused/,
  );
  assert.equal(sandboxActivity.view('proj-out-down').parked, false);
});

test('SshDockerDriver — two warm-ups of one container never run their scripts at the same time', async () => {
  let active = 0;
  let maxActive = 0;
  const { driver } = fakeHost(async (_cmd, script) => {
    if (!isEnsure(script)) return {};
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return { stdout: 'ready\n' };
  });
  await Promise.all([driver.ensureSandbox('proj-two', 'two'), driver.ensureSandbox('proj-two', 'two'), driver.ensureSandbox('proj-other', 'other')]);
  assert.equal(maxActive, 2, 'proj-two serialized; proj-other alongside');
});
