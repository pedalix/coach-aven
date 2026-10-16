import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveAccess, mayDrive, isAdmin, deniedText, parseUsersCmd, applyUsersCmd, usersListText } from './access.js';

test('defaults — open everywhere; the installer seeds a client team’s admin', () => {
  const home = effectiveAccess(undefined, true, undefined);
  assert.equal(home.mode, 'open');
  assert.ok(mayDrive(home, 'U_ANYONE'));

  // Client teams are open too (deliberate: adding a workspace adds no process) — but
  // the installer is pre-seeded as admin so `restrict` stays reachable from their side.
  const client = effectiveAccess(undefined, false, 'U_INSTALLER');
  assert.equal(client.mode, 'open');
  assert.ok(mayDrive(client, 'U_STRANGER'));
  assert.ok(isAdmin(client, 'U_INSTALLER', false));
  assert.ok(!isAdmin(client, 'U_STRANGER', false));

  // The moment an admin flips to allowlist, non-listed users stop driving.
  const restricted = { ...client, mode: 'allowlist' as const };
  assert.ok(mayDrive(restricted, 'U_INSTALLER')); // seeded into users too
  assert.ok(!mayDrive(restricted, 'U_STRANGER'));
  assert.ok(!mayDrive(restricted, undefined)); // authorless event never drives an allowlisted team
});

test('explicit record overrides the default; admins always drive', () => {
  const rec = { mode: 'allowlist' as const, users: ['U_DEV'], admins: ['U_BOSS'] };
  assert.deepEqual(effectiveAccess(rec, true, undefined), rec); // even for home
  assert.ok(mayDrive(rec, 'U_DEV'));
  assert.ok(mayDrive(rec, 'U_BOSS')); // admin not in users still drives
  assert.ok(!mayDrive(rec, 'U_OTHER'));
});

test('home isAdmin — everyone in the home workspace manages', () => {
  const a = effectiveAccess(undefined, true, undefined);
  assert.ok(isAdmin(a, 'U_ANYONE', true));
});

test('parseUsersCmd — grammar incl. Slack mention escaping', () => {
  assert.deepEqual(parseUsersCmd(''), { action: 'list' });
  assert.deepEqual(parseUsersCmd('allow <@U0AAA111|jane.doe>'), { action: 'allow', userId: 'U0AAA111' });
  assert.deepEqual(parseUsersCmd('deny <@W0BBB222>'), { action: 'deny', userId: 'W0BBB222' });
  assert.deepEqual(parseUsersCmd('open'), { action: 'open' });
  assert.deepEqual(parseUsersCmd('restrict'), { action: 'restrict' });
  assert.equal(parseUsersCmd('allow jane').action, 'error'); // bare text isn't a mention
  assert.equal(parseUsersCmd('frobnicate').action, 'error');
});

test('parseUsersCmd — a Teams id in the same <@id> form', () => {
  assert.deepEqual(parseUsersCmd('allow <@29:1a2b-cD_3>'), { action: 'allow', userId: '29:1a2b-cD_3' });
  assert.equal(parseUsersCmd('deny @someone').action, 'error');
});

test('usersListText — the home admins label is the caller’s (operators on Teams)', () => {
  const a = { mode: 'open' as const, users: [], admins: [] };
  assert.match(usersListText(a, true), /everyone in the home workspace/);
  assert.match(usersListText(a, true, 'the installation’s operators'), /the installation’s operators/);
});

test('applyUsersCmd — allow is idempotent, deny strips admin, lockout is refused', () => {
  const base = { mode: 'allowlist' as const, users: ['U_A'], admins: ['U_A'] };
  const allowed = applyUsersCmd(base, { action: 'allow', userId: 'U_B' });
  assert.ok('next' in allowed && allowed.next.users.includes('U_B'));
  const again = applyUsersCmd((allowed as { next: typeof base }).next, { action: 'allow', userId: 'U_B' });
  assert.ok('next' in again && again.next.users.filter((u) => u === 'U_B').length === 1);

  // last-admin lockout refused
  const locked = applyUsersCmd(base, { action: 'deny', userId: 'U_A' });
  assert.ok('error' in locked);

  // deny a non-last admin removes both roles
  const two = { mode: 'allowlist' as const, users: ['U_A', 'U_B'], admins: ['U_A', 'U_B'] };
  const denied = applyUsersCmd(two, { action: 'deny', userId: 'U_B' });
  assert.ok('next' in denied && !denied.next.users.includes('U_B') && !denied.next.admins.includes('U_B'));

  const opened = applyUsersCmd(base, { action: 'open' });
  assert.ok('next' in opened && opened.next.mode === 'open');
});

test('deniedText and usersListText name the admins', () => {
  const a = { mode: 'allowlist' as const, users: [], admins: ['U_BOSS'] };
  assert.ok(deniedText(a).includes('<@U_BOSS>'));
  assert.ok(deniedText({ ...a, admins: [] }).includes('workspace admin'));
  const listing = usersListText(a, false);
  assert.ok(listing.includes('allowlist') && listing.includes('<@U_BOSS>') && listing.includes('_nobody yet_'));
});
