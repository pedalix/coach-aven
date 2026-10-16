import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caseKeyOf, splitOfUnit } from './cases.js';
import type { FragmentUnit, ItemUnit, MentionUnit, TaskId } from './types.js';

// A fictional tracker and chat: one ticket with two comments, two messages of one thread, a lone message,
// the topics of one call (with and without the exporter's call case), and a mention.
const item = (id: string, type: ItemUnit['type'], thread: string | null): ItemUnit => ({
  id,
  day: '2026-01-05',
  ts: '2026-01-05T09:00:00Z',
  type,
  source: type === 'message' ? 'slack' : 'youtrack',
  account: 'T0',
  container: type === 'message' ? '#acme-web' : 'WEB',
  thread,
  author: 'Mara Quill',
  authorPerson: 'mara',
  isBot: false,
  participants: [],
  toPersons: [],
  subject: null,
  text: 'fixture',
  keys: [],
});

const TICKET = 'youtrack:tracker.acme.example:WEB-7';

test('a ticket and its comments are one case, on one side of the split', () => {
  const ticket = item(TICKET, 'task', TICKET);
  const comments = [item(`${TICKET}#c101`, 'comment', TICKET), item(`${TICKET}#c102`, 'comment', TICKET)];
  for (const task of ['t1-item', 't2-dedup', 't4-kind', 't4-addressee'] as TaskId[]) {
    assert.equal(caseKeyOf(task, ticket), `ticket:${TICKET}`);
    for (const c of comments) {
      assert.equal(caseKeyOf(task, c), caseKeyOf(task, ticket), `${task}: ${c.id}`);
      assert.equal(splitOfUnit(task, c, c.id), splitOfUnit(task, ticket, ticket.id));
    }
  }
  // another ticket is another case
  assert.notEqual(caseKeyOf('t1-item', item('youtrack:tracker.acme.example:WEB-8', 'task', null)), caseKeyOf('t1-item', ticket));
});

test('messages go by thread, a lone message is its own case; fragments by call case or base id; mentions by id', () => {
  const a = item('slack:T0/C1/1', 'message', 'slack:T0/C1/1');
  const b = item('slack:T0/C1/2', 'message', 'slack:T0/C1/1');
  assert.equal(caseKeyOf('t1-item', a), 'thread:slack:T0/C1/1');
  assert.equal(caseKeyOf('t1-item', b), caseKeyOf('t1-item', a));
  assert.equal(caseKeyOf('t1-item', item('slack:T0/C1/9', 'message', null)), 'slack:T0/C1/9');
  const frag = (id: string, c?: string): FragmentUnit => ({
    id,
    day: '2026-01-05',
    kind: 'call',
    start: '2026-01-05T10:00:00Z',
    end: '2026-01-05T10:30:00Z',
    minutes: 15,
    title: 'Weekly sync',
    source: 'granola',
    container: null,
    participants: [],
    projectKeys: [],
    repo: null,
    weight: 0.5,
    refs: [],
    text: '',
    ...(c ? { case: c } : {}),
  });
  assert.equal(caseKeyOf('t1-fragment', frag('frag-2026-01-05-call-granola-abc#2')), 'frag-2026-01-05-call-granola-abc');
  assert.equal(caseKeyOf('t1-fragment', frag('frag-2026-01-05-call-gmeet-def#1', 'call:c1')), 'call:c1');
  const m: MentionUnit = { id: 'mention:author:x1', day: '2026-01-05', raw: 'Mara Q.', field: 'author', source: 'slack', ref: 'slack:T0/C1/1', seen: 1, context: {}, production: null };
  assert.equal(caseKeyOf('t3-identity', m), 'mention:author:x1');
});
