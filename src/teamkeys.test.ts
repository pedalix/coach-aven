import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tenantOf, withTeam, splitTeam, isThreadKey, threadRoot, slugOfBase } from './teamkeys.js';

const HOME = 'T0000FAKE01';
const CLIENT = 'T0CLIENT99';

test('tenantOf — mirrors the installation-store queryKey rule', () => {
  // Org-wide install: the enterprise IS the tenant (token/config keyed by E…).
  assert.equal(tenantOf({ teamId: 'T1AAAAAA', enterpriseId: 'E1BBBBBB', isEnterpriseInstall: true }), 'E1BBBBBB');
  // Workspace-level install INSIDE a Grid: events carry enterprise_id too, but the
  // installation (and the workspaces config entry) is keyed by the team.
  assert.equal(tenantOf({ teamId: 'T1AAAAAA', enterpriseId: 'E1BBBBBB' }), 'T1AAAAAA');
  assert.equal(tenantOf({ teamId: 'T1AAAAAA' }), 'T1AAAAAA');
  assert.equal(tenantOf({ enterpriseId: 'E1BBBBBB' }), 'E1BBBBBB'); // org context without a team
  assert.equal(tenantOf({}), undefined);
});

test('withTeam — home and unknown stay bare; foreign tenants get prefixed', () => {
  assert.equal(withTeam(HOME, HOME, 'thread:1.2'), 'thread:1.2');
  assert.equal(withTeam(undefined, HOME, 'thread:1.2'), 'thread:1.2');
  assert.equal(withTeam(CLIENT, undefined, 'thread:1.2'), 'thread:1.2'); // static mode: no home known → never prefix
  assert.equal(withTeam(CLIENT, HOME, 'thread:1.2'), `${CLIENT}:thread:1.2`);
  assert.equal(withTeam('E0ORG99', HOME, 'dm:C1:caldora'), 'E0ORG99:dm:C1:caldora');
});

test('splitTeam — round-trips withTeam; non-tenant heads left intact', () => {
  assert.deepEqual(splitTeam(`${CLIENT}:thread:1.2`), { tenantId: CLIENT, base: 'thread:1.2' });
  assert.deepEqual(splitTeam('thread:1.2'), { base: 'thread:1.2' });
  // Key-type tokens must never be mistaken for tenants (lowercase, or too short).
  assert.deepEqual(splitTeam('dm:C1:caldora'), { base: 'dm:C1:caldora' });
  assert.deepEqual(splitTeam('cron:r1:caldora'), { base: 'cron:r1:caldora' });
  assert.deepEqual(splitTeam('T1:x'), { base: 'T1:x' }); // too short for a Slack id
});

test('thread helpers tolerate the tenant prefix', () => {
  assert.equal(isThreadKey('thread:1.2'), true);
  assert.equal(isThreadKey(`${CLIENT}:thread:1.2`), true);
  assert.equal(isThreadKey(`${CLIENT}:dm:C1:caldora`), false);
  assert.equal(threadRoot('thread:1.2'), '1.2');
  assert.equal(threadRoot(`${CLIENT}:thread:1.2`), '1.2');
  assert.equal(threadRoot('dm:C1:caldora'), undefined);
});

test('slugOfBase — every non-thread shape, bare and prefixed', () => {
  const shapes: Array<[string, string | undefined]> = [
    ['dm:C1:caldora', 'caldora'],
    ['cmd:U1:caldora', 'caldora'],
    ['cron:r1:caldora', 'caldora'],
    ['review:Org/repo:12:caldora', 'caldora'],
    ['autofix:Org/repo:12:caldora', 'caldora'],
    ['youtrack:CG-50:caldora', 'caldora'],
    ['thread:1.2', undefined], // threads carry no slug — resolved via ChatRecord
    ['ask:x', undefined], // <3 segments
  ];
  for (const [base, want] of shapes) {
    assert.equal(slugOfBase(base), want, base);
    assert.equal(slugOfBase(`${CLIENT}:${base}`), want, `prefixed ${base}`);
  }
});
