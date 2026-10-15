import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LlmLike } from '../../types.js';
import { batchesOf, checkPrompt, checkSystem, parseVerdicts, PER_CALL, runChecks, type CheckUnit } from './check.js';

const LINES: Record<string, string> = {
  'nordwind/shop': 'nordwind/shop | nordwind | Online shop | cues: NW-, #ext-nordwind',
  'nordwind/stock-sync': 'nordwind/stock-sync | nordwind | Stock bridge to the ERP | cues: stock-bridge',
  'inhouse/booker': 'inhouse/booker | inhouse | Booking product | cues: BK-',
};
const lineOf = (id: string): string => LINES[id] ?? id;

const unit = (id: string, decided: string, options: string[], text: string, order = id): CheckUnit => ({ id, decided, options, order, card: (tag) => `[youtrack comment] Mon 01-05 09:00\n${tag} [09:00]: ${text}` });

test('the system text is tenant-free and the same for every call; the prompt lists each record with its own options', () => {
  const system = checkSystem();
  assert.ok(!/nordwind|inhouse/i.test(system));
  assert.match(system, /unregistered = real work/);
  assert.match(system, /none = not work/);
  const prompt = checkPrompt(
    [
      { tag: 'u1', options: ['nordwind/stock-sync', 'nordwind/shop', 'none', 'unregistered'], card: 'u1 [09:00]: stock levels lag behind the ERP' },
      { tag: 'u2', options: ['inhouse/booker', 'none', 'unregistered'], card: 'u2 [09:10]: thanks!' },
    ],
    lineOf,
  );
  // the registry lines of exactly the initiatives the batch's options name, sorted (no hint which one the rule chose)
  assert.equal(prompt.split('\n').slice(0, 4).join('\n'), ['INITIATIVES', LINES['inhouse/booker'], LINES['nordwind/shop'], LINES['nordwind/stock-sync']].join('\n'));
  assert.ok(prompt.includes('### u1 · options: nordwind/stock-sync | nordwind/shop | none | unregistered\nu1 [09:00]: stock levels'));
  assert.ok(prompt.includes('### u2 · options: inhouse/booker | none | unregistered'));
  assert.ok(prompt.trimEnd().endsWith('Answer with the JSON array for u1, u2.'));
});

test('parsing: known tags, first answer per tag, labels from that unit’s own options only', () => {
  const opts = new Map([
    ['u1', ['nordwind/shop', 'nordwind/stock-sync', 'none', 'unregistered']],
    ['u2', ['inhouse/booker', 'none', 'unregistered']],
    ['u3', ['inhouse/booker', 'none', 'unregistered']],
  ]);
  const text =
    'Sure:\n```json\n[{"unit":"u1","label":"Nordwind/Stock-Sync","cite":"stock levels lag behind the ERP and the shop shows sold-out bikes as available"},' +
    '{"unit":"u1","label":"nordwind/shop"},{"unit":"u2","label":"nordwind/shop","cite":"x"},{"unit":"u3","label":"none","cite":{"field":"text","span":"thanks!"}},{"unit":"u9","label":"none"}]\n```';
  const got = parseVerdicts(text, opts);
  assert.deepEqual([...got.keys()], ['u1', 'u3'], 'u2 answered off its list (no verdict), u9 is unknown');
  assert.equal(got.get('u1')!.label, 'nordwind/stock-sync');
  assert.equal(got.get('u1')!.cite.length, 60);
  assert.deepEqual(got.get('u3'), { label: 'none', cite: 'thanks!' });
  assert.equal(parseVerdicts('{"records":[{"unit":"u2","label":" unregistered "}]}', opts).get('u2')!.label, 'unregistered');
  assert.equal(parseVerdicts('{"unit":"u2","label":"none"}', opts).get('u2')!.label, 'none');
  assert.equal(parseVerdicts('no json here', opts).size, 0);
});

test('batches of 25 in the given order', () => {
  const xs = Array.from({ length: 53 }, (_, i) => i);
  assert.deepEqual(batchesOf(xs).map((b) => b.length), [25, 25, 3]);
  assert.equal(PER_CALL, 25);
  assert.deepEqual(batchesOf([1, 2, 3], 2), [[1, 2], [3]]);
  assert.deepEqual(batchesOf([], 25), []);
});

test('runChecks: ≤25 per call in time order, the spend split per unit, a failed call is no verdict (never a veto)', async () => {
  const units = Array.from({ length: 27 }, (_, i) => unit(`slack:T0:C1:${String(i).padStart(3, '0')}`, 'nordwind/shop', ['nordwind/shop', 'nordwind/stock-sync', 'none', 'unregistered'], i % 2 ? 'stock bridge lags' : 'checkout button', `2026-01-05T${String(10 + (i % 10)).padStart(2, '0')}:${String(i).padStart(2, '0')}`));
  const prompts: string[] = [];
  const llm: LlmLike = {
    call: async (c) => {
      prompts.push(c.prompt);
      assert.equal(c.model, 'haiku');
      assert.equal(c.system, checkSystem());
      const rows = [...c.prompt.matchAll(/^### (u\d+) · options: .*\n([\s\S]*?)(?=\n### u|\nAnswer with)/gm)].map((m) => ({ unit: m[1], label: /stock/.test(m[2]!) ? 'nordwind/stock-sync' : 'nordwind/shop', cite: 'x' }));
      return { text: JSON.stringify(rows), costUsd: 0.025, cached: false };
    },
  };
  const r = await runChecks(llm, units, lineOf);
  assert.equal(r.calls, 2);
  assert.equal(prompts.length, 2);
  assert.ok(prompts.every((p) => !p.includes('slack:T0')), 'store ids never reach the model');
  assert.equal(r.verdicts.size, 27);
  assert.equal(r.invalid.size, 0);
  const sizes = prompts.map((p) => (p.match(/^### u/gm) ?? []).length).sort((a, b) => b - a);
  assert.deepEqual(sizes, [25, 2]);
  const total = [...r.cost.values()].reduce((a, x) => a + x, 0);
  assert.ok(Math.abs(total - 0.05) < 1e-9, 'the two calls’ spend, split over the units they checked');
  assert.equal(r.verdicts.get(units[1]!.id)!.label, 'nordwind/stock-sync');
  assert.equal(r.verdicts.get(units[0]!.id)!.label, 'nordwind/shop');

  const failing: LlmLike = { call: async () => ({ text: '', costUsd: 0.002, cached: false, error: 'quota' }) };
  const f = await runChecks(failing, units.slice(0, 3), lineOf);
  assert.equal(f.verdicts.size, 0);
  assert.equal(f.invalid.size, 3);
  assert.deepEqual(f.errors, ['quota']);
  const throwing: LlmLike = { call: async () => Promise.reject(new Error('no token')) };
  const t = await runChecks(throwing, units.slice(0, 2), lineOf);
  assert.equal(t.invalid.size, 2);
  assert.match(t.errors[0]!, /no token/);
  let calls = 0;
  await runChecks({ call: async () => (calls++, { text: '[]', costUsd: 0, cached: false }) }, [], lineOf);
  assert.equal(calls, 0, 'nothing to check, no call');
});
