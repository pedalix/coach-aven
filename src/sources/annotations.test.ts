import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attributionRows, parseFragments } from './annotations.js';
import { authConfigArgs, cloneArgs, fetchArgs } from './tenant.js';
import { validateSourcesConfig } from './config.js';
import { validatePeople } from './people.js';

const L = (o: object) => JSON.stringify(o);

test('parseFragments: last line per id wins, superseded dropped, junk counted, defaults filled', () => {
  const text = [
    L({ id: 'a', kind: 'call', refs: ['r1'], attributions: [{ initiative: 'x', share: 0.5 }], decided_by: 'rule', status: 'decided' }),
    'garbage',
    L({ id: 'b', refs: ['r2'], attributions: [{ initiative: 'y' }] }),
    L({ id: 'a', kind: 'call', refs: ['r1'], attributions: [{ initiative: 'x' }], status: 'superseded' }),
    L({ refs: ['no id'] }),
    '',
  ].join('\n');
  const { fragments, malformed } = parseFragments(text);
  assert.equal(malformed, 2);
  assert.deepEqual(fragments.map((f) => [f.id, f.kind, f.status, f.decided_by]), [['b', 'thread', 'decided', 'model']]);
  assert.deepEqual(fragments[0]!.attributions, [{ initiative: 'y', share: 1 }]);
});

test('attributionRows: one row per ref × initiative, only decided fragments, resolver applied', () => {
  const { fragments } = parseFragments(
    [
      L({ id: 'f', refs: ['meeting:granola:g1', 'slack:T:1'], attributions: [{ initiative: 'p1', share: 0.7 }, { initiative: 'p4', share: 0.3 }], decided_by: 'model' }),
      L({ id: 'e', refs: ['r'], attributions: [{ initiative: 'q' }], status: 'escalated' }),
    ].join('\n'),
  );
  const rows = attributionRows(fragments, (r) => (r.startsWith('meeting:') ? ['granola:me:g1'] : [r]));
  assert.deepEqual(
    rows.map((r) => [r.ref, r.initiative, r.share]),
    [
      ['granola:me:g1', 'p1', 0.7],
      ['granola:me:g1', 'p4', 0.3],
      ['slack:T:1', 'p1', 0.7],
      ['slack:T:1', 'p4', 0.3],
    ],
  );
});

test('tenant git args: token travels as a one-shot header, never in the URL', () => {
  const args = cloneArgs({ repo: 'owner-example/owen-ops', ref: 'master' }, '/d/tenant', 'ghs_secret');
  assert.ok(args.includes('https://github.com/owner-example/owen-ops.git'));
  assert.ok(!args.some((a) => a.includes('ghs_secret')), 'raw token must not appear');
  assert.match(args[1]!, /^http\.https:\/\/github\.com\/\.extraheader=AUTHORIZATION: basic /);
  assert.deepEqual(args.slice(2), ['clone', '--depth', '1', '--branch', 'master', 'https://github.com/owner-example/owen-ops.git', '/d/tenant']);
  assert.deepEqual(authConfigArgs(undefined), []);
  assert.deepEqual(fetchArgs({ repo: 'a/b' }), ['fetch', '--depth', '1', 'origin', 'HEAD']);
});

test('config: meetings + tenant validate; bad shapes fail with a path', () => {
  const c = validateSourcesConfig({ meetings: { granola: { since: '2026-10-01' }, gmeet: { accounts: ['Owen@example.com'] }, wispr: {} }, tenant: { repo: 'owner-example/owen-ops', ref: 'master' } });
  assert.deepEqual(c.meetings, { granola: { since: '2026-10-01' }, gmeet: { accounts: ['owen@example.com'] }, wispr: {} });
  assert.deepEqual(c.tenant, { repo: 'owner-example/owen-ops', ref: 'master' });
  assert.throws(() => validateSourcesConfig({ meetings: { zoom: {} } }), /sources\.meetings: unknown provider "zoom"/);
  assert.throws(() => validateSourcesConfig({ meetings: {} }), /declares no provider/);
  assert.throws(() => validateSourcesConfig({ google: { accounts: ['a@b.co'] }, tenant: { repo: 'nope' } }), /owner\/name/);
  assert.throws(() => validateSourcesConfig({ google: { accounts: ['a@b.co'] }, tenant: { repo: 'a/b', path: '../x' } }), /without/);
  // tenant alone is not a source
  assert.throws(() => validateSourcesConfig({ tenant: { repo: 'a/b' } }), /declares no source/);
});

test('people markers: validated; legacy default_initiative becomes a broad marker', () => {
  const p = validatePeople([
    { person_id: 'haki', name: 'Haki', identities: ['slack:Haki'], marker: { type: 'exclusive', initiatives: ['hcg/brandhaus/p5'] } },
    { person_id: 'old', name: 'Old', identities: ['o@x.com'], default_initiative: 'bluefin/x' },
  ]);
  assert.deepEqual(p.map((x) => x.marker), [{ type: 'exclusive', initiatives: ['hcg/brandhaus/p5'] }, { type: 'broad', initiatives: ['bluefin/x'] }]);
  assert.throws(() => validatePeople([{ person_id: 'a', name: 'A', identities: [], marker: { type: 'sometimes', initiatives: [] } }]), /marker.type/);
  assert.throws(() => validatePeople([{ person_id: 'a', name: 'A', identities: [], marker: { type: 'exclusive', initiatives: [] } }]), /needs at least one/);
});
