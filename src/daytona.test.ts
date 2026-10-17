import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Config } from './config.js';
import { DaytonaDriver } from './daytona.js';

// The organization's listing holds every sandbox, the installations' project sandboxes included —
// so the delete guard must fire before any API call (the URL below resolves nowhere).
test('DaytonaDriver.deleteSandbox — refuses a project sandbox before any API call', async () => {
  const cfg = { daytona: { apiUrl: 'https://daytona.invalid/api', apiKey: 'k', organizationId: 'o' }, sandbox: { namePrefix: 'proj-' } } as unknown as Config;
  const driver = new DaytonaDriver(cfg);
  await assert.rejects(driver.deleteSandbox('proj-caldora'), /refusing to delete sandbox "proj-caldora"/);
  await assert.rejects(driver.deleteSandbox('dev-proj-caldora'), /refusing to delete sandbox/);
});
