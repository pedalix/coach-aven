import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeGrants,
  clock,
  DEFAULT_GRANT_MS,
  effectNote,
  endNotice,
  expiredGrants,
  githubExtras,
  grantListText,
  grantNotice,
  MAX_GRANT_MS,
  parseDuration,
  parseGrantCmd,
  type GrantRecord,
} from './grants.js';

const T0 = Date.parse('2026-03-02T14:00:00Z');
const grant = (o: Partial<GrantRecord> = {}): GrantRecord => ({
  slug: 'atlas',
  capability: 'workflows',
  at: new Date(T0).toISOString(),
  until: new Date(T0 + DEFAULT_GRANT_MS).toISOString(),
  by: 'U_DANA',
  channel: 'C_ATLAS',
  ...o,
});

test('parseGrantCmd: bare = list', () => {
  assert.deepEqual(parseGrantCmd(''), { action: 'list' });
  assert.deepEqual(parseGrantCmd('   '), { action: 'list' });
});

test('parseGrantCmd: a capability alone = the 30-minute default', () => {
  assert.deepEqual(parseGrantCmd('workflows'), { action: 'grant', capability: 'workflows', ms: 30 * 60_000 });
  assert.deepEqual(parseGrantCmd('Workflows'), { action: 'grant', capability: 'workflows', ms: 30 * 60_000 });
});

test('parseGrantCmd: explicit durations in minutes and hours', () => {
  assert.deepEqual(parseGrantCmd('workflows 2h'), { action: 'grant', capability: 'workflows', ms: 2 * 3600_000 });
  assert.deepEqual(parseGrantCmd('workflows 90m'), { action: 'grant', capability: 'workflows', ms: 90 * 60_000 });
  assert.deepEqual(parseGrantCmd('workflows 4h'), { action: 'grant', capability: 'workflows', ms: MAX_GRANT_MS });
});

test('parseGrantCmd: longer than 4 hours is refused, naming the limit', () => {
  const r = parseGrantCmd('workflows 6h');
  assert.equal(r.action, 'error');
  assert.match((r as { message: string }).message, /at most 4h/);
  assert.equal(parseGrantCmd('workflows 241m').action, 'error');
});

test('parseGrantCmd: an unreadable or zero duration is refused with the usage', () => {
  for (const s of ['workflows soon', 'workflows 0m', 'workflows 1d', 'workflows 2h extra']) {
    const r = parseGrantCmd(s);
    assert.equal(r.action, 'error', s);
    assert.match((r as { message: string }).message, /Usage/, s);
  }
});

test('parseGrantCmd: an unknown capability is refused, listing the ones that exist', () => {
  const r = parseGrantCmd('deploy');
  assert.equal(r.action, 'error');
  assert.match((r as { message: string }).message, /no capability `deploy`.*`workflows`, `actions`/);
  assert.equal(parseGrantCmd('toString').action, 'error'); // not an inherited property
});

// OpenSpec agent-github-read-superset: the actions capability.
test('parseGrantCmd: actions is a capability of its own', () => {
  assert.deepEqual(parseGrantCmd('actions 2h'), { action: 'grant', capability: 'actions', ms: 2 * 3600_000 });
  assert.deepEqual(parseGrantCmd('actions off'), { action: 'off', capability: 'actions' });
});

test('parseGrantCmd: off', () => {
  assert.deepEqual(parseGrantCmd('workflows off'), { action: 'off', capability: 'workflows' });
});

test('parseDuration', () => {
  assert.equal(parseDuration('30m'), 30 * 60_000);
  assert.equal(parseDuration('1h'), 3600_000);
  assert.equal(parseDuration('1.5h'), undefined);
  assert.equal(parseDuration('h'), undefined);
});

test('active vs expired at the boundary: the end instant is already expired', () => {
  const g = grant();
  const end = Date.parse(g.until);
  assert.deepEqual(activeGrants([g], 'atlas', end - 1), [g]);
  assert.deepEqual(activeGrants([g], 'atlas', end), []);
  assert.deepEqual(expiredGrants([g], end - 1), []);
  assert.deepEqual(expiredGrants([g], end), [g]);
});

test('activeGrants: only the asked project', () => {
  assert.deepEqual(activeGrants([grant({ slug: 'borealis' })], 'atlas', T0), []);
});

test('githubExtras: empty without a grant, after the end, and for another project', () => {
  assert.deepEqual(githubExtras([], 'atlas', T0), {});
  assert.deepEqual(githubExtras([grant()], 'atlas', T0 + DEFAULT_GRANT_MS), {});
  assert.deepEqual(githubExtras([grant({ slug: 'borealis' })], 'atlas', T0), {});
});

test('githubExtras: an active workflows grant adds workflows write', () => {
  assert.deepEqual(githubExtras([grant()], 'atlas', T0 + 1), { workflows: 'write' });
});

test('githubExtras: an actions grant adds actions write; both grants add both', () => {
  assert.deepEqual(githubExtras([grant({ capability: 'actions' })], 'atlas', T0 + 1), { actions: 'write' });
  assert.deepEqual(githubExtras([grant(), grant({ capability: 'actions' })], 'atlas', T0 + 1), { workflows: 'write', actions: 'write' });
});

test('githubExtras: a record naming a capability that no longer exists adds nothing', () => {
  assert.deepEqual(githubExtras([grant({ capability: 'retired' })], 'atlas', T0 + 1), {});
});

test('texts: notice, end, list', () => {
  const g = grant();
  assert.equal(clock(g.until, 'UTC'), '14:30 (UTC)');
  assert.equal(
    grantNotice(g, 'UTC'),
    ':unlock: <@U_DANA> gave *atlas* GitHub workflows write until 14:30 (UTC). Every turn of this project that starts before then gets it.',
  );
  assert.match(endNotice(g), /^:lock: Time is up for \*atlas\*'s GitHub workflows write\. New turns get the usual token; tokens already handed out expire within the hour\.$/);
  assert.match(endNotice(g, 'U_EVE'), /^:lock: <@U_EVE> ended \*atlas\*'s/);
  assert.equal(grantListText('atlas', [], 'UTC'), ':information_source: *atlas* holds no grants.');
  assert.equal(grantListText('atlas', [g], 'UTC'), '*atlas* grants:\n• `workflows` (GitHub workflows write) until 14:30 (UTC), granted by <@U_DANA>');
});

test('effectNote: token mode and no auth change nothing; an installation without the permission is named', () => {
  assert.match(effectNote('token', 'workflows', undefined), /static GitHub token.*changes nothing/);
  assert.match(effectNote('none', 'workflows', undefined), /changes nothing/);
  assert.match(effectNote(undefined, 'workflows', undefined), /changes nothing/);
  assert.match(effectNote('app', 'workflows', { contents: 'write' }), /not approved `workflows`.*organization owner/);
  assert.equal(effectNote('app', 'workflows', { contents: 'write', workflows: 'write' }), '');
  assert.equal(effectNote('app', 'workflows', undefined), ''); // could not read the installation: claim nothing
});

test('effectNote: a permission approved at a lower level than the grant needs is named with the level', () => {
  assert.match(effectNote('app', 'actions', { contents: 'write', actions: 'read' }), /not approved `actions: write`.*organization owner/);
  assert.match(effectNote('app', 'actions', { contents: 'write' }), /not approved `actions` —/);
  assert.equal(effectNote('app', 'actions', { contents: 'write', actions: 'write' }), '');
});
