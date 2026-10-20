// How `orch` ends on each kind of error (cliExit, used by src/cli.ts's top-level catch). The ConfigError
// case is the boot refusal of OpenSpec retire-daytona-driver (D3/D4): the deploy's health check prints the
// journal's last twelve lines, so the refusal must be one line, and a refused unit restarts every few
// seconds, so it must never reach Sentry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cliExit, ConfigError, UsageError } from './errors.js';
import { daytonaDefaultRefusal, driverRefusal } from '../driverkind.js';

test('cliExit — a wrong invocation: the message alone, exit 2, not an incident', () => {
  assert.deepEqual(cliExit(new UsageError('usage: orch sources audit <slug>')), { text: 'usage: orch sources audit <slug>', code: 2, incident: false });
});

test('cliExit — a refused configuration: one line, exit 1, no stack, nothing to Sentry', () => {
  for (const msg of [
    `/srv/aven/projects.config.json: ${driverRefusal('project "acme-shop" driver', 'daytona')}`,
    `/srv/aven/projects.config.json: ${daytonaDefaultRefusal(['acme-shop', 'acme-cms'], 'DAYTONA_API_URL')}`,
    driverRefusal('SANDBOX_DRIVER', 'kubernetes'),
  ]) {
    const end = cliExit(new ConfigError(msg));
    assert.deepEqual(end, { text: msg, code: 1, incident: false });
    assert.equal(end.text.includes('\n'), false, 'one line');
  }
});

test('cliExit — anything else is an incident: its stack, exit 1, reported', () => {
  const err = new Error('socket hang up');
  assert.deepEqual(cliExit(err), { text: err.stack, code: 1, incident: true });
  assert.deepEqual(cliExit('plain string'), { text: 'plain string', code: 1, incident: true });
});
