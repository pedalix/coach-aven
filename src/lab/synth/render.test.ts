// The renderer's pure parts: batching (whole conversations, limits, no cross-batch waits), prompts that carry every
// beat's facts and never the truth, the validator (required / forbidden / invented keys and URLs), the patch of last
// resort, answer parsing, and a run against a fake model — no `claude`, no real data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, formatCopy } from './plan.js';
import {
  assemble, BATCH_LIMITS, batchPrompt, checkText, cleanRole, conversationKey, hasToken, jsonValues, keyPrefixes, meetingPrompt, parseCall, parseItems, patchText, planBatches, renderPlan, typoFor,
  type PromptCtx,
} from './render.js';
import type { Beat, PlannedItem } from './types.js';

const plan = buildPlan(1);
const byId = new Map(plan.items.map((i) => [i.id, i]));
const human = plan.items.filter((i) => i.render.mode === 'human');
const dayOf = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: plan.world.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
const batches = planBatches(plan.items, BATCH_LIMITS, dayOf);
const ctx: PromptCtx = { world: plan.world, byId, textOf: (id) => (byId.get(id)?.render.mode === 'template' ? (byId.get(id)!.text ?? undefined) : undefined) };
const beatOf = (it: PlannedItem): Beat => (it.render.mode === 'human' ? it.render.beat : assert.fail(`${it.id} is not a human item`));

test('batches: every human beat exactly once, conversations whole, within the limits', () => {
  const seen = new Map<string, string>();
  for (const b of batches) for (const c of b.convs) for (const id of c.items) {
    assert.ok(!seen.has(id), `${id} in ${seen.get(id)} and ${b.id}`);
    seen.set(id, b.id);
  }
  assert.equal(seen.size, human.length);
  const convBatches = new Map<string, Set<string>>();
  for (const b of batches) {
    const beats = b.convs.reduce((a, c) => a + c.items.length, 0);
    assert.ok(beats <= BATCH_LIMITS.chunk, `${b.id}: ${beats} beats`);
    if (b.convs.length > 1) assert.ok(beats <= BATCH_LIMITS.maxBeats && b.convs.length <= BATCH_LIMITS.maxConvs, b.id);
    if (b.kind === 'meeting' || b.kind === 'ticket') assert.equal(b.convs.length, 1, b.id);
    for (const c of b.convs) convBatches.set(c.key, new Set([...(convBatches.get(c.key) ?? []), b.id]));
    // Packed conversations share a source and a local day.
    assert.equal(new Set(b.convs.map((c) => `${byId.get(c.items[0]!)!.source}|${dayOf(byId.get(c.items[0]!)!.ts)}`)).size, 1, b.id);
  }
  for (const [key, set] of convBatches) assert.equal(set.size, 1, `${key} split over ${[...set].join(', ')}`);
  // Everything a writer has read is in the same batch → no batch waits for another (and so no cycles).
  assert.ok(batches.every((b) => b.deps.length === 0), batches.filter((b) => b.deps.length).map((b) => b.id).join(', '));
  assert.equal(conversationKey(byId.get(human.find((i) => i.type === 'comment')!.id)!), `ticket:${human.find((i) => i.type === 'comment')!.ref.split('#c')[0]}`);
});

test('prompts carry every beat, its required tokens and the forbidden ones — and never the truth', () => {
  const labels = plan.world.initiatives.map((i) => i.id);
  for (const b of batches) {
    const p = b.kind === 'meeting' ? meetingPrompt(byId.get(b.convs[0]!.items[0]!)!, ctx) : batchPrompt(b, ctx);
    for (const c of b.convs) for (const id of c.items) {
      const beat = beatOf(byId.get(id)!);
      if (b.kind !== 'meeting') assert.ok(p.includes(`[${id}]`), `${b.id}: ${id}`);
      for (const r of beat.required) assert.ok(p.includes(JSON.stringify(r)), `${b.id}: required ${r}`);
      if (b.kind === 'meeting') for (const t of beat.meeting!.topics) assert.ok(p.includes(`"${t.heading}"`), `${b.id}: heading ${t.heading}`);
    }
    for (const l of labels) assert.ok(!p.includes(l), `${b.id}: leaks ${l}`);
    for (const w of ['unregistered', 'storyline', 'decidable', 'tenant', 'the subject']) assert.ok(!p.toLowerCase().includes(w), `${b.id}: leaks "${w}"`);
  }
  assert.equal(cleanRole('co-founder and CTO; the subject (owner of this tenant)', 'Mara Keller'), 'co-founder and CTO');
  assert.equal(cleanRole("the subject's dentist (practice mailbox)", 'Mara Keller'), "Mara Keller's dentist (practice mailbox)");
});

const beat = (o: Partial<Beat> = {}): Beat => ({ brief: 'b', persona: 'lea-vogt', lang: 'de', register: 'neutral', required: [], forbidden: [], words: [5, 40], context: [], ...o });
const allowed = { prefixes: new Set(['ALP', 'SWL']), keys: new Set(['ALP-38']), urls: ['https://staging.alpenhof-hotels.example'] };

test('the validator: required verbatim, forbidden as whole words in any case, no invented keys or URLs', () => {
  const b = beat({ required: ['ALP-38', '@Claudia Steiner'], forbidden: ['ALP-31'] });
  assert.deepEqual(checkText('@Claudia Steiner ALP-38 ist erledigt.', b, allowed), []);
  assert.deepEqual(checkText('ALP-38 ist erledigt.', b, allowed), ['missing required token "@Claudia Steiner"']);
  assert.ok(checkText('@Claudia Steiner ALP-38 und alp-31.', b, allowed).includes('contains forbidden "ALP-31"'));
  assert.deepEqual(checkText('@Claudia Steiner ALP-38, nicht ALP-310 und auch kein UTF-8.', b, { ...allowed, keys: new Set(['ALP-38', 'ALP-310']) }), []);
  assert.ok(checkText('@Claudia Steiner ALP-38 hängt an SWL-77.', b, allowed).includes('invented ticket key "SWL-77"'));
  assert.ok(checkText('@Claudia Steiner ALP-38: https://evil.example/x', b, allowed).includes('invented URL "https://evil.example/x"'));
  assert.deepEqual(checkText('@Claudia Steiner ALP-38: https://staging.alpenhof-hotels.example/zimmer', b, allowed), []);
  assert.ok(checkText('@Claudia Steiner ALP-38 — the Initiative is clear.', b, allowed).includes('contains forbidden "initiative"'));
  assert.ok(hasToken('a bench test', 'bench') && !hasToken('a benchmark', 'bench'));
  assert.ok(checkText(`@Claudia Steiner ALP-38 ${'wort '.repeat(120)}`, b, allowed).some((p) => p.startsWith('too long')));
  // The patch of last resort: mentions in front, other tokens at the end, forbidden ones cut.
  assert.equal(patchText('Das ist erledigt, siehe ALP-31.', b), '@Claudia Steiner Das ist erledigt, siehe . (ALP-38)');
});

test('answers parse from JSON, fenced JSON or JSON inside prose; calls keep the planned headings and owners', () => {
  assert.deepEqual([...parseItems('```json\n{"items":[{"id":"[slack-1]","text":"a\\r\\nb"}]}\n```')], [['slack-1', 'a\nb']]);
  assert.deepEqual([...parseItems('Here you go: [{"id":"x","text":"y"}] done')], [['x', 'y']]);
  assert.equal(parseItems('no json at all').size, 0);
  // A model that corrects itself writes the fix last.
  assert.deepEqual([...parseItems('{"items":[{"id":"a","text":"first 🎂"}]}\n\nWait — emoji must be shortcodes. Corrected:\n\n{"items":[{"id":"a","text":"second"}]}')], [['a', 'second']]);
  assert.deepEqual(jsonValues('x {"a":1} y {not json} [2, {"b":"}"}]'), [{ a: 1 }, [2, { b: '}' }]]);
  const call = human.find((i) => i.type === 'meeting' && beatOf(i).meeting!.nextSteps.some((s) => s.due))!;
  const b = beatOf(call);
  const m = b.meeting!;
  const answer = {
    intro: 'Kurzer Überblick.',
    topics: m.topics.map((t) => ({ heading: `${t.heading} (renamed by the model)`, body: 'Ein Punkt. Noch einer.' })),
    next_steps: m.nextSteps.map(() => ({ owner: 'someone else', text: 'etwas erledigen' })),
    transcript: [...m.speakers, 'Narrator'].map((s) => ({ speaker: s, text: 'Wir haben das besprochen.' })),
  };
  const r = parseCall(JSON.stringify(answer), b, { prefixes: new Set(), keys: new Set(), urls: [] });
  assert.deepEqual(r.content!.topics.map((t) => t.heading), m.topics.map((t) => t.heading));
  assert.deepEqual(r.content!.nextSteps.map((s) => s.ownerLabel), m.nextSteps.map((s) => s.ownerLabel));
  assert.ok(r.problems.some((p) => p.startsWith('unknown speaker labels "Narrator"')));
  assert.ok(r.problems.some((p) => p.includes('must contain the due date')));
  assert.ok(r.problems.some((p) => p.startsWith('transcript is')));
  assert.ok(!r.content!.transcript.some((x) => x.speaker === 'Narrator'));
});

test('typo choice is a deterministic hash under the persona rate', () => {
  const a = human.map((i) => typoFor(i, plan.world));
  assert.deepEqual(human.map((i) => typoFor(i, plan.world)), a);
  const share = a.filter(Boolean).length / a.length;
  assert.ok(share > 0.02 && share < 0.15, `typo share ${share}`);
});

test('a run against a fake model: one retry fixes a missing token, derived texts and recorder copies follow', async () => {
  // A ticket batch (comments see the description) and a call with several recorder copies.
  const ticket = batches.find((b) => b.kind === 'ticket' && b.convs[0]!.items.length >= 3)!;
  const copies = plan.items.filter((i) => i.type === 'meeting' && i.render.mode === 'derived');
  const callBatch = batches.find((b) => b.kind === 'meeting' && copies.some((c) => c.meeting!.call === byId.get(b.convs[0]!.items[0]!)!.meeting!.call))!;
  const prompts: string[] = [];
  const llm = {
    async call(c: { system: string; prompt: string }) {
      prompts.push(c.prompt);
      if (c.system.includes('meeting')) {
        const it = byId.get(callBatch.convs[0]!.items[0]!)!;
        const m = beatOf(it).meeting!;
        const text = JSON.stringify({
          intro: `Überblick. ${beatOf(it).required.join(' ')}`,
          topics: m.topics.map((t) => ({ heading: t.heading, body: `Zu ${t.heading} wurde entschieden. Alle sind einverstanden.` })),
          next_steps: m.nextSteps.map((s) => ({ owner: s.ownerLabel, text: `${s.brief}${s.due ? ` ${s.due.slice(8, 10)}.${s.due.slice(5, 7)}.` : ''}`.replace(/(\d+) (\w{3})$/, '$1 $2') })),
          transcript: m.speakers.flatMap((s) => [{ speaker: s, text: 'Wir gehen das der Reihe nach durch und halten fest, wer was bis wann erledigt, damit nichts liegen bleibt.' }, { speaker: s, text: 'Einverstanden, so machen wir es, und wir schauen es nächste Woche nochmals an.' }]),
        });
        return { text, costUsd: 0.01, cached: false };
      }
      const ids = [...c.prompt.matchAll(/^ {2}\[([^\]]+)\] /gm)].map((x) => x[1]!).filter((id) => byId.get(id)?.render.mode === 'human');
      const retry = c.prompt.includes('Your previous answer');
      // First answer: the first beat drops its required tokens; the retry gets it right.
      return { text: JSON.stringify({ items: ids.map((id, i) => ({ id, text: `Text ${id}. ${!retry && i === 0 ? '' : beatOf(byId.get(id)!).required.join(' ')}`.trim() })) }), costUsd: 0.02, cached: false };
    },
  };
  const want = new Set([ticket.id, callBatch.id]);
  const { items, stats } = await renderPlan(plan.items, plan.world, { llm, only: (b) => want.has(b.id) });
  assert.equal(stats.failed.length, 0, stats.failed.join(', '));
  const needsRetry = beatOf(byId.get(ticket.convs[0]!.items[0]!)!).required.length > 0;
  assert.equal(stats.retried, needsRetry ? 1 : 0);
  assert.equal(stats.patchedBeats, 0);
  const out = new Map(items.map((i) => [i.id, i]));
  for (const id of ticket.convs[0]!.items) {
    const r = out.get(id)!;
    assert.ok(r.rendered && r.text!.startsWith(`Text ${id}.`), id);
    for (const tok of beatOf(r).required) assert.ok(r.text!.includes(tok), `${id}: ${tok}`);
  }
  // The comments' prompt shows the conversation's beats in order, each with what its writer has read.
  assert.ok(prompts[0]!.includes('Ticket ') && prompts[0]!.includes('ticket description'));
  const primary = out.get(callBatch.convs[0]!.items[0]!)!;
  assert.ok(primary.call && primary.rendered);
  for (const c of copies.filter((x) => x.meeting!.call === primary.meeting!.call)) {
    const r = out.get(c.id)!;
    assert.equal(r.text, formatCopy(c, primary.call).summary, `${c.id}: the copy is the call's content in its own style`);
  }
  assert.ok(stats.costUsd > 0);
  // Nothing else was rendered; assemble() leaves those texts null.
  const other = items.find((i) => i.render.mode === 'human' && !want.has(batches.find((b) => b.convs.some((c) => c.items.includes(i.id)))!.id))!;
  assert.equal(other.text, null);
  assert.equal(assemble(plan.items, new Map(), new Map()).filter((i) => i.rendered).length, plan.items.filter((i) => i.render.mode === 'template').length + plan.items.filter((i) => i.render.mode === 'derived' && byId.get(i.render.from)!.render.mode === 'template').length);
  assert.ok(keyPrefixes(plan.items).has('ALP'));
});
