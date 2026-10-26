// Surfaces in keys: the default surface's keys are untouched, an additional surface's keys carry the
// driver's name first, and neither a tenant id nor a key kind is ever read as a surface.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driverForKey, parseSurfaces, splitSurface, withSurface } from './surfaces.js';
import { CHAT_DRIVERS } from './drivers.js';
import { isThreadKey, slugOfBase, threadRoot, withTeam } from '../teamkeys.js';

test('the three key shapes round-trip; the default surface leaves a key as it was', () => {
  assert.equal(withSurface(undefined, 'thread:171234.5678'), 'thread:171234.5678');
  assert.deepEqual(splitSurface('thread:171234.5678'), {
    base: 'thread:171234.5678',
  });
  assert.deepEqual(splitSurface('T0CLIENT1:thread:171234.5678'), {
    tenantId: 'T0CLIENT1',
    base: 'thread:171234.5678',
  });
  const teams = withSurface('teams', withTeam(undefined, undefined, 'thread:7f3a'));
  assert.equal(teams, 'teams:thread:7f3a');
  assert.deepEqual(splitSurface(teams), {
    surface: 'teams',
    base: 'thread:7f3a',
  });
  const both = withSurface('slack', withTeam('T0CLIENT1', 'T0HOME', 'dm:C1:alpha'));
  assert.equal(both, 'slack:T0CLIENT1:dm:C1:alpha');
  assert.deepEqual(splitSurface(both), {
    surface: 'slack',
    tenantId: 'T0CLIENT1',
    base: 'dm:C1:alpha',
  });
});

test('the key helpers see through the surface segment', () => {
  assert.equal(isThreadKey('teams:thread:7f3a'), true);
  assert.equal(threadRoot('teams:T0CLIENT1:thread:1792'), '1792');
  assert.equal(slugOfBase('teams:dm:u1:alpha'), 'alpha');
  assert.equal(slugOfBase('teams:thread:7f3a'), undefined);
});

test('a driver name is never a tenant id or a key kind, so a head is read once', () => {
  for (const d of CHAT_DRIVERS) {
    assert.doesNotMatch(d, /^[TE][A-Z0-9]{5,}$/);
    assert.ok(!['thread', 'dm', 'cmd', 'cron', 'review', 'autofix', 'youtrack', 'a2a'].includes(d));
  }
  // A key kind that happens to be a prefix of nothing: untouched.
  assert.deepEqual(splitSurface('cron:r1:alpha'), { base: 'cron:r1:alpha' });
});

test('driverForKey resolves the surface and tenant of a key', () => {
  const seen: unknown[] = [];
  const driverFor = (ref: unknown) => (seen.push(ref), {} as never);
  driverForKey(driverFor, 'thread:1');
  driverForKey(driverFor, 'T0CLIENT1:thread:1');
  driverForKey(driverFor, 'teams:thread:1');
  driverForKey(driverFor, 'slack:T0CLIENT1:thread:1');
  assert.deepEqual(seen, [{}, { tenantId: 'T0CLIENT1' }, { surface: 'teams' }, { surface: 'slack', tenantId: 'T0CLIENT1' }]);
});

test('CHAT_SURFACES: names validated against the build, duplicates dropped, unknown refused with the list', () => {
  assert.deepEqual(parseSurfaces(undefined), []);
  assert.deepEqual(parseSurfaces(' teams, slack ,teams'), ['teams', 'slack']);
  assert.throws(() => parseSurfaces('teams,irc'), /unknown chat drivers: irc/);
});

test('the store stamps a record with its surface from the key; a bare key gets no field, as before', async () => {
  const { Store } = await import('../state.js');
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'surfaces-')), 'state.json'));
  store.setChat({
    threadTs: 'thread:1',
    slug: 'alpha',
    updatedAt: 'x',
  } as never);
  store.setChat({
    threadTs: 'teams:thread:2',
    slug: 'alpha',
    updatedAt: 'x',
  } as never);
  store.setChat({
    threadTs: 'slack:T0CLIENT1:thread:3',
    slug: 'alpha',
    updatedAt: 'x',
  } as never);
  assert.equal('surface' in (store.getChat('thread:1') as object), false);
  assert.equal((store.getChat('teams:thread:2') as { surface?: string }).surface, 'teams');
  assert.deepEqual(
    [(store.getChat('slack:T0CLIENT1:thread:3') as { surface?: string }).surface, (store.getChat('slack:T0CLIENT1:thread:3') as { teamId?: string }).teamId],
    ['slack', 'T0CLIENT1'],
  );
  store.patchChat('teams:thread:2', 'alpha', { sessionId: 's' });
  assert.equal((store.getChat('teams:thread:2') as { surface?: string }).surface, 'teams');
});
