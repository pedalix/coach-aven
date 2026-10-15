import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FragmentUnit, ItemUnit, MentionUnit } from '../../types.js';
import { CASE_MAX, closedList, coActivity, fragmentCard, itemCard, keyText, loadPeopleDir, mentionCard, registryCards, renderClosedList, rosterLines, t4Card, tenantCards, UNIT_MAX } from './cards.js';
import { seededShuffle } from './text.js';

// A fictional agency: two clients, one of them with a done project, an admin bucket, a person with a narrow marker.
function tenant(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lab-judge-cards-'));
  mkdirSync(join(dir, 'annotations'), { recursive: true });
  writeFileSync(
    join(dir, 'initiatives.json'),
    JSON.stringify({
      initiatives: [
        { id: 'acme/web', umbrella: 'acme', name: 'Acme Website relaunch', billing_code: 'A1', company: 'acme', sources: { slack_channels: ['#acme-web', { id: 'C0ACME', name: '#acme-shop' }], youtrack_prefixes: ['WEB'], repos: ['github.com/acme/acme-web'], calendar_title_patterns: ['Acme sync'] } },
        { id: 'acme/app', umbrella: 'acme', name: 'Acme App', status: 'done', sources: { jira_keys: ['APP'] } },
        { id: 'acme/admin', umbrella: 'acme', name: 'Admin (acme)', sources: {} },
        { id: 'globex/ops', umbrella: 'globex', name: 'Globex operations', sources: { hosts: ['status.globex.example'] } },
      ],
    }),
  );
  writeFileSync(
    join(dir, 'annotations', 'people.json'),
    JSON.stringify([
      { person_id: 'olive', name: 'Olive Owner', identities: ['olive@agency.example'] },
      { person_id: 'mara', name: 'Mara Quill', company: 'acme', identities: ['mara@acme.example'], marker: { type: 'narrow', initiatives: ['acme/web', 'acme/app'] } },
    ]),
  );
  return dir;
}

const SPACE = {
  initiatives: ['acme/web', 'acme/app', 'acme/admin', 'globex/ops'],
  umbrellas: { 'acme/web': 'acme', 'acme/app': 'acme', 'acme/admin': 'acme', 'globex/ops': 'globex' },
  people: ['olive', 'mara'],
};

test('tenant cards: names, done flags, codes, cues ({id,name} channels too) and marker people', () => {
  const dir = tenant();
  const people = loadPeopleDir(dir);
  const cards = tenantCards(dir, SPACE, people);
  const web = cards.find((c) => c.id === 'acme/web')!;
  assert.deepEqual(web, { id: 'acme/web', umbrella: 'acme', name: 'Acme Website relaunch', done: false, code: 'A1', cues: ['Acme sync', '#acme-web', '#acme-shop', 'WEB', 'acme-web', 'acme'], people: ['Mara Quill'] });
  assert.equal(cards.find((c) => c.id === 'acme/app')!.done, true);
  assert.deepEqual(cards.find((c) => c.id === 'globex/ops')!.cues, ['status.globex.example']);
  // the floor's bare stub cards are replaced; real ones are kept
  assert.equal(registryCards([{ id: 'acme/web', umbrella: 'acme', name: 'acme/web', done: false, cues: [], people: [] }], dir, SPACE, people)[0]!.name, 'Acme Website relaunch');
  const real = [{ id: 'acme/web', umbrella: 'acme', name: 'Web', done: false, cues: ['x'], people: [] }];
  assert.equal(registryCards(real, dir, SPACE, people), real);
});

test('the closed list: every id once, none and unregistered last, admin explained, tokens per label', () => {
  const dir = tenant();
  const list = closedList(tenantCards(dir, SPACE, loadPeopleDir(dir)), [...SPACE.initiatives, 'none', 'unregistered'], { admin: { acme: 'acme/admin' } });
  assert.deepEqual(list.ids, ['acme/web', 'acme/app', 'acme/admin', 'globex/ops', 'none', 'unregistered']);
  const text = renderClosedList(list);
  assert.match(text, /^acme\/web \| acme \| Acme Website relaunch \| A1 \| cues: Acme sync, #acme-web/);
  assert.match(text, /acme\/app \| acme \| Acme App \[done\]/);
  assert.match(text, /acme\/admin \| acme \| Admin \(acme\) \| admin bucket: invoices/);
  assert.match(text, /\nnone \| — \| not work[^\n]*\nunregistered \| — \| real work on a topic this list lacks/);
  assert.ok(list.tokens('acme/web').includes('web'));
  assert.ok(list.tokens('acme/web').includes('website'));
  // 'acme' is on three cards (a company cue, two names): it supports none of them over the others
  assert.ok(!list.tokens('acme/web').includes('acme'));
  assert.ok(!list.tokens('acme/app').includes('acme'));
  assert.ok(list.tokens('acme/admin').includes('invoice'));
  assert.deepEqual(list.tokens('none'), []);
  // pass B's permutation reorders the cards, never the tail
  const permuted = renderClosedList(list, seededShuffle(list.ids, 'B'));
  assert.match(permuted, /\nnone \| [^\n]*\nunregistered \| [^\n]*$/);
  assert.equal(permuted.split('\n').length, text.split('\n').length);
});

const frag = (id: string, kind: FragmentUnit['kind'], start: string, end: string, extra: Partial<FragmentUnit> = {}): FragmentUnit => ({
  id,
  day: '2026-01-05',
  kind,
  start,
  end,
  minutes: 30,
  title: 'Acme sync — Checkout',
  source: 'granola',
  container: null,
  participants: ['mara'],
  projectKeys: [],
  repo: null,
  weight: 1,
  refs: ['meeting:granola:REF-SECRET'],
  text: 'x',
  ...extra,
});

test('a call card: tags not ids, topics, co-activity (the timelog signal), weak hints, siblings, within budget', () => {
  const dir = tenant();
  const people = loadPeopleDir(dir);
  const t1 = frag('frag-2026-01-05-call-abc#1', 'call', '2026-01-05T10:00:00Z', '2026-01-05T11:00:00Z', { title: 'Acme sync — Checkout', weight: 0.6, text: '# Checkout\nThe promo fails, see https://shop.acme.example/promo?id=SECRET-PATH ' + 'long '.repeat(400) });
  const t2 = frag('frag-2026-01-05-call-abc#2', 'call', '2026-01-05T10:00:00Z', '2026-01-05T11:00:00Z', { title: 'Acme sync — Invoices', weight: 0.4, text: 'Invoice for September' });
  const work = frag('frag-2026-01-05-work-def', 'work', '2026-01-05T09:30:00Z', '2026-01-05T10:20:00Z', { title: 'acme/acme-web: 3 commits', repo: 'github.com/acme/acme-web', source: 'activity', participants: [] });
  const far = frag('frag-2026-01-05-work-far', 'work', '2026-01-05T15:00:00Z', '2026-01-05T16:00:00Z', { repo: 'github.com/acme/other', participants: [] });
  const pool = [t1, t2, work, far];
  const floors: Record<string, { label: string | null; conf: number; rung: string; candidates: string[]; hint: string; case: string }> = {
    [t1.id]: { label: null, conf: 0, rung: 'open', candidates: ['acme/web', 'acme/app'], hint: 'narrow via mara', case: 'call:abc' },
    [t2.id]: { label: 'acme/admin', conf: 0.97, rung: 'admin', candidates: ['acme/admin'], hint: '', case: 'call:abc' },
    [work.id]: { label: 'acme/web', conf: 0.99, rung: 'repo', candidates: ['acme/web'], hint: '', case: 'work:acme-web' },
    [far.id]: { label: 'acme/web', conf: 0.99, rung: 'repo', candidates: [], hint: '', case: 'work:other' },
  };
  const card = fragmentCard({ key: 'call:abc', units: [{ tag: 'u7', u: t1, floor: floors[t1.id]! }], pool, floorOf: (u) => floors[u.id]!, caseOf: (u) => floors[u.id]!.case, people, subject: 'olive', tz: 'UTC', tau: 0.95 });
  assert.ok(card.text.length <= CASE_MAX, `card is ${card.text.length} chars`);
  assert.doesNotMatch(card.text, /frag-2026|REF-SECRET|SECRET-PATH/); // ids and URL paths never reach the model
  assert.match(card.text, /^\[call\] Mon 01-05 10:00–11:00 · granola/);
  assert.match(card.text, /participants: Mara Quill \(acme; narrow: acme\/web, acme\/app\)/);
  assert.match(card.text, /co-activity \(subject's work ±60 min\): 09:30–10:20 acme-web → acme\/web/);
  assert.doesNotMatch(card.text, /15:00/); // outside the window
  assert.match(card.text, /topics: #1 Checkout \(60%\) · #2 Invoices \(40%\)/);
  assert.match(card.text, /weak hint \(may be wrong\): narrow via mara · candidates acme\/web, acme\/app/);
  assert.match(card.text, /hint \(decided today in this case\): "Invoices" → acme\/admin/);
  assert.match(card.text, /u7 \["Checkout" · 60% · 30 min\]: The promo fails, see shop\.acme\.example/);
  const u7 = card.text.split('\n').find((l) => l.startsWith('u7'))!;
  assert.ok(u7.length <= UNIT_MAX);
  assert.equal(card.fields.coactivity, '09:30–10:20 acme-web → acme/web');
  assert.deepEqual(coActivity(work, pool, (u) => floors[u.id]!, 'UTC', 0.95), []); // work blocks have none
});

const item = (id: string, extra: Partial<ItemUnit> = {}): ItemUnit => ({
  id,
  day: '2026-01-05',
  ts: '2026-01-05T09:00:00Z',
  type: 'message',
  source: 'slack',
  account: 'T0',
  container: '#acme-web',
  thread: 'th-1',
  author: 'Mara Quill',
  authorPerson: 'mara',
  isBot: false,
  participants: [],
  toPersons: ['olive'],
  subject: null,
  text: 'Could you look at WEB-12? https://shop.acme.example/x/y',
  keys: ['WEB-12'],
  ...extra,
});

test('item cards: a human thread with its earlier messages; a bot family by its representative', () => {
  const dir = tenant();
  const people = loadPeopleDir(dir);
  const floor = { label: null, conf: 0, rung: 'open', candidates: [], hint: '', case: 'thread:th-1' };
  const human = itemCard({ key: 'thread:th-1', units: [{ tag: 'u1', u: item('slack:T0:1'), floor }], thread: [{ author: 'Olive Owner', ts: '2026-01-05T08:50:00Z', text: 'Release today?' }], people, subject: 'olive', tz: 'UTC' });
  assert.match(human.text, /^\[slack message\] Mon 01-05 09:00 · #acme-web\nfrom: Mara Quill \(acme; narrow: acme\/web, acme\/app\)\nkeys: WEB-12\nearlier in thread: \[08:50 Olive Owner\] Release today\?\nu1 \[09:00\]: Could you look at WEB-12\? shop\.acme\.example$/);
  const bot = itemCard({ key: 'family:f1:2026-01-05', units: [{ tag: 'u2', u: item('slack:T0:2', { isBot: true, author: 'StatusBot', authorPerson: null, text: 'status.globex.example is down' }), floor }], family: { size: 7, sender: 'StatusBot', hosts: ['status.globex.example'], apps: [] }, thread: [], people, tz: 'UTC' });
  assert.match(bot.text, /^\[bot family · 7 items today\] slack/);
  assert.match(bot.text, /hosts: status\.globex\.example · apps: —/);
  assert.match(bot.text, /u2 \(representative of 7\)/);
});

test('item keys: tracker keys stay, links become hosts', () => {
  assert.equal(keyText('WEB-12'), 'WEB-12');
  assert.equal(keyText('station.acme.example?utm_campaign=x&y=z'), 'station.acme.example');
  assert.equal(keyText('www.acme.example*'), 'www.acme.example');
  assert.equal(keyText('https://shop.acme.example/promo/1'), 'shop.acme.example');
});

test('t4 and t3 cards, and the roster lines', () => {
  const people = loadPeopleDir(tenant());
  const c = t4Card('u3', item('slack:T0:3', { context: [{ ref: 'slack:T0:0', author: 'Olive Owner', ts: '2026-01-05T08:00:00Z', text: 'Deploy done' }] }), people, 'UTC');
  assert.match(c.text, /^u3 · slack message · Mon 01-05 09:00 · from Mara Quill \(acme; narrow: acme\/web, acme\/app\) \[mara\] · to: olive · in #acme-web\nearlier: \[Olive Owner\] Deploy done\ntext: Could you look/);
  const m: MentionUnit = { id: 'mention:attendee:1', day: '2026-01-05', raw: 'Mara Quill Olive Owner', field: 'attendee', source: 'gmeet', ref: 'meeting:gmeet:1', seen: 3, context: { title: 'Acme sync', linkedEvent: { title: 'Acme sync', start: '2026-01-05T10:00:00Z', attendees: ['mara@acme.example', 'olive@agency.example'] }, speakers: ['Mara'] }, production: null };
  assert.match(mentionCard('u1', m).text, /^u1 · "Mara Quill Olive Owner" · attendee · gmeet · seen 3×\ntitle: Acme sync\nlinked event "Acme sync": mara@acme\.example; olive@agency\.example\nspeakers: Mara$/);
  assert.deepEqual(rosterLines(['mara', 'ghost'], people, true), ['mara | Mara Quill | acme | mara@acme.example', 'ghost']);
});
