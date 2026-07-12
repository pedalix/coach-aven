import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Installation, InstallationQuery } from '@slack/bolt';
import { Store } from './state.js';
import { createInstallationStore, installKey, queryKey } from './installations.js';

// A Store backed by a throwaway temp file (path injection keeps the real state.json safe).
function freshStore(): { store: Store; path: string } {
  const path = join(mkdtempSync(join(tmpdir(), 'aven-inst-')), 'state.json');
  return { store: new Store(path), path };
}

// A minimal-but-valid team installation, the shape oauth.v2.access produces.
const teamInstall = (teamId: string, botToken: string): Installation => ({
  team: { id: teamId, name: 'Acme' },
  enterprise: undefined,
  user: { token: undefined, scopes: undefined, id: 'U1' },
  bot: { token: botToken, scopes: ['chat:write'], id: 'B1', userId: 'UBOT' },
  isEnterpriseInstall: false,
});

const orgInstall = (entId: string): Installation => ({
  team: undefined,
  enterprise: { id: entId, name: 'AcmeOrg' },
  user: { token: undefined, scopes: undefined, id: 'U1' },
  bot: { token: 'xoxb-org', scopes: ['chat:write'], id: 'B2', userId: 'UBOT2' },
  isEnterpriseInstall: true,
});

const teamQuery = (teamId: string, enterpriseId?: string): InstallationQuery<boolean> => ({
  teamId,
  enterpriseId,
  isEnterpriseInstall: false,
});

test('key derivation — team installs key by team, org installs by enterprise', () => {
  assert.equal(installKey(teamInstall('T1', 'xoxb-1')), 'T1');
  assert.equal(installKey(orgInstall('E1')), 'E1');
  // A single-workspace install INSIDE an org still keys by team (isEnterpriseInstall=false).
  const inOrg = { ...teamInstall('T2', 'xoxb-2'), enterprise: { id: 'E1' } };
  assert.equal(installKey(inOrg), 'T2');
  assert.throws(() => installKey({ ...teamInstall('T1', 'x'), team: undefined } as never));

  assert.equal(queryKey(teamQuery('T1')), 'T1');
  assert.equal(queryKey(teamQuery('T2', 'E1')), 'T2'); // team query inside an org → team
  assert.equal(queryKey({ teamId: undefined, enterpriseId: 'E1', isEnterpriseInstall: true } as never), 'E1');
});

test('store/fetch round-trip persists across a Store reload', async () => {
  const { store, path } = freshStore();
  const inst = createInstallationStore(store);
  await inst.storeInstallation(teamInstall('T1', 'xoxb-team1'));
  await inst.storeInstallation(teamInstall('T2', 'xoxb-team2'));

  const fetched = await inst.fetchInstallation(teamQuery('T2'));
  assert.equal(fetched.bot?.token, 'xoxb-team2');

  // A fresh Store on the same file (= bot restart) still resolves both teams.
  const reloaded = createInstallationStore(new Store(path));
  assert.equal((await reloaded.fetchInstallation(teamQuery('T1'))).bot?.token, 'xoxb-team1');
});

test('fetch of an unknown team throws a descriptive error (not undefined)', async () => {
  const inst = createInstallationStore(freshStore().store);
  await assert.rejects(() => inst.fetchInstallation(teamQuery('T404')), /T404/);
});

test('delete removes the record; unknown delete is a no-op', async () => {
  const { store } = freshStore();
  const inst = createInstallationStore(store);
  await inst.storeInstallation(teamInstall('T1', 'xoxb-1'));
  await inst.deleteInstallation?.(teamQuery('T1'));
  await assert.rejects(() => inst.fetchInstallation(teamQuery('T1')));
  await inst.deleteInstallation?.(teamQuery('T1')); // already gone — must not throw
});

test('state.json is written owner-only (0600) — it now carries bot tokens', async () => {
  const { store, path } = freshStore();
  await createInstallationStore(store).storeInstallation(teamInstall('T1', 'xoxb-secret'));
  assert.equal(statSync(path).mode & 0o777, 0o600);
});
