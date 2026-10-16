// K2a keeps K+g (design §3.7): one haiku call a day pre-fills the guesses of the day's top ≤10 question groups, as
// `confirm`. It runs AFTER the umbrella-first regrouping, so the model guesses the groups the person is actually asked
// ("these N items of <client> today") — K's own pass (keys.ts guessTopGroups, not exported) would guess K's groups,
// which K2a may have dissolved. Same call, same cards and closed list (keys/guess.ts, judge/cards via stage0 cards()).
// The guess only sets ask.guess / ask.form: never a label, never a decision, never evidence.

import type { DayCtx, Prediction, TaskId, Unit } from '../../types.js';
import { GUESSABLE, MAX_GUESS_GROUPS, guessGroups, type GuessGroup } from '../keys/guess.js';
import { TYPES } from '../keys/spec.js';
import type { Stage0 } from '../stage0/index.js';

/** What a group's members share, in the prompt's words. */
export function sharedKey(group: string): string {
  const base = group.replace(/#\d+$/, '');
  if (base.startsWith('umb:')) return `client ${base.split(':')[1]}, one day`;
  const i = base.indexOf('=');
  return i > 0 && base.slice(0, i) in TYPES ? base.slice(0, i) : 'case';
}

export async function guessTop(task: TaskId, units: Unit[], preds: Prediction[], tau: number, fl: Stage0, ctx: DayCtx): Promise<number> {
  if (!ctx.llm || !GUESSABLE.has(task)) return 0;
  const groups = new Map<string, { value: number; members: Prediction[] }>();
  for (const p of preds) {
    if (!p.ask?.group || (p.label !== null && p.conf >= tau)) continue;
    const g = groups.get(p.ask.group) ?? { value: 0, members: [] };
    g.value += p.ask.value ?? 0;
    g.members.push(p);
    groups.set(p.ask.group, g);
  }
  if (!groups.size) return 0;
  const top = [...groups.entries()].sort(([ka, a], [kb, b]) => b.value - a.value || ka.localeCompare(kb)).slice(0, MAX_GUESS_GROUPS);
  const unitById = new Map(units.map((u) => [u.id, u]));
  const tags = new Map<string, string>();
  const asks: GuessGroup[] = top.map(([group, g], i) => {
    const tag = `g${i + 1}`;
    tags.set(tag, group);
    const members = [...g.members].sort((a, b) => (b.ask?.value ?? 0) - (a.ask?.value ?? 0) || a.id.localeCompare(b.id)).map((p) => unitById.get(p.id)!).filter(Boolean);
    return { tag, members, size: g.members.length, keyType: sharedKey(group), kGuess: g.members[0]?.ask?.guess ?? null };
  });
  const r = await guessGroups(ctx.llm, task, asks, fl.labelSpace(task), fl.cards());
  if (r.error) ctx.log(`k2a ${task} ${ctx.day}: guess call failed (${r.error.slice(0, 80)}) — the questions keep their own guesses`);
  for (const [tag, guess] of r.guesses) for (const p of groups.get(tags.get(tag)!)!.members) p.ask = { ...p.ask, guess, form: 'confirm' };
  return r.guesses.size;
}
