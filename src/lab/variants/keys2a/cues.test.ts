import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Reg } from '../stage0/registry.js';
import type { Rule } from '../stage0/tenant.js';
import { channelCues, cueText, distinctive, hits, initiativeCues, keyCue, partyTokens, triggerCues, wordCue, type Cue } from './cues.js';

const REG = new Reg({
  companies: [{ id: 'acme', umbrella: 'acme', name: 'Acme Bikes', notes: 'acme.example' }],
  initiatives: [
    {
      id: 'acme/shop',
      umbrella: 'acme',
      company: 'acme',
      name: 'Online shop (Acme is the pilot, fixed price)',
      sources: { repos: ['agency/acme-shop'], youtrack_prefixes: ['AC'], slack_channels: ['#ext-acme'], calendar_title_patterns: ['Acme', 'Checkout'] },
    },
    { id: 'acme/erp-sync', umbrella: 'acme', company: 'acme', name: 'ERP stock-sync bridge', sources: { calendar_title_patterns: ['ERP', 'Acme'], slack_channels: ['#ext-acme'], hosts: ['erp.acme.example'] } },
    { id: 'acme/web-v1', umbrella: 'acme', company: 'acme', name: 'Relaunch v1', status: 'alias', alias_of: 'acme/shop', sources: { calendar_title_patterns: ['Relaunch'] } },
  ],
});
const VOCAB = { parties: partyTokens(REG), names: new Set(['mara']) };
const norms = (cs: readonly Cue[]): string[] => cs.map((c) => c.norm);

test('an initiative’s cues: name tokens without remarks, titles, repos, keys, channels, hosts, id segments, alias cues — never the client', () => {
  const shop = norms(initiativeCues(REG, 'acme/shop', VOCAB));
  assert.ok(shop.includes('online') && shop.includes('shop'));
  assert.ok(!shop.includes('pilot') && !shop.includes('fixed') && !shop.includes('price'), 'a parenthesised remark is not a name');
  assert.ok(!shop.includes('acme'), 'the client name is not a cue of one of its initiatives');
  assert.ok(shop.includes('checkout') && shop.includes('acme shop') && shop.includes('key:AC') && shop.includes('#ext-acme'));
  assert.ok(shop.includes('relaunch'), 'a renamed project lends its old words');
  const erp = norms(initiativeCues(REG, 'acme/erp-sync', VOCAB));
  assert.ok(['erp', 'sync', 'stock', 'bridge', 'host:erp.acme.example'].every((c) => erp.includes(c)), erp.join(' | '));
});

test('within a client only distinctive cues survive', () => {
  const ids = ['acme/shop', 'acme/erp-sync'];
  const d = distinctive(new Map(ids.map((id) => [id, initiativeCues(REG, id, VOCAB)])), ids);
  assert.ok(!norms(d.get('acme/shop')!).includes('#ext-acme'), 'a channel both list cannot tell them apart');
  assert.ok(!norms(d.get('acme/erp-sync')!).includes('#ext-acme'));
  assert.ok(norms(d.get('acme/shop')!).includes('shop'));
});

test('matching: Unicode word edges, short words whole, long words as a word start, keys with a number', () => {
  const t = (c: Cue | null, s: string) => !!c && c.re.test(cueText({ text: s }));
  assert.equal(t(wordCue('sync'), 'the stock-sync lags'), true);
  assert.equal(t(wordCue('sync'), 'we synced it'), false, '≤4 letters: whole word');
  assert.equal(t(wordCue('shop'), 'two shops'), true, 'an optional plural');
  assert.equal(t(wordCue('relaunch'), 'the relaunched site'), true, 'a longer word: a word start');
  assert.equal(t(wordCue('relaunch'), 'prerelaunch'), false);
  assert.equal(t(wordCue('go-live'), 'Go Live next week'), true, 'a phrase’s parts join by space or dash');
  assert.equal(t(wordCue('Erfolg'), 'ERFOLG!'), true);
  assert.equal(t(wordCue('доставка'), 'Доставка задерживается'), true, 'Cyrillic edges work');
  assert.equal(t(wordCue('ставка'), 'Доставка'), false, 'JS \\b would match inside a Cyrillic word; ours does not');
  assert.equal(t(keyCue('AC'), 'see AC-12'), true);
  assert.equal(t(keyCue('AC'), 'see AC-team'), false);
  assert.equal(t(keyCue('AC'), 'MAC-12'), false);
  const [byName, byId] = channelCues({ id: 'C0EXT00001', name: '#ext-acme' });
  assert.equal(t(byName!, 'posted in ext-acme'), true);
  assert.equal(t(byId!, 'link to C0EXT00001 thread'), true);
});

test('a rung cannot corroborate itself: the trigger’s cues are skipped', () => {
  const rules = new Map<string, Rule>([['r-ext', { id: 'r-ext', when: { container: '#Ext-Acme' }, then: { initiative: 'acme/shop' } }], ['r-key', { id: 'r-key', when: { project_key: 'ac' }, then: { initiative: 'acme/shop' } }]]);
  assert.deepEqual([...triggerCues('key:AC', rules)], ['key:AC']);
  assert.deepEqual([...triggerCues('rule:r-ext', rules)], ['#ext-acme']);
  assert.deepEqual([...triggerCues('rule:r-key', rules)], ['key:AC']);
  assert.ok(triggerCues('channel:C0EXT00001', rules).has('id:c0ext00001'));
  assert.deepEqual([...triggerCues('title:checkout', rules)], ['checkout']);
  assert.equal(triggerCues('excl:ana-berg', rules).size, 0, 'a person is never a cue');
  const shop = initiativeCues(REG, 'acme/shop', VOCAB);
  const text = cueText({ subject: 'AC-12 checkout fails', text: 'the shop is down' });
  assert.deepEqual(hits(shop, text, triggerCues('key:AC', rules)), ['shop', 'checkout']);
  assert.deepEqual(hits(shop, text), ['shop', 'checkout', 'key:AC']);
});
