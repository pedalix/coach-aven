// The words an operator reads when a setting still names the removed Daytona driver (OpenSpec
// retire-daytona-driver D3–D5), pinned verbatim: they are the deprecation notice, at boot, at
// `/aven reload`, in `orch sources` and in the CLI probe. config.test.ts and projects.test.ts pin
// where each one is raised.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daytonaDefaultRefusal, driverRefusal, retiredDaytonaWarning } from './driverkind.js';

test('driverRefusal — daytona: removed, the one driver left, and both ways out; anything else: the accepted value', () => {
  assert.equal(
    driverRefusal('SANDBOX_DRIVER', 'daytona'),
    'SANDBOX_DRIVER is "daytona", but the Daytona sandbox driver was removed and "ssh-docker" is the only driver — to move the project, change that setting to "ssh-docker" or drop it (docs/sandbox-drivers.md → Moving a project to ssh-docker), or keep running the last release that has the Daytona driver',
  );
  assert.equal(driverRefusal('project "acme-shop" driver', 'ssh-dokcer'), 'project "acme-shop" driver must be "ssh-docker", the only sandbox driver; got "ssh-dokcer"');
  assert.equal(driverRefusal('project "acme-shop" driver', null), 'project "acme-shop" driver must be "ssh-docker", the only sandbox driver; got null');
});

test('daytonaDefaultRefusal — one project, or every one at once (the usual fix covers them all)', () => {
  assert.equal(
    daytonaDefaultRefusal(['acme-shop'], 'SANDBOX_DRIVER'),
    'project "acme-shop" has no "driver", and SANDBOX_DRIVER=daytona made Daytona this installation\'s default, but the Daytona sandbox driver was removed and "ssh-docker" is the only driver — to move it, give it "driver": "ssh-docker" or set SANDBOX_DRIVER=ssh-docker (docs/sandbox-drivers.md → Moving a project to ssh-docker), or keep running the last release that has the Daytona driver',
  );
  assert.match(
    daytonaDefaultRefusal(['acme-shop', 'acme-cms', 'acme-monitoring'], 'DAYTONA_API_URL'),
    /^projects "acme-shop", "acme-cms" and "acme-monitoring" have no "driver", and DAYTONA_API_URL without SANDBOX_DRIVER made Daytona this installation's default, .* — to move them, give each "driver": "ssh-docker" or set SANDBOX_DRIVER=ssh-docker /,
  );
});

test('retiredDaytonaWarning — nothing set, nothing said', () => {
  assert.equal(retiredDaytonaWarning({}), undefined);
  assert.equal(retiredDaytonaWarning({ SANDBOX_DRIVER: 'ssh-docker', SANDBOX_AUTOSTOP_MINUTES: '30', SNAPSHOT_IMAGE: 'img' }), undefined);
});
