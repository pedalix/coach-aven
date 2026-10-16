import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOptions, siblingIndex, type SiblingSource } from './siblings.js';

// A fictional agency: a bike client with a shop and a stock bridge (plus admin), an internal umbrella with a product and
// its support desk, a finished project, a personal bucket; and a holding umbrella whose clients are companies.
const SOURCES: SiblingSource[] = [
  { id: 'nordwind/shop', umbrella: 'nordwind', company: 'nordwind', status: 'active' },
  { id: 'nordwind/stock-sync', umbrella: 'nordwind', company: 'nordwind', status: 'active' },
  { id: 'nordwind/admin', umbrella: 'nordwind', company: 'nordwind', status: 'active' },
  { id: 'nordwind/old-site', umbrella: 'nordwind', company: 'nordwind', status: 'done', done: true },
  { id: 'nordwind/pilot', umbrella: 'nordwind', company: 'nordwind', status: 'dormant' },
  { id: 'inhouse/booker', umbrella: 'inhouse', company: 'inhouse', status: 'active' },
  { id: 'inhouse/booker-desk', umbrella: 'inhouse', company: 'inhouse', status: 'planned' },
  { id: 'inhouse/books', umbrella: 'inhouse', company: 'inhouse', status: 'active' },
  { id: 'holding/kestrel/app', umbrella: 'holding', company: 'kestrel', status: 'active' },
  { id: 'holding/kestrel/api', umbrella: 'holding', company: 'kestrel', status: '' },
  { id: 'holding/plover/site', umbrella: 'holding', company: 'plover', status: 'unknown' },
  { id: 'private/me', umbrella: 'personal', company: null, status: 'active' },
];

test('siblings: the other active initiatives of the umbrella or company; admin, finished and personal never', () => {
  const sib = siblingIndex(SOURCES, { admin: ['inhouse/books'], personal: ['private/me'] });
  assert.deepEqual(sib('nordwind/shop'), ['nordwind/stock-sync'], 'admin (by id), done and dormant are out');
  assert.deepEqual(sib('inhouse/booker'), ['inhouse/booker-desk'], 'a planned initiative may already get work; the declared admin bucket is out');
  // an umbrella spanning companies: every active initiative under it is a sibling (the P-code confusion of a real tenant)
  assert.deepEqual(sib('holding/kestrel/app'), ['holding/kestrel/api', 'holding/plover/site']);
  assert.deepEqual(sib('private/me'), []);
  // the admin bucket itself is checked against the client's initiatives
  assert.deepEqual(sib('nordwind/admin'), ['nordwind/shop', 'nordwind/stock-sync']);
  assert.deepEqual(sib('none'), []);
  assert.deepEqual(sib('unregistered'), []);
});

test('siblings: an id the registry lacks falls back to the dataset umbrella, then to its first path segment', () => {
  assert.deepEqual(siblingIndex(SOURCES, { umbrellas: { 'legacy/x': 'inhouse' } })('legacy/x'), ['inhouse/booker', 'inhouse/booker-desk', 'inhouse/books']);
  assert.deepEqual(siblingIndex(SOURCES)('nordwind/unknown'), ['nordwind/shop', 'nordwind/stock-sync']);
  assert.deepEqual(siblingIndex(SOURCES)('loose'), []);
  // a company match alone is enough when the umbrella differs
  const moved: SiblingSource[] = [...SOURCES, { id: 'other/kestrel/ops', umbrella: 'other', company: 'kestrel', status: 'active' }];
  assert.ok(siblingIndex(moved)('holding/kestrel/app').includes('other/kestrel/ops'));
  // an alias/split source is never a label
  assert.deepEqual(siblingIndex([...SOURCES, { id: 'nordwind/alias', umbrella: 'nordwind', company: 'nordwind', label: false }])('nordwind/shop'), ['nordwind/stock-sync']);
});

test('the closed list of a check: X and its siblings permuted, then none and unregistered', () => {
  const sib = siblingIndex(SOURCES);
  assert.deepEqual(checkOptions('nordwind/shop', sib), ['nordwind/shop', 'nordwind/stock-sync', 'none', 'unregistered']);
  assert.deepEqual(checkOptions('nordwind/shop', sib, (xs) => [...xs].reverse()), ['nordwind/stock-sync', 'nordwind/shop', 'none', 'unregistered']);
  assert.deepEqual(checkOptions('private/me', siblingIndex(SOURCES, { personal: ['private/me'] })), ['private/me', 'none', 'unregistered']);
});
