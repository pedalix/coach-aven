// The provider switch after the Daytona driver's removal (OpenSpec retire-daytona-driver D2/D6):
// whatever a project or SANDBOX_DRIVER says — and both may say nothing — the sandbox is ssh-docker's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Config } from './config.js';
import { createDriver } from './driver.js';
import { SshDockerDriver } from './sshdocker.js';

const cfg = {
  sandboxDriver: 'ssh-docker',
  sshDocker: { host: 'sandboxes.example', runtime: 'privileged' },
  snapshot: { image: 'registry.example/sandbox:1' },
  sandbox: { autoStopMinutes: 30, workDir: '/root/work', namePrefix: 'proj-' },
} as unknown as Config;

test('createDriver — with or without a kind, the driver is ssh-docker', () => {
  assert.ok(createDriver(cfg) instanceof SshDockerDriver, 'no project driver: the installation default');
  assert.ok(createDriver(cfg, 'ssh-docker') instanceof SshDockerDriver, 'a project that names ssh-docker');
});

test('createDriver — nothing names a driver and SSHDOCKER_HOST is missing: the first sandbox use fails naming it', () => {
  assert.throws(() => createDriver({ ...cfg, sshDocker: undefined }), /SSHDOCKER_HOST is not set/);
});
