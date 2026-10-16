import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FragmentUnit, ItemUnit, MemoryRow, MentionUnit, Prediction } from '../../types.js';
import type { Floor, Stage0 } from '../stage0/index.js';
import { asFloor, SpineFloor } from './floor.js';

const D = '2026-01-05';
const item = (id: string): ItemUnit => ({ id, day: D, ts: `${D}T09:00:00Z`, type: 'message', source: 'slack', account: 'T0', container: '#c', thread: id, author: 'A', authorPerson: null, isBot: false, participants: [], toPersons: [], subject: null, text: 't', keys: [] });
const frag = (id: string): FragmentUnit => ({ id, day: D, kind: 'call', start: `${D}T10:00:00Z`, end: `${D}T11:00:00Z`, minutes: 30, title: 'x', source: 'granola', container: null, participants: [], projectKeys: [], repo: null, weight: 1, refs: [], text: 't' });

function fake(calls: string[]): Stage0 {
  const f = (c: string): Floor => ({ label: 'acme/shop', conf: 0.97, rung: 'key:AC', candidates: ['acme/shop', 'acme/erp-sync'], hint: 'key AC; no cue', case: c, umbrella: 'acme', prior: 0.97 });
  return {
    fragment: (u) => ({ ...f(`call:${u.id}`), participants: ['mara'], cowork: ['acme/shop'] }),
    item: (u) => ({ ...f(`thread:${u.id}`), senderClass: 'human', family: `fam:${u.id}`, hosts: ['h.example'], apps: [] }),
    mention: (u) => (calls.push('mention'), { label: null, conf: 0, rung: 'open', candidates: [], hint: '', case: u.id }),
    kind: (u) => ({ label: 'noise', conf: 0.95, rung: 'sender:bot', candidates: [], hint: '', case: `thread:${u.id}` }),
    addressee: (u) => (calls.push('addressee'), { label: null, conf: 0, rung: 'open', candidates: [], hint: '', case: u.id }),
    dedup: () => (calls.push('dedup'), new Map()),
    labelSpace: () => (calls.push('labelSpace'), ['acme/shop', 'none']),
    cards: () => (calls.push('cards'), []),
    calibrate: () => void calls.push('calibrate'),
  };
}

test('asFloor: the spine’s label, conf and rung over the floor as the spine saw it; its label joins the candidates', () => {
  const f: Floor & { family: string } = { label: 'acme/shop', conf: 0.97, rung: 'key:AC', candidates: ['acme/shop'], hint: 'h', case: 'c', family: 'fam' };
  const p: Prediction = { id: 'u', label: 'acme/erp-sync', conf: 0.6, rung: 'sib:key:AC' };
  assert.deepEqual(asFloor(f, p), { label: 'acme/erp-sync', conf: 0.6, rung: 'sib:key:AC', candidates: ['acme/erp-sync', 'acme/shop'], hint: 'h', case: 'c', family: 'fam' });
  assert.deepEqual(asFloor(f, { id: 'u', label: null, conf: 0.4, rung: 'abstain' }), { ...f, label: null, conf: 0, rung: 'abstain' }, 'an abstention has no confidence');
  assert.equal(asFloor(f, undefined), f, 'a pool unit the spine did not decide: the floor as is');
});

test('SpineFloor: fragment/item/kind are the spine’s; the rest is stage 0; calibrate never reaches the floor', () => {
  const calls: string[] = [];
  const raw = fake(calls);
  const sf = new SpineFloor();
  assert.throws(() => sf.item(item('i'), []), /before the spine decided/);
  sf.set(raw, raw, [
    { id: 'i', label: 'acme/shop', conf: 0.85, rung: 'held:key:AC' },
    { id: 'f', label: 'acme/shop', conf: 0.99, rung: 'earned:series' },
    { id: 'k', label: 'request', conf: 0.8, rung: 'guess:cue' },
  ]);
  const it = sf.item(item('i'), []);
  assert.deepEqual([it.label, it.conf, it.rung, it.case, it.senderClass, it.family, it.hosts], ['acme/shop', 0.85, 'held:key:AC', 'thread:i', 'human', 'fam:i', ['h.example']]);
  const fr = sf.fragment(frag('f'), []);
  assert.deepEqual([fr.label, fr.conf, fr.rung, fr.participants, fr.cowork], ['acme/shop', 0.99, 'earned:series', ['mara'], ['acme/shop']]);
  assert.deepEqual([sf.kind(item('k')).label, sf.kind(item('k')).rung], ['request', 'guess:cue']);
  assert.deepEqual([sf.kind(item('other')).label, sf.kind(item('other')).rung], ['noise', 'sender:bot'], 'no spine prediction: stage 0');
  sf.mention({ id: 'm' } as MentionUnit);
  sf.addressee(item('a'));
  sf.dedup([]);
  sf.labelSpace('t1-item');
  sf.cards();
  sf.calibrate([{ id: 'i', task: 't1-item', day: D, label: 'acme/shop', source: 'human' } as MemoryRow], new Map([['i', 'held:key:AC']]));
  assert.deepEqual(calls, ['mention', 'addressee', 'dedup', 'labelSpace', 'cards']);
  // the next day replaces the spine's predictions
  sf.set(raw, raw, []);
  assert.equal(sf.item(item('i'), []).rung, 'key:AC');
});
