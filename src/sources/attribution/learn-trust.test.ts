// Sibling-aware trust (learn-trust.ts) on a fictional agency: cue parsing and matching, siblings by client, distinctive
// cues, the rung's own cue excluded, and the K2a §1 outcomes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCue, siblingTrust, Siblings, triggerNorms, type TrustInitiative } from './learn-trust.js';

const INI: TrustInitiative[] = [
  { id: 'acme/shop', umbrella: 'acme', company: 'acme', active: true, cues: ['Online shop', 'Acme', 'catalog', 'key:AC', '#ext-acme', 'host:shop.acme.example'] },
  { id: 'acme/sync', umbrella: 'acme', company: 'acme', active: true, cues: ['ERP stock sync', 'catalog', 'acme-erp-bridge'] },
  { id: 'acme/admin', umbrella: 'acme', company: 'acme', active: true, cues: ['invoices'] },
  { id: 'acme/legacy', umbrella: 'acme', company: 'acme', active: false, cues: ['legacy'] },
  { id: 'globex/portal', umbrella: 'globex', active: true, cues: ['portal', 'key:GP'] },
  { id: 'agency/caldora-app', umbrella: 'agency', company: 'caldora', active: true, cues: ['app'] },
  { id: 'agency/dorfberg-web', umbrella: 'agency', company: 'dorfberg', active: true, cues: ['web'] },
  { id: 'personal/personal', umbrella: 'personal', active: true, cues: [] },
];
const S = new Siblings(INI);
const match = (cue: string, text: string) => parseCue(cue)!.re.test(text.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase());

test('cues: short words whole, long words a word start, phrases across separators, keys as KEY-<n>, hosts with subdomains', () => {
  assert.equal(match('ERP', 'the ERP-import failed'), true);
  assert.equal(match('ERP', 'ein Erpel'), false);
  assert.equal(match('shop', 'two shops'), true);
  assert.equal(match('relaunch', 'relaunched today'), true);
  assert.equal(match('Abrechnung', 'die Lohnabrechnung'), false, 'a long word must start a word, not end one');
  assert.equal(match('Übergabe', 'Ubergabe am Montag'), true, 'folded: marks dropped on both sides');
  assert.equal(match('ERP stock sync', 'erp_stock-sync lag'), true);
  assert.equal(match('key:VN', 'VN-22 is late'), true);
  assert.equal(match('key:VN', 'VN is late'), false);
  assert.equal(match('host:shop.acme.example', 'down: https://api.shop.acme.example/health'), true);
  assert.equal(match('#ext-acme', 'see ext-acme'), true);
  assert.equal(parseCue('the'), null, 'a function word is no cue');
  assert.equal(parseCue('shop.acme.example')!.norm, 'host:shop.acme.example', 'a dotted name is a host');
  assert.equal(parseCue('C0ACME0001')!.norm, 'id:c0acme0001', 'a channel id');
});

test('the rung’s own evidence never counts as a cue', () => {
  assert.deepEqual([...triggerNorms('key:AC')].sort(), ['ac', 'key:AC']);
  assert.deepEqual([...triggerNorms('channel:#ext-acme')].sort(), ['#ext-acme', 'ext acme']);
  assert.ok(triggerNorms('rule:r-acme', ['#acme-dev']).has('#acme-dev'), 'a rule’s container comes from the caller');
});

test('siblings: the client’s other active initiatives — by company before umbrella; never admin, personal or inactive', () => {
  assert.deepEqual(S.siblings('acme/shop'), ['acme/sync']);
  assert.deepEqual(S.siblings('acme/admin'), [], 'an admin bucket has no siblings');
  assert.deepEqual(S.siblings('globex/portal'), []);
  assert.deepEqual(S.siblings('agency/caldora-app'), [], 'one billing umbrella, two clients: not siblings');
  assert.deepEqual(S.siblings('personal/personal'), []);
  assert.equal(S.client('agency/dorfberg-web'), 'dorfberg');
  assert.equal(S.client('unregistered'), null);
});

test('K2a §1: own cue keeps, a sibling’s cue guesses the sibling, both or neither doubt — shared, party and trigger cues are silent', () => {
  const trig = triggerNorms('key:AC');
  const judge = (text: string, confirmed = 0) => {
    const h = S.hits('acme/shop', text, trig)!;
    const t = siblingTrust('acme/shop', 0.98, 'key:AC', h, confirmed);
    return [t.label, t.conf, t.rung];
  };
  assert.deepEqual(judge('AC-12 checkout broken in the online shop'), ['acme/shop', 0.98, 'key:AC']);
  assert.deepEqual(judge('AC-13 ERP stock sync lags again'), ['acme/sync', 0.6, 'cue:key:AC']);
  assert.deepEqual(judge('AC-14 online shop prices wrong after the ERP stock sync'), ['acme/shop', 0.85, 'key:AC']);
  assert.deepEqual(judge('AC-15 please check'), ['acme/shop', 0.85, 'key:AC'], 'AC-15 is the rung itself: no cue');
  assert.deepEqual(judge('AC-16 catalog import'), ['acme/shop', 0.85, 'key:AC'], 'a cue both carry tells nothing');
  assert.deepEqual(judge('AC-17 Acme asked again'), ['acme/shop', 0.85, 'key:AC'], 'the client’s name is a party, not a topic');
  assert.deepEqual(judge('AC-18 legacy export'), ['acme/shop', 0.85, 'key:AC'], 'an inactive initiative is no sibling');
  assert.deepEqual(judge('AC-15 please check', 3), ['acme/shop', 0.98, 'key:AC'], 'answers on the route confirm it: the no-cue case is repaired');
  assert.deepEqual(judge('AC-13 ERP stock sync lags again', 3), ['acme/sync', 0.6, 'cue:key:AC'], '…but never against a sibling’s cue in the unit’s own words');
  assert.equal(S.hits('globex/portal', 'GP-1 portal down', triggerNorms('key:GP')), null, 'no siblings: trust stays as it is');
  assert.equal(siblingTrust('acme/shop', 0.9, 'key:AC', S.hits('acme/shop', 'nothing', trig)!).conf, 0.85);
  assert.equal(siblingTrust('acme/shop', 0.8, 'key:AC', S.hits('acme/shop', 'nothing', trig)!).conf, 0.8, 'never above what calibration left');
});

test('a channel cue needs its #: the bare word is a word cue, and a word two siblings share stays out', async () => {
  const { channelCue } = await import('./learn-trust.js');
  const c = channelCue('#booker')!;
  assert.ok(c.re.test('see #booker for the thread'));
  assert.equal(c.re.test('a customer of the booker widget'), false);
});
