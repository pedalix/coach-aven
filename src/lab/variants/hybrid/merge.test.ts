import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Prediction } from '../../types.js';
import { leadGuess, merge, passesOf, spineNote, spineYield } from './merge.js';

const D = '2026-01-05';
const P = (id: string, label: string | null, conf: number, rung: string, extra: Partial<Prediction> = {}): Prediction => ({ id, label, conf, rung, ...extra });
const one = (w = 1) => () => w;
const by = (ps: Prediction[]) => new Map(ps.map((p) => [p.id, p]));

test('the spine at ≥ τ is final; J at ≥ τ decides the residue; both carry no question; J’s spend stays on the unit', () => {
  const spine = [P('s', 'acme/shop', 0.97, 'key:AC', { why: 'floor key:AC' }), P('j', 'acme/shop', 0.85, 'held:key:AC', { ask: { group: 'umb:acme:D', value: 0.15, guess: 'acme/shop', form: 'confirm' } })];
  const judge = [P('s', 'acme/shop', 0.97, 'key:AC', { ask: { group: 'x', value: 0 } }), P('j', 'acme/erp-sync', 0.96, 'judge:AA+g', { costUsd: 0.002, why: 'A=B acme/erp-sync' })];
  const { preds, stats } = merge(['s', 'j'], by(spine), by(judge), { day: D, tau: 0.95, weight: one() });
  assert.deepEqual(preds[0], { id: 's', label: 'acme/shop', conf: 0.97, rung: 'key:AC', why: 'floor key:AC' });
  assert.deepEqual(
    (({ label, conf, rung, costUsd, ask }) => ({ label, conf, rung, costUsd, ask }))(preds[1]!),
    { label: 'acme/erp-sync', conf: 0.96, rung: 'judge:AA+g', costUsd: 0.002, ask: undefined },
  );
  assert.match(preds[1]!.why!, /^A=B acme\/erp-sync · spine acme\/shop@0\.850 held:key:AC$/);
  assert.deepEqual([stats.spine, stats.judge, stats.questions], [1, 1, 0]);
});

test('a question: J’s label and conf, the spine’s client-day group, one conf-weighted guess per group, value (1 − conf)', () => {
  const umb = (v: number) => ({ group: `umb:acme:${D}`, value: v, guess: 'acme/shop', form: 'confirm' as const });
  const spine = [P('a', 'acme/shop', 0.85, 'held:key:AC', { ask: umb(0.15) }), P('b', 'acme/erp-sync', 0.6, 'sib:key:AC', { ask: umb(0.4) }), P('c', 'acme/shop', 0.85, 'held:key:AC', { ask: umb(0.15) })];
  const judge = [
    P('a', 'acme/erp-sync', 0.9, 'judge:AA+g', { ask: { group: 'ticket:1', value: 0.1 } }),
    P('b', 'acme/erp-sync', 0.85, 'judge:AA', { ask: { group: 'ticket:2', value: 0.15 } }),
    P('c', 'acme/shop', 0.93, 'judge:AA+g', { ask: { group: 'ticket:3', value: 0.07 }, costUsd: 0.001 }),
  ];
  const { preds, stats } = merge(['a', 'b', 'c'], by(spine), by(judge), { day: D, tau: 0.95, weight: one() });
  for (const p of preds) {
    assert.equal(p.ask!.group, `umb:acme:${D}`, 'the spine’s client-day question');
    assert.equal(p.ask!.guess, 'acme/erp-sync', 'erp-sync weighs .9 + .85 against the shop’s .93');
    assert.equal(p.ask!.form, 'confirm');
  }
  assert.deepEqual([preds[0]!.label, preds[0]!.conf, preds[0]!.rung, preds[0]!.ask!.value], ['acme/erp-sync', 0.9, 'judge:AA+g', 0.1]);
  assert.equal(preds[2]!.costUsd, 0.001);
  assert.match(preds[0]!.why!, /^spine acme\/shop@0\.850 held:key:AC · /);
  assert.deepEqual([stats.questions, stats.umbrella, stats.guessed], [3, 3, 2]);
});

test('outside client-day groups the question is J’s case (or, as an option, the spine’s group); J abstaining leaves the spine’s guess', () => {
  const spine = [P('x', null, 0, 'abstain', { ask: { group: 'thread=T1', value: 1.2, guess: null, form: 'choose' } }), P('y', 'beta/app', 0.8, 'guess:container', { ask: { group: 'container=#beta', value: 0.2, guess: 'beta/app', form: 'confirm' } })];
  const judge = [P('x', 'beta/app', 0.85, 'judge:AA', { ask: { group: 'thread:T1', value: 0.15 } }), P('y', null, 0, 'judge:invalid', { ask: { group: 'thread:T2', value: 1 } })];
  const a = by(merge(['x', 'y'], by(spine), by(judge), { day: D, tau: 0.95, weight: one() }).preds);
  assert.deepEqual([a.get('x')!.ask!.group, a.get('x')!.ask!.guess, a.get('x')!.label], ['thread:T1', 'beta/app', 'beta/app']);
  // J had no label: the unit keeps the spine's sub-τ guess as its label and as the question's guess
  assert.deepEqual([a.get('y')!.label, a.get('y')!.conf, a.get('y')!.rung, a.get('y')!.ask!.guess, a.get('y')!.ask!.group], ['beta/app', 0.8, 'guess:container', 'beta/app', 'thread:T2']);
  const b = by(merge(['x', 'y'], by(spine), by(judge), { day: D, tau: 0.95, weight: one(), groups: 'spine' }).preds);
  assert.deepEqual([b.get('x')!.ask!.group, b.get('y')!.ask!.group], ['thread=T1', 'container=#beta']);
  // nobody has a label: a 'choose' question
  const c = merge(['z'], by([P('z', null, 0, 'abstain')]), by([P('z', null, 0, 'judge:no-llm', { ask: { group: 'case:z', value: 1 } })]), { day: D, tau: 0.95, weight: one() }).preds[0]!;
  assert.deepEqual([c.label, c.rung, c.ask], [null, 'abstain', { group: 'case:z', value: 1, guess: null, form: 'choose' }], 'both abstain: the spine’s');
  assert.match(c.why!, /J judge:no-llm$/);
});

test('value: the spec’s (minutes or 1)·(1 − conf); "yield" adds what the spine’s own value held beyond its (1 − conf)', () => {
  // the spine valued its 30-minute question at 30·(1 − .85) + 2 (its key / ctx yield)
  const s = P('f', 'acme/shop', 0.85, 'held:rule:r', { ask: { group: 'call:1', value: 30 * 0.15 + 2, guess: 'acme/shop', form: 'confirm' } });
  const j = P('f', 'acme/shop', 0.9, 'judge:AA', { ask: { group: 'call:1', value: 3 } });
  assert.ok(Math.abs(spineYield(s, 30) - 2) < 1e-9);
  assert.equal(spineYield(P('n', null, 0, 'abstain'), 1), 0);
  const own = merge(['f'], by([s]), by([j]), { day: D, tau: 0.95, weight: one(30) }).preds[0]!;
  const yld = merge(['f'], by([s]), by([j]), { day: D, tau: 0.95, weight: one(30), value: 'yield' }).preds[0]!;
  assert.equal(own.ask!.value, 3);
  assert.equal(yld.ask!.value, 5);
});

test('fragments: J’s passes split inside one client → that client × day; client-day groups are chunked by value', () => {
  const split = (id: string, a: string, b: string, conf: number): Prediction => P(id, a, conf, 'judge:UU', { why: `A ${a} · B ${b} · R — · cite no arbiter`, ask: { group: `call:${id}`, value: 1 } });
  const ids = Array.from({ length: 14 }, (_, i) => `t${String(i).padStart(2, '0')}`);
  const judge = ids.map((id, i) => split(id, i % 2 ? 'acme/shop' : 'acme/erp-sync', i % 2 ? 'acme/erp-sync' : 'acme/shop', 0.5 - i * 0.01));
  const spine = ids.map((id) => P(id, null, 0, 'abstain', { ask: { group: `call:${id}`, value: 1 } }));
  const clientSplit = (j: Prediction): string | null => {
    const ab = passesOf(j);
    return ab && ab.a !== ab.b && ab.a.split('/')[0] === ab.b.split('/')[0] ? ab.a.split('/')[0]! : null;
  };
  const { preds, stats } = merge(ids, by(spine), by(judge), { day: D, tau: 0.95, weight: one(), clientSplit, max: 12 });
  const groups = new Map<string, string[]>();
  for (const p of preds) groups.set(p.ask!.group!, [...(groups.get(p.ask!.group!) ?? []), p.id]);
  assert.deepEqual([...groups.keys()].sort(), [`umb:acme:${D}`, `umb:acme:${D}#2`]);
  assert.equal(groups.get(`umb:acme:${D}`)!.length, 12);
  assert.deepEqual(groups.get(`umb:acme:${D}#2`), ['t00', 't01'], 'the least valuable (surest) members overflow');
  assert.equal(stats.splitUmbrella, 14);
  // a split across clients is not a client-day question
  const x = merge(['q'], by([P('q', null, 0, 'abstain')]), by([split('q', 'acme/shop', 'beta/app', 0.3)]), { day: D, tau: 0.95, weight: one(), clientSplit }).preds[0]!;
  assert.equal(x.ask!.group, 'call:q');
});

test('helpers: leadGuess ties, passesOf, spineNote', () => {
  assert.equal(leadGuess([{ guess: 'b', conf: 0.5 }, { guess: 'a', conf: 0.5 }]), 'a');
  assert.equal(leadGuess([{ guess: 'b', conf: 0.6 }, { guess: 'a', conf: 0.3 }, { guess: 'a', conf: 0.3 }]), 'b', 'equal weight: the surest member');
  assert.equal(leadGuess([{ guess: null, conf: 0.9 }]), null);
  assert.deepEqual(passesOf(P('u', 'x', 0.7, 'judge:AR', { why: 'A acme/shop · B acme/erp-sync · R acme/shop · cite token shop · pv 0123456789' })), { a: 'acme/shop', b: 'acme/erp-sync' });
  assert.equal(passesOf(P('u', 'x', 0.9, 'judge:AA', { why: 'A=B x · cite no cite' })), null);
  assert.equal(spineNote(P('u', null, 0.4, 'abstain')), 'spine —@0.000 abstain');
});

test('the gate (an ablation): a held-back judgment stays a question just under τ; an agreeing one decides', () => {
  const spine = [P('a', 'acme/shop', 0.85, 'held:key:AC'), P('b', null, 0, 'abstain')];
  const judge = [P('a', 'acme/shop', 0.97, 'judge:AA+g', { ask: { group: 'ticket:a', value: 0 } }), P('b', 'acme/shop', 0.97, 'judge:AA+g', { ask: { group: 'ticket:b', value: 0 } })];
  const gate = (s: Prediction | undefined, j: Prediction): boolean => !!s && s.label === j.label;
  const { preds, stats } = merge(['a', 'b'], by(spine), by(judge), { day: D, tau: 0.95, weight: one(), gate });
  assert.deepEqual([preds[0]!.conf, preds[0]!.ask], [0.97, undefined], 'J names the spine’s own guess: it decides');
  assert.deepEqual([preds[1]!.label, preds[1]!.conf, preds[1]!.rung, preds[1]!.ask?.guess], ['acme/shop', 0.949, 'judge:AA+g', 'acme/shop']);
  assert.match(preds[1]!.why!, /gated 0\.97/);
  assert.deepEqual([stats.judge, stats.gated, stats.questions], [1, 1, 1]);
});

test('probation (an ablation): one unit per J cell a day — the busiest cells first — is asked at the top of the queue', () => {
  const ids = ['p1', 'p2', 'p3', 'q1'];
  const spine = ids.map((id) => P(id, null, 0, 'abstain'));
  const judge = ids.map((id) => P(id, 'acme/shop', 0.96, id.startsWith('p') ? 'judge:AA+g' : 'judge:AA', { ask: { group: `t:${id}`, value: 0.04 } }));
  const cellOf = (id: string): string => (id.startsWith('p') ? 'item-human|AA+g' : 'item-human|AA');
  const { preds, stats } = merge(ids, by(spine), by(judge), { day: D, tau: 0.95, weight: one(), probe: { perDay: 1, cellOf } });
  const held = preds.filter((p) => p.ask);
  assert.equal(held.length, 1);
  assert.ok(held[0]!.id.startsWith('p'), 'the cell with the most units today');
  assert.ok(held[0]!.ask!.value! >= 100 && held[0]!.conf < 0.95);
  assert.match(held[0]!.why!, /probation 0\.96/);
  assert.deepEqual([stats.judge, stats.probed], [3, 1]);
  const two = merge(ids, by(spine), by(judge), { day: D, tau: 0.95, weight: one(), probe: { perDay: 2, cellOf } });
  assert.equal(two.stats.probed, 2);
});
