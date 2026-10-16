import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Reg } from '../stage0/registry.js';
import { clientOfLabel, siblingIndex } from './siblings.js';

// A fictional agency: one client with two projects and an admin bucket, a team umbrella holding two clients, a renamed
// project (alias), a finished one, a planned one, and the subject's private life.
const REG = new Reg({
  companies: [
    { id: 'acme', umbrella: 'acme', name: 'Acme Bikes' },
    { id: 'zeta', umbrella: 'team', name: 'Zeta Rail' },
    { id: 'omega', umbrella: 'team', name: 'Omega Ski' },
  ],
  initiatives: [
    { id: 'acme/shop', umbrella: 'acme', company: 'acme', name: 'Online shop', status: 'active' },
    { id: 'acme/erp', umbrella: 'acme', company: 'acme', name: 'ERP bridge', status: 'active' },
    { id: 'acme/old', umbrella: 'acme', company: 'acme', name: 'Old site', status: 'done' },
    { id: 'acme/admin', umbrella: 'acme', company: 'acme', name: 'Acme admin', status: 'active' },
    { id: 'acme/web-v1', umbrella: 'acme', company: 'acme', name: 'Web v1', status: 'alias', alias_of: 'acme/shop' },
    { id: 'team/zeta', umbrella: 'team', company: 'zeta', name: 'Ticketing', status: 'active' },
    { id: 'team/zeta-app', umbrella: 'team', company: 'zeta', name: 'App', status: 'planned' },
    { id: 'team/omega', umbrella: 'team', company: 'omega', name: 'Booking', status: 'active' },
    { id: 'team/omega-cms', umbrella: 'team', company: 'omega', name: 'CMS' },
    { id: 'personal/me', umbrella: 'personal', name: 'Private', status: 'active' },
  ],
});
const EXCLUDED = new Set(['acme/admin', 'personal/me']);

test('siblings are the other active initiatives of the client (company first), admin and personal never', () => {
  const s = siblingIndex(REG, EXCLUDED);
  assert.deepEqual(s.get('acme/shop')!.siblings, ['acme/erp'], 'done, alias and admin are not siblings');
  assert.equal(s.get('acme/shop')!.scope, 'acme');
  assert.deepEqual(s.get('acme/erp')!.siblings, ['acme/shop']);
  assert.deepEqual(s.get('acme/admin')!.siblings, [], 'an admin bucket has no siblings');
  assert.deepEqual(s.get('personal/me')!.siblings, []);
  // a team umbrella holds two clients: the company is the scope, not the umbrella
  assert.deepEqual(s.get('team/zeta')!.siblings, [], 'a planned project is not active; the other client is not a sibling');
  assert.deepEqual(s.get('team/omega')!.siblings, ['team/omega-cms'], 'no status given counts as active');
  assert.equal(s.get('team/omega')!.umbrella, 'team');
  assert.equal(s.get('team/omega')!.scope, 'omega');
  assert.equal(s.has('acme/web-v1'), false, 'an alias is not a label');
});

test('the client of a label: registry labels by company, aliases resolved, anything else is itself', () => {
  assert.equal(clientOfLabel(REG, 'acme/erp'), 'acme');
  assert.equal(clientOfLabel(REG, 'acme/web-v1'), 'acme');
  assert.equal(clientOfLabel(REG, 'team/omega-cms'), 'omega');
  assert.equal(clientOfLabel(REG, 'none'), 'none');
  assert.equal(clientOfLabel(REG, 'unregistered'), 'unregistered');
});

test('the umbrella ablation: every active initiative of the billing frame is a sibling, clients notwithstanding', () => {
  const s = siblingIndex(REG, EXCLUDED, 'umbrella');
  assert.deepEqual(s.get('team/zeta')!.siblings, ['team/omega', 'team/omega-cms']);
  assert.equal(s.get('team/zeta')!.scope, 'team');
  assert.deepEqual(s.get('acme/shop')!.siblings, ['acme/erp'], 'where umbrella = company nothing changes');
  assert.equal(clientOfLabel(REG, 'team/omega-cms', 'umbrella'), 'team');
});
