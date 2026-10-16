// The floor end to end over a fictional dataset directory: the tenant files as given, and a small frozen store built with
// the production schema (two recordings of one call, a calendar event, a run's recipients).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../../sources/store.js';
import type { DatasetMeta, DayCtx, FragmentUnit, ItemUnit, MemoryRow } from '../../types.js';
import { stage0Variant } from '../stage0.js';
import { channelIdOf, stage0 } from './index.js';

const DAY = '2026-09-07';
const at = (hm: string, day = DAY) => `${day}T${hm}:00.000Z`;

function dataset(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stage0-'));
  const ann = join(dir, 'tenant', 'annotations');
  mkdirSync(ann, { recursive: true });
  writeFileSync(
    join(dir, 'tenant', 'initiatives.json'),
    JSON.stringify({
      companies: [{ id: 'acme', umbrella: 'acme', name: 'Acme Hotels', domains: ['acme.example'] }],
      initiatives: [
        { id: 'acme/shop', umbrella: 'acme', company: 'acme', name: 'Online shop', status: 'active', billing_code: 'AC-SHOP', sources: { repos: ['agency/acme-shop'], youtrack_prefixes: ['SHOP'], slack_channels: [{ id: 'C0EXT00001', name: '#ext-acme' }], calendar_title_patterns: ['Acme'] } },
        { id: 'acme/retainer', umbrella: 'acme', company: 'acme', name: 'Support retainer', status: 'done', sources: { calendar_title_patterns: ['Support'] } },
        { id: 'acme/admin', umbrella: 'acme', name: 'Acme admin', sources: {} },
        { id: 'beta/portal', umbrella: 'beta', name: 'Dealer portal', sources: { jira_keys: ['BP'] } },
        { id: 'beta/legacy', umbrella: 'beta', name: 'Old name', status: 'alias', alias_of: 'beta/portal', sources: { calendar_title_patterns: ['Legacy'] } },
      ],
    }),
  );
  writeFileSync(
    join(ann, 'people.json'),
    JSON.stringify([
      { person_id: 'me', name: 'Mara Keller', identities: ['mara@agency.example'] },
      { person_id: 'ana-berg', name: 'Ana Berg', company: 'acme', identities: ['ana@acme.example', 'slack:ana'], marker: { type: 'narrow', initiatives: ['acme/shop', 'acme/retainer'] } },
      { person_id: 'rui-rosa', name: 'Rui Rosa', company: 'acme', identities: ['slack:Rui Rosa'], marker: { type: 'exclusive', initiatives: ['acme/shop'] } },
      { person_id: 'tom-hale', name: 'Tom Hale', identities: ['tom@beta.example'], marker: { type: 'broad', initiatives: ['beta/legacy'] } },
    ]),
  );
  writeFileSync(join(ann, 'rules.json'), JSON.stringify([{ id: 'r-late', when: { container: '#late' }, then: { initiative: 'beta/portal' }, created: '2026-09-08T18:00:00Z' }]));
  writeFileSync(join(ann, 'attribution.json'), JSON.stringify({ subject: 'me', admin: { acme: 'acme/admin' } }));
  const meta: DatasetMeta = {
    name: 'stage0-test',
    kind: 'synthetic',
    tenant: 'agency',
    tz: 'UTC',
    since: DAY,
    until: '2026-09-08',
    subject: 'me',
    createdAt: at('00:00'),
    sourceStore: 'test',
    labelSpace: { initiatives: ['acme/shop', 'acme/retainer', 'acme/admin', 'beta/portal'], umbrellas: {}, people: ['me', 'ana-berg', 'rui-rosa', 'tom-hale'] },
    counts: {},
  };
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
  const db = openStore(join(dir, 'store.sqlite'));
  const meeting = db.prepare('INSERT INTO meetings (ref, source, account, id, title, start, "end", attendees, transcript, call_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  // call 1: Gemini glued two invitees into one chip; Granola lists only the subject; the calendar entry names Tom
  meeting.run('gmeet:a:m1', 'gmeet', 'a', 'm1', 'Acme weekly', at('10:00'), at('10:00'), JSON.stringify([{ email: '', name: 'Ana Berg Rui Rosa' }]), '', 'call:gmeet:a:m1');
  meeting.run('granola:a:m2', 'granola', 'a', 'm2', 'Acme weekly', at('10:01'), at('10:40'), JSON.stringify([{ email: 'mara@agency.example', name: 'Mara Keller' }]), 'Me: hello\nThem: hi', 'call:gmeet:a:m1');
  // call 2: two copies, only one title routes; nobody resolvable
  meeting.run('wispr:a:m3', 'wispr', 'a', 'm3', 'Instant meeting', at('14:00'), at('14:30'), '[]', '', 'call:wispr:a:m3');
  meeting.run('granola:a:m4', 'granola', 'a', 'm4', 'Acme sync', at('14:00'), at('14:30'), '[]', '', 'call:wispr:a:m3');
  db.prepare('INSERT INTO events (ref, source, account, start, "end", title, attendees, organizer) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('gcal:a:e1', 'gcal', 'a', at('10:05'), at('10:45'), 'Acme  Weekly!', JSON.stringify(['tom@beta.example']), 'mara@agency.example');
  db.prepare('INSERT INTO message_people (ref, person_id, role) VALUES (?, ?, ?)').run('slack:T1:D0DM000001:1.0', 'rui-rosa', 'to');
  db.close();
  return dir;
}

const call = (id: string, ref: string, title: string, start: string, end: string): FragmentUnit => ({ id, day: DAY, kind: 'call', start, end, minutes: 30, title, source: ref.split(':')[1]!, container: null, participants: ['me'], projectKeys: [], repo: null, weight: 1, refs: [ref], text: '' });
const FRAGS: FragmentUnit[] = [
  call(`frag-${DAY}-call-gmeet-aaa`, 'meeting:gmeet:m1', 'Acme weekly', at('10:00'), at('10:00')),
  call(`frag-${DAY}-call-granola-bbb#1`, 'meeting:granola:m2', 'Acme weekly — Checkout', at('10:01'), at('10:40')),
  call(`frag-${DAY}-call-wispr-ccc`, 'meeting:wispr:m3', 'Instant meeting', at('14:00'), at('14:30')),
  call(`frag-${DAY}-call-granola-ddd`, 'meeting:granola:m4', 'Acme sync', at('14:00'), at('14:30')),
  { id: `frag-${DAY}-work-eee`, day: DAY, kind: 'work', start: at('10:50'), end: at('11:20'), minutes: 30, title: 'commits', source: 'activity', container: 'agency/acme-shop', participants: [], projectKeys: [], repo: 'agency/acme-shop', weight: 1, refs: ['activity:git:1'], text: 'fix checkout' },
  { id: `frag-${DAY}-thread-fff`, day: DAY, kind: 'thread', start: at('16:00'), end: at('16:10'), minutes: 10, title: 'dm:@ana', source: 'slack', container: 'dm:@ana', participants: ['me'], projectKeys: [], repo: null, weight: 1, refs: ['slack:T1:D0DM000001:1.0'], text: 'me: the private repo is ready' },
];

const msg = (id: string, o: Partial<ItemUnit> = {}): ItemUnit => ({ id, day: DAY, ts: at('09:00'), type: 'message', source: 'slack', account: 'T1', container: '#renamed', thread: null, author: 'Ana Berg', authorPerson: 'ana-berg', isBot: false, participants: [], toPersons: [], subject: null, text: '', keys: [], ...o });
const ITEMS: ItemUnit[] = [
  msg('slack:T1:C0EXT00001:100.0', { thread: 'slack:T1/C0EXT00001/100.0', text: 'SHOP-7 checkout is down', keys: ['SHOP-7'], ts: at('09:00') }),
  msg('slack:T1:C0EXT00001:101.0', { thread: 'slack:T1/C0EXT00001/100.0', text: 'on it', ts: at('09:05') }),
  msg('slack:T1:C0EXT00001:102.0', { thread: 'slack:T1/C0EXT00001/102.0', text: 'morning all', ts: at('09:10') }),
  { ...msg('youtrack:x:2-1#c5'), type: 'comment', source: 'youtrack', container: 'SHOP', thread: 'youtrack:x:2-1', keys: ['SHOP-1'], text: 'deployed' },
];

const ctxOf = (dir: string, pool: unknown[], state = new Map<string, unknown>(), memory: MemoryRow[] = []): DayCtx => {
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as DatasetMeta;
  return { dataset: meta, dir, day: DAY, pool: pool as never, memory, state, llm: null, log: () => {} };
};

test('calls: participants from every copy (glued split, calendar link), the call_id case, exclusive marker decides', () => {
  const dir = dataset();
  try {
    const s = stage0(ctxOf(dir, FRAGS));
    const f = s.fragment(FRAGS[1]!, FRAGS);
    assert.deepEqual([...f.participants].sort(), ['ana-berg', 'me', 'rui-rosa', 'tom-hale']);
    assert.equal(f.case, 'call:gmeet:a:m1');
    assert.equal(s.fragment(FRAGS[0]!, FRAGS).case, 'call:gmeet:a:m1'); // both recorder copies are one case
    assert.deepEqual([f.label, f.conf, f.rung], ['acme/shop', 0.95, 'excl:rui-rosa']);
    assert.deepEqual(f.cowork, ['acme/shop']); // the repo-decided work block 10 minutes after the call
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F3: a duplicate copy inherits its twin’s decision; a thread run gains its recipients (F5)', () => {
  const dir = dataset();
  try {
    const s = stage0(ctxOf(dir, FRAGS));
    const own = s.fragment(FRAGS[3]!, FRAGS);
    assert.deepEqual([own.label, own.conf, own.rung], ['acme/shop', 0.8, 'title:acme']);
    const twin = s.fragment(FRAGS[2]!, FRAGS);
    assert.deepEqual([twin.label, twin.conf, twin.rung], ['acme/shop', 0.8, 'title:acme']);
    assert.match(twin.hint, /twin copy/);
    assert.equal(twin.case, own.case);
    const run = s.fragment(FRAGS[5]!, FRAGS);
    assert.ok(run.participants.includes('rui-rosa'));
    assert.deepEqual([run.label, run.rung], ['acme/shop', 'excl:rui-rosa']);
    assert.equal(run.case, `run:dm:@ana:${DAY}`);
    assert.equal(s.fragment(FRAGS[4]!, FRAGS).case, `work:agency/acme-shop:${DAY}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('items: a reply inherits its root, the channel id routes a renamed channel, a ticket comment is its ticket', () => {
  const dir = dataset();
  try {
    const s = stage0(ctxOf(dir, ITEMS));
    const root = s.item(ITEMS[0]!, ITEMS);
    assert.deepEqual([root.label, root.rung], ['acme/shop', 'key:SHOP']);
    const reply = s.item(ITEMS[1]!, ITEMS);
    assert.deepEqual([reply.label, reply.rung], ['acme/shop', 'key:SHOP']);
    assert.ok(Math.abs(reply.conf - root.conf * 0.99) < 1e-9);
    assert.equal(reply.case, 'thread:slack:T1/C0EXT00001/100.0');
    const plain = s.item(ITEMS[2]!, ITEMS);
    assert.deepEqual([plain.label, plain.rung, plain.conf], ['acme/shop', 'channel:C0EXT00001', 0.95]);
    const comment = s.item(ITEMS[3]!, ITEMS);
    assert.deepEqual([comment.label, comment.rung, comment.conf, comment.case], ['acme/shop', 'key:SHOP', 0.98, 'ticket:youtrack:x:2-1']);
    assert.equal(channelIdOf('slack:T1:C0EXT00001:100.0'), 'C0EXT00001');
    assert.equal(channelIdOf('gmail:a:123'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the closed list and the cards: alias-resolved, admin bucket, done flag, alias cues on the target', () => {
  const dir = dataset();
  try {
    const s = stage0(ctxOf(dir, FRAGS));
    assert.deepEqual(s.labelSpace('t1-item'), ['acme/shop', 'acme/retainer', 'acme/admin', 'beta/portal', 'none', 'unregistered']);
    assert.deepEqual(s.labelSpace('t4-addressee'), ['me', 'ana-berg', 'rui-rosa', 'tom-hale', 'none']);
    const cards = new Map(s.cards().map((c) => [c.id, c]));
    assert.equal(cards.get('acme/retainer')!.done, true);
    assert.equal(cards.get('acme/shop')!.code, 'AC-SHOP');
    assert.ok(cards.get('acme/shop')!.cues.includes('#ext-acme') && cards.get('acme/shop')!.cues.includes('SHOP-'));
    assert.ok(cards.get('beta/portal')!.cues.includes('Legacy')); // the alias's pattern
    assert.deepEqual(cards.get('beta/portal')!.people, []); // a broad person is no card's marker person
    assert.deepEqual(cards.get('acme/shop')!.people, ['Rui Rosa', 'Ana Berg']); // exclusive first
    assert.equal(cards.get('acme/admin')!.umbrella, 'acme');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the stage0 variant: floor labels, case questions, and an audit that demotes a rung instance overnight', async () => {
  const dir = dataset();
  try {
    const state = new Map<string, unknown>();
    const day1 = await stage0Variant.decide('t1-item', ITEMS, ctxOf(dir, ITEMS, state));
    const p = day1.find((x) => x.id === ITEMS[2]!.id)!;
    assert.deepEqual([p.label, p.rung, p.ask], ['acme/shop', 'channel:C0EXT00001', { group: 'thread:slack:T1/C0EXT00001/102.0', guess: 'acme/shop', form: 'confirm' }]);
    // an audit says the channel was wrong for that message: the instance falls below τ for the next day
    const audit: MemoryRow = { id: ITEMS[2]!.id, task: 't1-item', day: DAY, label: 'acme/retainer', source: 'human', audit: true, answer: `${DAY}:audit:x`, predicted: 'acme/shop', conf: 0.95, rung: 'channel:C0EXT00001' };
    await stage0Variant.nightly!('t1-item', ctxOf(dir, ITEMS, state, [audit]));
    const next = msg('slack:T1:C0EXT00001:200.0', { day: '2026-09-08', ts: at('09:00', '2026-09-08'), thread: 'slack:T1/C0EXT00001/200.0', text: 'deploy done' });
    const day2 = await stage0Variant.decide('t1-item', [next], ctxOf(dir, [next], state));
    assert.equal(day2[0]!.label, 'acme/shop');
    assert.ok(day2[0]!.conf < 0.95, `conf ${day2[0]!.conf}`);
    // a machine row never moves it back
    await stage0Variant.nightly!('t1-item', ctxOf(dir, ITEMS, state, [audit, { ...audit, id: next.id, label: 'acme/shop', source: 'machine', audit: false, answer: undefined }]));
    assert.deepEqual(stage0(ctxOf(dir, [], state)).instances!().map((i) => [i.instance, i.right, i.wrong]), [['channel:C0EXT00001', 0, 1]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rulesAsOf=day keeps a rule out of the days before it was written', async () => {
  const dir = dataset();
  try {
    const u = { ...msg('slack:T1:C0LATE0001:1.0'), container: '#late' };
    const late = { ...u, id: 'slack:T1:C0LATE0001:2.0', day: '2026-09-09' };
    process.env.LAB_OPT_rulesAsOf = 'day';
    const s = stage0(ctxOf(dir, [u, late]));
    assert.equal(s.item(u, [u]).label, null); // the rule was written on the 8th
    assert.equal(s.item(late, [late]).label, 'beta/portal');
    delete process.env.LAB_OPT_rulesAsOf;
    assert.equal(stage0(ctxOf(dir, [u])).item(u, [u]).label, 'beta/portal'); // default: the tenant as given
  } finally {
    delete process.env.LAB_OPT_rulesAsOf;
    rmSync(dir, { recursive: true, force: true });
  }
});
