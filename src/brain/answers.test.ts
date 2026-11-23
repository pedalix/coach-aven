import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from './index.js';
import { answerEntry, answersFor, historyText, type AnswerEntry } from './answers.js';

const rec = (front: string): string => `---\n${front}\n---\nBody.\n`;
const INDEX = buildIndex(
  {
    'glacier-12.md': rec('kind: investigation\nstatus: answered\nticket: GLACIER-12'),
    'glacier-20.md': rec('kind: investigation\nstatus: open'),
    'pricing.md': rec('kind: domain'),
    'counting.md': rec('kind: method'),
  },
  new Date('2026-05-01T08:00:00.000Z'),
);
const turn = { at: '2026-05-02T08:00:00.000Z', key: 'thread:1', turnId: 't1', question: 'Why was the voucher counted twice?', answer: 'The March export joins twice.', index: INDEX };

test('answerEntry — a turn that used an investigation record: the records, their tickets, the asker, the link', () => {
  assert.deepEqual(answerEntry({ ...turn, asker: 'U1', link: 'https://chat.example/t/1', used: ['pricing.md', 'glacier-12.md', 'glacier-20.md'] }), {
    at: turn.at,
    key: 'thread:1',
    turnId: 't1',
    asker: 'U1',
    question: turn.question,
    answer: turn.answer,
    records: ['glacier-12.md', 'glacier-20.md'],
    tickets: ['GLACIER-12'],
    link: 'https://chat.example/t/1',
  });
});

test('answerEntry — only domain or method records, or none: nothing is logged', () => {
  assert.equal(answerEntry({ ...turn, used: ['pricing.md', 'counting.md'] }), undefined);
  assert.equal(answerEntry({ ...turn, used: [] }), undefined);
});

const a = (at: string, key: string, answer: string): AnswerEntry => ({ at, key, turnId: `t-${at}`, question: 'q', answer, records: ['glacier-12.md'], tickets: ['GLACIER-12'] });
const LOG = [a('2026-05-09T08:00:00.000Z', 'thread:2', 'second'), a('2026-05-02T08:00:00.000Z', 'thread:1', 'first'), { ...a('2026-05-03T08:00:00.000Z', 'thread:3', 'other'), records: ['glacier-20.md'], tickets: [] }];

test('answersFor — by ticket or by record name, oldest first; another ticket is not returned', () => {
  assert.deepEqual(answersFor(LOG, 'glacier-12').map((e) => e.answer), ['first', 'second']);
  assert.deepEqual(answersFor(LOG, 'glacier-20.md').map((e) => e.answer), ['other']);
  assert.deepEqual(answersFor(LOG, 'GLACIER-99'), []);
  assert.deepEqual(answersFor(LOG, '  '), []);
});

test('historyText — two answers: each with its date and what followed; the record with its provenance', () => {
  const text = historyText({
    query: 'GLACIER-12',
    answers: answersFor(LOG, 'GLACIER-12'),
    later: (e) => (e.key === 'thread:2' ? { count: 3, last: '2026-05-11T09:00:00.000Z' } : { count: 0 }),
    records: [{ name: 'glacier-12.md', kind: 'investigation', status: 'answered', ticket: 'GLACIER-12', provenance: { uses: 4, lastUsed: '2026-05-09T08:00:00.000Z' } }],
  });
  assert.match(text, /^Record glacier-12\.md \(investigation, answered, GLACIER-12\): used in 4 turns started by a person \(last 2026-05-09\); never revised after a person's reply — your own note, checked by nobody\./);
  assert.match(text, /2 logged answers for "GLACIER-12", oldest first:/);
  assert.match(text, /── 1\. 2026-05-02 — no later turn in that conversation\n[\s\S]*Answered: first/);
  assert.match(text, /── 2\. 2026-05-09 — 3 later turns in that conversation \(last 2026-05-11\)\n[\s\S]*Answered: second/);
  assert.ok(text.indexOf('first') < text.indexOf('second'));
});

test('historyText — nothing logged; a revised record says when; a long answer is cut', () => {
  assert.match(historyText({ query: 'GLACIER-99', answers: [], later: () => ({ count: 0 }), records: [] }), /^No logged answer for "GLACIER-99" in this project\.$/);
  const rev = historyText({ query: 'counting', answers: [], later: () => ({ count: 0 }), records: [{ name: 'counting.md', kind: 'method', provenance: { uses: 1, lastUsed: '2026-05-02T00:00:00.000Z', revisedAfterReply: '2026-05-02T00:00:00.000Z' } }] });
  assert.match(rev, /used in 1 turn started by a person \(last 2026-05-02\); revised after a person's reply on 2026-05-02\./);
  const long = historyText({ query: 'GLACIER-12', answers: [a('2026-05-02T08:00:00.000Z', 'k', 'x'.repeat(50))], later: () => ({ count: 0 }), records: [], maxAnswerChars: 10 });
  assert.match(long, /Answered: x{10} … \[cut, 50 characters\]/);
});
