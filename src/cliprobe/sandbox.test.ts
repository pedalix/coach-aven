import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeLaunch } from '../claudeSession.js';
import { CLI_PATH_ENV } from '../cliversion.js';
import type { ExecOpts, SandboxDriver, SandboxHandle } from '../driver.js';
import { SshDockerDriver } from '../sshdocker.js';
import { driverFromEnv, SANDBOX_WORK_DIR, sandboxTransport } from './sandbox.js';

// A fake driver whose listing also holds an installation's project sandboxes.
function fakeDriver(o: { upgradeTo?: string; states?: Record<string, string> } = {}) {
  const calls: string[] = [];
  const uploads: Record<string, string> = {};
  let onStdout: ((c: string) => void) | undefined;
  let endStream: (() => void) | undefined;
  const handle: SandboxHandle = {
    name: 'cli-probe-r1',
    started: true,
    exec: async (command: string, _o?: ExecOpts) => {
      calls.push(`exec ${command.slice(0, 40)}`);
      if (command.includes('cli:upgrade')) return { exitCode: 0, result: `cli:from=2.1.260\ncli:upgrade=installed\ncli:version=${o.upgradeTo ?? '2.1.282'}\n` };
      return { exitCode: 0, result: '' };
    },
    uploadFile: async (data: Buffer, path: string) => void (uploads[path] = data.toString()),
    createSession: async (k: string) => void calls.push(`createSession ${k}`),
    startSessionCommand: async (k: string, command: string) => (calls.push(`start ${k} ${command}`), { cmdId: 'cmd-1' }),
    sessionCommandRunning: async () => true,
    sessionCommandLogs: async () => '',
    streamSessionCommandLogs: (_k: string, _c: string, cb: (c: string) => void) => {
      onStdout = cb;
      return new Promise<void>((r) => (endStream = r));
    },
    sendSessionInput: async (_k: string, _c: string, line: string) => void calls.push(`input ${line.trim()}`),
    deleteSession: async (k: string) => {
      calls.push(`deleteSession ${k}`);
      endStream?.();
    },
  };
  const driver: SandboxDriver = {
    ensureImage: async () => {},
    ensureSandbox: async (name: string, slug: string, opts?: unknown) => (calls.push(`ensure ${name} ${slug} ${JSON.stringify(opts)}`), handle),
    getSandbox: async () => handle,
    listStates: async () => new Map(Object.entries(o.states ?? { 'proj-caldora': 'started', 'dev-proj-bluefin': 'started', 'cli-probe-old': 'stopped' })),
    deleteSandbox: async (name: string) => void calls.push(`delete ${name}`),
  };
  return { driver, calls, uploads, emit: (s: string) => onStdout?.(s) };
}

test('sandboxTransport — leftover from a crashed run: only the cli-probe- sandbox is deleted, project sandboxes untouched', async () => {
  const { driver, calls } = fakeDriver();
  await sandboxTransport({ driver, runId: 'r1', version: '2.1.282', token: 't' });
  const deletes = calls.filter((c) => c.startsWith('delete '));
  assert.deepEqual(deletes, ['delete cli-probe-old']);
});

test('sandboxTransport — run in a sandbox: own name, token file, upgrade to the version, the bot’s command with CLI_PATH_ENV, stdin through the driver', async () => {
  const { driver, calls, uploads, emit } = fakeDriver();
  const t = await sandboxTransport({ driver, runId: 'r1', version: '2.1.282', token: 'probe-token' });
  assert.ok(calls.includes(`ensure cli-probe-r1 cli-probe {"privileged":false,"dind":false}`));
  assert.equal(uploads['/root/.cc-token'], 'probe-token');
  assert.ok(calls.some((c) => c.startsWith('exec cur=')), 'the bot’s upgrade step ran');
  const lines: string[] = [];
  const exits: (string | null)[] = [];
  const launch = claudeLaunch({ model: 'claude-haiku-5-5' });
  const proc = await t.start(launch, { onLine: (l) => lines.push(l), onExit: (_c, s) => exits.push(s) });
  const started = calls.find((c) => c.startsWith('start probe-1 '))!;
  assert.equal(started, `start probe-1 ${launch.command(SANDBOX_WORK_DIR)}`);
  assert.ok(started.includes(CLI_PATH_ENV));
  await proc.write('{"type":"user"}\n');
  assert.ok(calls.includes('input {"type":"user"}'));
  emit('{"type":"system","subtype":"init"}\n{"type":"res');
  emit('ult"}\n');
  assert.deepEqual(lines, ['{"type":"system","subtype":"init"}', '{"type":"result"}']);
  proc.kill('SIGKILL');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(exits, ['SIGKILL']);
  await t.dispose();
  assert.equal(calls.at(-1), 'delete cli-probe-r1');
});

test('sandboxTransport — the run fails midway: a wrong version after the upgrade deletes the sandbox and says why', async () => {
  const { driver, calls } = fakeDriver({ upgradeTo: '2.1.260', states: {} });
  await assert.rejects(sandboxTransport({ driver, runId: 'r1', version: '2.1.282', token: 't' }), /runs Claude Code 2\.1\.260 after the upgrade step, not 2\.1\.282/);
  assert.equal(calls.at(-1), 'delete cli-probe-r1');
});

// The probe's own environment picks the driver (OpenSpec retire-daytona-driver D3): SANDBOX_DRIVER stays
// required there, and only ssh-docker is accepted — a leftover `daytona` stops the run with the removal and
// the fix (set the value: dropping it is refused too), before a driver (let alone a sandbox) exists.
const PROBE_ENV = { SNAPSHOT_IMAGE: 'registry.example/sandbox-plain:1', SSHDOCKER_HOST: 'sandboxes.example' };

test('driverFromEnv — ssh-docker: the bot’s driver, labelled for the report', () => {
  const d = driverFromEnv({ ...PROBE_ENV, SANDBOX_DRIVER: 'ssh-docker' });
  assert.ok(d.driver instanceof SshDockerDriver);
  assert.equal(d.label, 'sandbox (ssh-docker)');
});

test('driverFromEnv — daytona is refused with the removal and the fix; a missing or unknown SANDBOX_DRIVER names ssh-docker', () => {
  assert.throws(
    () => driverFromEnv({ ...PROBE_ENV, SANDBOX_DRIVER: 'daytona' }),
    (e: Error) =>
      /^SANDBOX_DRIVER is "daytona", but the Daytona sandbox driver was removed and "ssh-docker" is the only driver — set SANDBOX_DRIVER=ssh-docker, /.test(e.message) &&
      /keep running the last release that has the Daytona driver/.test(e.message),
  );
  assert.throws(() => driverFromEnv(PROBE_ENV), /needs SANDBOX_DRIVER=ssh-docker in the probe’s environment/);
  assert.throws(() => driverFromEnv({ ...PROBE_ENV, SANDBOX_DRIVER: 'kubernetes' }), /SANDBOX_DRIVER must be "ssh-docker", the only sandbox driver; got "kubernetes"/);
});
