// Stage 0 T2–T4 wired to a dataset: the roster from tenant/annotations/people.json and read-only SQL on store.sqlite.
// A fictional tenant (subject "lena-park"); every person, company and host is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../../sources/store.js';
import type { DatasetMeta, DayCtx, ItemUnit, MentionUnit } from '../../types.js';
import { dayEndMs, MailStats, t234 } from './t234.js';

const people = [
  { person_id: 'lena-park', name: 'Lena Park', identities: ['lena@acme.example', 'slack:Lena Park'] },
  { person_id: 'omar-haddad', name: 'Omar Haddad', identities: ['omar@acme.example', 'slack:Omar Haddad'] },
  { person_id: 'nina-voss', name: 'Nina Voss', identities: ['nina@client.example', 'slack:Nina Voss'] },
];

const meta: DatasetMeta = {
  name: 'fixture',
  kind: 'synthetic',
  tenant: 'acme',
  tz: 'Europe/Zurich',
  since: '2026-10-12',
  until: '2026-10-15',
  subject: 'lena-park',
  createdAt: '2026-10-15T20:00:00Z',
  sourceStore: 'test',
  labelSpace: { initiatives: [], umbrellas: {}, people: people.map((p) => p.person_id) },
  counts: {},
};

function dataset(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lab-t234-'));
  mkdirSync(join(dir, 'tenant', 'annotations'), { recursive: true });
  writeFileSync(join(dir, 'tenant', 'annotations', 'people.json'), JSON.stringify(people));
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
  const db = openStore(join(dir, 'store.sqlite'));
  const msg = db.prepare('INSERT INTO messages(ref, source, account, container, thread_id, ts, author_person, author_raw, subject, text, participants, is_bot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const mail = (ref: string, thread: string, ts: string, author: string, person: string | null, subject: string, text: string) =>
    msg.run(ref, 'gmail', 'lena@acme.example', 'inbox', thread, ts, person, author, subject, text, JSON.stringify([author, 'lena@acme.example']), 0);
  // A one-way sender: three mails, never answered.
  mail('gmail:a:1', 'gmail:a/t1', '2026-10-12T08:00:00Z', 'mara@deals.example', null, 'Big sale', 'Our autumn offers are here.');
  mail('gmail:a:2', 'gmail:a/t2', '2026-10-13T08:00:00Z', 'mara@deals.example', null, 'Bigger sale', 'More autumn offers.');
  mail('gmail:a:3', 'gmail:a/t3', '2026-10-14T08:00:00Z', 'mara@deals.example', null, 'Biggest sale', 'Even more offers.');
  // A correspondent: three mails, and Lena answered one of the threads.
  mail('gmail:a:4', 'gmail:a/t4', '2026-10-12T09:00:00Z', 'ivo@partner.example', null, 'Contract', 'Draft attached.');
  mail('gmail:a:5', 'gmail:a/t4', '2026-10-12T10:00:00Z', 'lena@acme.example', 'lena-park', 'Re: Contract', 'Thanks, I will read it.');
  mail('gmail:a:6', 'gmail:a/t5', '2026-10-13T09:00:00Z', 'ivo@partner.example', null, 'Contract v2', 'Second draft.');
  mail('gmail:a:7', 'gmail:a/t6', '2026-10-14T09:00:00Z', 'ivo@partner.example', null, 'Contract v3', 'Third draft.');
  // A newsletter from a role mailbox and one from a personal-looking mailbox.
  mail('gmail:a:8', 'gmail:a/t7', '2026-10-14T10:00:00Z', 'news@digest.example', null, 'Weekly digest', 'Top stories. Unsubscribe here.');
  mail('gmail:a:9', 'gmail:a/t8', '2026-10-14T11:00:00Z', 'ceo@startup.example', null, 'A quick note from our CEO', 'Try our product. Unsubscribe here.');
  // Chat: who writes where.
  const chat = (ref: string, container: string, thread: string, ts: string, person: string, author: string, text: string) =>
    msg.run(ref, 'slack', 'T1', container, thread, ts, person, author, '', text, JSON.stringify([author]), 0);
  chat('slack:T1:C1:1', '#launch', 'slack:T1/C1/1', '2026-10-14T07:00:00Z', 'omar-haddad', 'Omar Haddad', 'Launch plan is in the doc');
  chat('slack:T1:C1:2', '#launch', 'slack:T1/C1/2', '2026-10-14T07:05:00Z', 'nina-voss', 'Nina Voss', 'Looks good to me');
  db.close(); // the bench opens the store immutable: everything must be in the main file
  return dir;
}

const DIR = dataset();
const ctxOf = (day: string, state = new Map<string, unknown>()): DayCtx => ({ dataset: meta, dir: DIR, day, pool: [], memory: [], state, llm: null, log: () => {} });

function item(o: Partial<ItemUnit> & Pick<ItemUnit, 'id' | 'ts'>): ItemUnit {
  return {
    day: o.ts.slice(0, 10),
    type: 'message',
    source: 'slack',
    account: 'T1',
    container: '#launch',
    thread: o.id,
    author: 'Omar Haddad',
    authorPerson: 'omar-haddad',
    isBot: false,
    participants: [],
    toPersons: [],
    subject: null,
    text: '',
    keys: [],
    ...o,
  };
}

test('dayEndMs: the next local midnight, in UTC', () => {
  assert.equal(new Date(dayEndMs('2026-10-14', 'Europe/Zurich')).toISOString(), '2026-10-14T22:00:00.000Z');
  assert.equal(new Date(dayEndMs('2026-10-25', 'Europe/Zurich')).toISOString(), '2026-10-25T23:00:00.000Z', 'the day the clocks go back');
});

test('MailStats.oneWay: three mails, none answered by the subject — counted up to a moment, never ahead of it', () => {
  const s = new MailStats([
    { thread: 't1', t: 1, sender: 'a@x.example', subjectWrote: false },
    { thread: 't2', t: 2, sender: 'a@x.example', subjectWrote: false },
    { thread: 't3', t: 3, sender: 'a@x.example', subjectWrote: false },
    { thread: 't4', t: 1, sender: 'b@x.example', subjectWrote: false },
    { thread: 't4', t: 5, sender: 'me', subjectWrote: true },
    { thread: 't5', t: 2, sender: 'b@x.example', subjectWrote: false },
    { thread: 't6', t: 3, sender: 'b@x.example', subjectWrote: false },
  ]);
  assert.equal(s.oneWay('a@x.example', 2), false, 'two so far');
  assert.equal(s.oneWay('a@x.example', 3), true);
  assert.equal(s.oneWay('b@x.example', 4), true, 'not answered yet at 4');
  assert.equal(s.oneWay('b@x.example', 6), false, 'answered at 5');
});

test('one instance per run: every caller shares the roster, the stats and the clusters', () => {
  const state = new Map<string, unknown>();
  assert.equal(t234(ctxOf('2026-10-14', state)), t234(ctxOf('2026-10-15', state)));
});

test('senderClass: Slack bot ids, meetings, the one-way bulk rule from the store', () => {
  const s = t234(ctxOf('2026-10-14'));
  assert.equal(s.senderClass(item({ id: 'b1', ts: '2026-10-14T08:00:00Z', author: 'B0123ABCD', authorPerson: null })), 'bot');
  assert.equal(s.senderClass(item({ id: 'm1', ts: '2026-10-14T08:00:00Z', type: 'meeting', author: null, authorPerson: null })), 'human');
  const promo = (n: number, day: string) =>
    item({ id: `gmail:a:${n}`, ts: `${day}T08:00:00Z`, source: 'gmail', container: 'inbox', thread: `gmail:a/t${n}`, author: 'mara@deals.example', authorPerson: null, subject: 'Sale', text: 'Autumn offers.' });
  assert.equal(s.senderClass(promo(2, '2026-10-13')), 'human', 'two mails so far: still a person');
  assert.equal(s.senderClass(promo(3, '2026-10-14')), 'bulk');
  const ivo = item({ id: 'gmail:a:7', ts: '2026-10-14T09:00:00Z', source: 'gmail', container: 'inbox', thread: 'gmail:a/t6', author: 'ivo@partner.example', authorPerson: null, subject: 'Contract v3', text: 'Third draft.' });
  assert.equal(s.senderClass(ivo), 'human', 'the subject answered this sender');
});

test('mention: the resolver rungs, then `system` from the record behind an author; a spam campaign’s recipient is somebody', () => {
  const s = t234(ctxOf('2026-10-14'));
  const m = (o: Partial<MentionUnit> & Pick<MentionUnit, 'raw'>): MentionUnit => ({ id: `mention:${o.raw}`, day: '2026-10-14', field: 'author', source: 'gmail', ref: 'none', seen: 1, context: { container: 'inbox' }, production: null, ...o });
  const lena = s.mention(m({ raw: 'LENA@acme.example' }));
  assert.deepEqual([lena.label, lena.conf, lena.rung, lena.case], ['lena-park', 0.99, 'exact', 'form:lena@acme.example']);
  const digest = s.mention(m({ raw: 'news@digest.example', ref: 'gmail:a:8' }));
  assert.deepEqual([digest.label, digest.conf, digest.rung], ['system', 0.95, 'sender:bulk']);
  const ceo = s.mention(m({ raw: 'ceo@startup.example', ref: 'gmail:a:9' }));
  assert.deepEqual([ceo.label, ceo.conf, ceo.rung], ['system', 0.85, 'sender:bulk~'], 'a campaign from a personal-looking mailbox is a guess');
  const recipient = s.mention(m({ raw: 'someone@else.example', field: 'participant', ref: 'gmail:a:8', context: { container: 'spam' } }));
  assert.equal(recipient.label, null, 'the folder speaks for the sender, not for the recipients');
  const glued = s.mention(m({ raw: 'Lena Park Nina Voss', field: 'attendee', source: 'gmeet', context: { linkedEvent: { title: 'Sync', start: '', attendees: ['lena@acme.example', 'nina@client.example'] } } }));
  assert.deepEqual([glued.label, glued.conf, glued.split], ['lena-park+nina-voss', 0.95, ['lena-park', 'nina-voss']]);
});

test('kind: noise from integrations and small talk, a question for a firing alert, cues on the rest', () => {
  const s = t234(ctxOf('2026-10-14'));
  const bot = (id: string, text: string) => item({ id, ts: '2026-10-14T09:00:00Z', container: '#alerts', author: 'Shop Alert Bot', authorPerson: null, isBot: true, text });
  assert.equal(s.kind(bot('k1', 'RESOLVED: SiteDown: *https://www.shop.example*: back')).label, 'noise');
  assert.deepEqual(s.kind(bot('k2', 'CRITICAL: SiteDown: *https://www.shop.example*: down')).candidates, ['incident', 'noise']);
  assert.match(s.kind(bot('k3', 'RESOLVED: SiteDown: *https://www.shop.example*: back')).case, /^family:/);
  assert.equal(s.kind(item({ id: 'k4', ts: '2026-10-14T09:00:00Z', text: 'Thanks!' })).label, 'noise');
  const q = s.kind(item({ id: 'k5', ts: '2026-10-14T09:00:00Z', text: 'Can you check the launch numbers?' }));
  assert.equal(q.label, null);
  assert.deepEqual(q.cues, ['Q', 'R']);
});

test('addressee: the DM owner, an @mention, the author a reply answers, a vocative among the channel’s people', () => {
  const s = t234(ctxOf('2026-10-14'));
  const dm = s.addressee(item({ id: 'a1', ts: '2026-10-14T09:00:00Z', container: 'dm:@omar', participants: ['Omar Haddad', 'Lena Park'], text: 'Here is the launch deck' }));
  assert.deepEqual([dm.label, dm.rung], ['lena-park', 'explicit:dm']);
  const mention = s.addressee(item({ id: 'a2', ts: '2026-10-14T09:00:00Z', participants: ['Omar Haddad', 'Nina Voss'], text: '@Nina Voss please review the launch plan' }));
  assert.deepEqual([mention.label, mention.rung], ['nina-voss', 'explicit:mention']);
  const reply = s.addressee(item({ id: 'a3', ts: '2026-10-14T09:00:00Z', thread: 'th', text: 'Done, the numbers are in the sheet', context: [{ ref: 'r0', author: 'Nina Voss', ts: '2026-10-14T08:00:00Z', text: 'Where are the numbers' }] }));
  assert.deepEqual([reply.label, reply.rung], ['nina-voss', 'implicit']);
  const voc = s.addressee(item({ id: 'a4', ts: '2026-10-14T09:00:00Z', text: 'Nina, the plan moved to Friday' }));
  assert.deepEqual([voc.label, voc.rung], ['nina-voss', 'vocative'], 'Nina wrote in #launch');
  const bot = s.addressee(item({ id: 'a5', ts: '2026-10-14T09:00:00Z', author: 'Shop Alert Bot', authorPerson: null, isBot: true, text: 'RESOLVED: x' }));
  assert.deepEqual([bot.label, bot.conf], ['none', 0.95]);
});

test('dedup: clusters across days keep their first member’s name; family and hosts are separate outputs', () => {
  const state = new Map<string, unknown>();
  const s = t234(ctxOf('2026-10-13', state));
  const alert = (id: string, ts: string, state0: string, host = 'www.shop.example') =>
    item({ id, ts, container: '#alerts', author: 'Shop Alert Bot', authorPerson: null, isBot: true, text: `${state0}: SiteDown: *https://${host}*: Domain https://${host} is down (probe)` });
  const d1 = s.dedup([alert('x1', '2026-10-13T21:50:00Z', 'CRITICAL')]);
  assert.deepEqual(d1.get('x1'), { cluster: 'x1', conf: 0.97 });
  const day2 = [alert('x2', '2026-10-13T22:10:00Z', 'RESOLVED'), alert('y1', '2026-10-14T08:00:00Z', 'CRITICAL', 'www.other.example')];
  const d2 = t234(ctxOf('2026-10-14', state)).dedup(day2);
  assert.deepEqual(d2.get('x2'), { cluster: 'x1', conf: 0.95 }, 'a flap across midnight keeps yesterday’s name');
  assert.equal(d2.get('y1')!.cluster, 'y1');
  assert.equal(s.dedupVia!('x2'), 'flap');
  assert.equal(s.family(alert('f1', '2026-10-14T08:00:00Z', 'CRITICAL')), s.family(alert('f2', '2026-10-14T09:00:00Z', 'CRITICAL')));
  assert.notEqual(s.family(alert('f1', '2026-10-14T08:00:00Z', 'CRITICAL')), s.family(alert('f3', '2026-10-14T08:00:00Z', 'CRITICAL', 'www.other.example')), 'the host is part of the family');
  assert.deepEqual(s.hostsApps(alert('f1', '2026-10-14T08:00:00Z', 'CRITICAL')).hosts, ['www.shop.example']);
});
