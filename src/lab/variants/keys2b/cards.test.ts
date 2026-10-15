import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FragmentUnit, ItemUnit } from '../../types.js';
import type { PersonInfo } from '../judge/cards.js';
import { blankFloor, earlierInThread, fragmentCheckCard, itemCheckCard } from './cards.js';

const PEOPLE = new Map<string, PersonInfo>([['pia', { id: 'pia', name: 'Pia Lund', company: 'nordwind', identities: [] }]]);

const item = (id: string, ts: string, text: string, extra: Partial<ItemUnit> = {}): ItemUnit => ({
  id,
  day: '2026-01-05',
  ts,
  type: 'comment',
  source: 'youtrack',
  account: 'yt',
  container: 'NW',
  thread: 'youtrack:yt:NW-7',
  author: 'Pia Lund',
  authorPerson: 'pia',
  isBot: false,
  participants: [],
  toPersons: [],
  subject: 'Stock levels lag behind the ERP',
  text,
  keys: ['NW-7'],
  ...extra,
});

test('an item card is J’s card with the thread before it — and never the floor’s label', () => {
  const pool = [item('yt:NW-7#c1', '2026-01-05T08:00:00Z', 'The bridge queue has a backlog since the import.'), item('yt:NW-7#c2', '2026-01-05T09:00:00Z', 'Scaling the worker now, see https://grafana.nordwind.example/d/abc?x=1')];
  const card = itemCheckCard('u3', pool[1]!, { pool, people: PEOPLE, tz: 'UTC' });
  assert.match(card, /subject: Stock levels lag behind the ERP/);
  assert.match(card, /keys: NW-7/);
  assert.match(card, /earlier in thread: \[08:00 Pia Lund\] The bridge queue has a backlog/);
  assert.match(card, /u3 \[09:00\]: Scaling the worker now, see grafana\.nordwind\.example/);
  assert.ok(!/weak hint|floor guess/.test(card), 'no floor guess, hint or candidates on the card');
  assert.ok(!card.includes('yt:NW-7'), 'no store ids');
  // the thread before an item: its own context lines and the pool's earlier items, ≤6, the root kept
  const long = Array.from({ length: 9 }, (_, i) => item(`m${i}`, `2026-01-05T0${i}:00:00Z`, `msg ${i}`));
  assert.deepEqual(
    earlierInThread(long[8]!, long).map((m) => m.text),
    ['msg 0', 'msg 3', 'msg 4', 'msg 5', 'msg 6', 'msg 7'],
  );
  assert.deepEqual(blankFloor({ participants: ['pia'] }), { label: null, conf: 0, rung: '', candidates: [], hint: '', participants: ['pia'] });
});

const frag = (id: string, kind: FragmentUnit['kind'], start: string, end: string, extra: Partial<FragmentUnit> = {}): FragmentUnit => ({
  id,
  day: '2026-01-05',
  kind,
  start,
  end,
  minutes: 30,
  title: kind === 'call' ? 'Nordwind weekly — stock bridge' : 'work',
  source: kind === 'call' ? 'gmeet' : kind === 'work' ? 'git' : 'slack',
  container: kind === 'work' ? 'nordwind/stock-bridge' : null,
  participants: ['pia'],
  projectKeys: [],
  repo: kind === 'work' ? 'nordwind/stock-bridge' : null,
  weight: 1,
  refs: [],
  text: kind === 'call' ? '## stock bridge\nThe queue lags; we scale the worker.' : 'fix: retry the bridge job',
  ...extra,
});

test('a fragment card hides the decisions of its own case but keeps other work blocks on the co-activity line', () => {
  const topic1 = frag('frag-call-1#1', 'call', '2026-01-05T10:00:00Z', '2026-01-05T10:30:00Z');
  const topic2 = frag('frag-call-1#2', 'call', '2026-01-05T10:00:00Z', '2026-01-05T10:30:00Z', { title: 'Nordwind weekly — checkout' });
  const work = frag('frag-work-1', 'work', '2026-01-05T09:30:00Z', '2026-01-05T09:55:00Z');
  const pool = [topic1, topic2, work];
  const floors: Record<string, ReturnType<typeof blankFloor> & { case: string }> = {
    [topic1.id]: { label: 'nordwind/shop', conf: 0.97, rung: 'rule:r-weekly', candidates: ['nordwind/shop'], hint: 'rule r-weekly', case: 'call:1', participants: ['pia'] },
    [topic2.id]: { label: 'nordwind/shop', conf: 0.97, rung: 'rule:r-weekly', candidates: ['nordwind/shop'], hint: 'rule r-weekly', case: 'call:1' },
    [work.id]: { label: 'nordwind/stock-sync', conf: 0.99, rung: 'repo:nordwind/stock-bridge', candidates: [], hint: 'repo', case: 'work:nordwind/stock-bridge:2026-01-05' },
  };
  const card = fragmentCheckCard('u1', topic1, { pool, floorOf: (u) => floors[u.id]!, people: PEOPLE, tz: 'UTC', tau: 0.95 });
  assert.match(card, /participants: Pia Lund \(nordwind\)/);
  assert.match(card, /topics: #1 stock bridge/);
  assert.match(card, /co-activity \(subject's work ±60 min\): 09:30–09:55 stock-bridge → nordwind\/stock-sync/);
  assert.ok(!card.includes('nordwind/shop'), 'neither its own floor label nor its case siblings’ decisions');
  assert.ok(!/weak hint|decided today in this case/.test(card));
});
