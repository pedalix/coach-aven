import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asksList, asksTranscript, type AskRow } from './audit.js';

const row = (over: Partial<AskRow>): AskRow => ({ dir: 'out', id: 'a'.repeat(24), slug: 'owen-ops', peer: 'bluefin/caldora', state: 'completed', createdAt: '2026-10-17T08:00:00.000Z', updatedAt: '2026-10-17T08:03:00.000Z', question: 'Why did orders drop on 2026-10-16?', ...over });

test('operator audit: held first, then newest; both directions, tenant, state, times, cost, the first lines', () => {
  const text = asksList([
    row({ answer: 'B2C orders dropped 40 % after the 14:10 deploy.', cost: 0.42 }),
    row({ dir: 'in', id: 'b'.repeat(24), slug: 'caldora', peer: 'home/owen-ops', tenant: 'T0CLIENT01', updatedAt: '2026-10-17T09:00:00.000Z', state: 'working' }),
    row({ id: 'c'.repeat(24), peer: 'northwind/ledger', state: 'held', why: 'data from bluefin', updatedAt: '2026-10-17T07:00:00.000Z' }),
  ]);
  const lines = text.split('\n');
  assert.match(lines[0]!, /the last 3, held first/);
  assert.match(lines[1]!, /^✋ owen-ops → northwind\/ledger · held · /);
  assert.match(lines[2]!, /— held: data from bluefin$/);
  assert.match(lines[3]!, /^⏳ caldora ← home\/owen-ops · working · 10-17 08:00 → 09:00 · tenant T0CLIENT01 · `b{24}`$/);
  assert.match(lines[5]!, /^✅ owen-ops → bluefin\/caldora · completed · 10-17 08:00 → 08:03 · \$0\.42 · `a{24}`$/);
  assert.match(lines[6]!, /“Why did orders drop on 2026-10-16\?” → “B2C orders dropped 40 % after the 14:10 deploy\.”/);
  assert.equal(asksList([]), 'No tasks between agents yet.');
});

test('a transcript: the record, and for a task answered here what its shadow conversation said', () => {
  const t = asksTranscript(row({ dir: 'in', slug: 'caldora', peer: 'home/owen-ops', answer: 'Because of the deploy.' }), [
    { at: '2026-10-17T08:01:00.000Z', op: 'post', id: 's1', view: { kind: 'status', line: '🛠', turnId: 't', notify: 'Working…' } },
    { at: '2026-10-17T08:03:00.000Z', op: 'update', id: 's1', view: { kind: 'answer', markdown: 'Because of the deploy.\nDetails …' } },
  ]);
  assert.match(t, /\*Task `a{24}`\* — caldora ← home\/owen-ops · completed/);
  assert.match(t, /\*The shadow conversation\*\n\*10-17 08:03 answer\*\n> Because of the deploy\.\n> Details …/);
  assert.match(asksTranscript(row({}), []), /the answering side keeps the transcript/);
});

test('a task that asked for a skill shows it, in the list and in the transcript (agent-skills)', () => {
  const r = row({ peer: 'bluefin/brand-studio', skill: 'brand-profile', cost: 0.1 });
  assert.match(asksList([r]).split('\n')[1]!, /^✅ owen-ops → bluefin\/brand-studio · completed · 10-17 08:00 → 08:03 · \$0\.10 · skill brand-profile · `a{24}`$/);
  assert.match(asksTranscript(r, []), /· completed · skill brand-profile/);
  assert.doesNotMatch(asksList([row({})]), /skill/);
});
