// K+g (design §3.7): one cheap model call a day pre-fills the questions K is about to ask, so the person confirms a
// guess instead of choosing from the whole list. The guess is a convenience for the person and nothing else:
//   - it only sets ask.guess and ask.form 'confirm' — never a label, never a decision;
//   - it is never evidence: the learner only ever sees the person's answer (a "yes" to the guess IS a human label;
//     the rubber-stamp risk is what audits measure);
//   - the closed list is the floor's label space with its registry cards — never the floor's candidates.
// Prompt building and parsing are pure; the call goes through ctx.llm (the bench's metered, cached runner).

import { parseJsonLoose } from '../../llm.js';
import { KINDS, type FragmentUnit, type ItemUnit, type LlmLike, type TaskId, type Unit } from '../../types.js';
import type { RegistryCard } from '../stage0/index.js';

export const GUESS_MODEL = 'haiku';
export const MAX_GUESS_GROUPS = 10;
const CARD_TEXT = 400;
const MEMBERS_SHOWN = 3;

export interface GuessGroup {
  tag: string; // g1 … g10 — the model never sees store ids
  members: Unit[]; // the members to show (the caller picks the most valuable few)
  size: number; // members in the group
  keyType: string; // what the group shares ('family', 'case', …)
  kGuess: string | null; // K's own best guess (shown as a weak hint)
}

/** The tasks K+g can guess for: the ones with a closed list a model can choose from. */
export const GUESSABLE: ReadonlySet<TaskId> = new Set<TaskId>(['t1-fragment', 't1-item', 't4-kind']);

const shortUrls = (s: string): string => s.replace(/<?(https?:\/\/)([^/\s|>]+)[^\s>]*>?/g, '$2');
const clip = (s: string, n: number): string => {
  const t = shortUrls(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function unitCard(u: Unit): string {
  if ('kind' in u && 'minutes' in u) {
    const f = u as FragmentUnit;
    return `${f.kind} · ${f.source}${f.container ? ` ${f.container}` : ''} · ${f.start.slice(0, 16)} · ${Math.round(f.minutes)} min · with ${f.participants.join(', ') || '—'}\n  title: ${clip(f.title, 160)}\n  ${clip(f.text, CARD_TEXT)}`;
  }
  const it = u as ItemUnit;
  return `${it.type} · ${it.source}${it.container ? ` ${it.container}` : ''} · ${it.ts.slice(0, 16)} · from ${it.author ?? '?'}${it.subject ? `\n  subject: ${clip(it.subject, 160)}` : ''}\n  ${clip(it.text, CARD_TEXT)}`;
}

function closedList(task: TaskId, labels: readonly string[], cards: readonly RegistryCard[]): string {
  if (task === 't4-kind') {
    return [
      'request — someone asks the reader to do something',
      'question — someone asks the reader for information',
      'commitment — someone promises to do something',
      'incident — something is broken, down or failing',
      'info — an update, an FYI, an answer; nothing to do',
      'noise — automated, bulk, small talk; nothing to read',
    ].join('\n');
  }
  const byId = new Map(cards.map((c) => [c.id, c]));
  return labels
    .map((id) => {
      const c = byId.get(id);
      if (!c) return id;
      const cues = c.cues.length ? ` | cues: ${c.cues.slice(0, 12).join(', ')}` : '';
      const people = c.people.length ? ` | people: ${c.people.slice(0, 6).join(', ')}` : '';
      return `${c.id} | ${c.umbrella} | ${c.name}${c.done ? ' [done]' : ''}${c.code ? ` | ${c.code}` : ''}${cues}${people}`;
    })
    .join('\n');
}

/** The closed list a guess must come from. */
export function guessSpace(task: TaskId, labelSpace: readonly string[]): string[] {
  return task === 't4-kind' ? [...KINDS] : [...labelSpace];
}

export function buildGuessPrompt(task: TaskId, groups: readonly GuessGroup[], labelSpace: readonly string[], cards: readonly RegistryCard[]): { system: string; prompt: string } {
  const what =
    task === 't4-kind'
      ? 'You propose the KIND of each group of incoming messages (one kind per group) for a person to confirm.'
      : 'You propose the INITIATIVE (billing project) of each group of work records of one tenant, for a person to confirm.';
  const system = [
    what,
    'A group is a set of records that share one key (a thread, a sender template, a host, a channel, a call). The person sees your guess and answers yes or corrects it.',
    '',
    'Closed list — answer with an id from it, exactly as written:',
    closedList(task, labelSpace, cards),
    ...(task === 't4-kind'
      ? []
      : ['', '"none" = not work, noise, nothing to attribute. "unregistered" = real work on a topic the list lacks — do not force a fit. "<umbrella>/admin" ids = invoices, contracts, payments, visas, taxes.']),
    '',
    'Judge by content and context. The "K guess" line is a weak hint and may be wrong.',
    'Answer with JSON only: [{"group":"g1","guess":"<id>","cite":"<at most 60 chars copied from the group>"}] — one entry per group.',
  ].join('\n');
  const prompt = groups
    .map((g) => {
      const shown = g.members.slice(0, MEMBERS_SHOWN).map((u) => `- ${unitCard(u)}`);
      const more = g.size > shown.length ? [`- … ${g.size - shown.length} more like these`] : [];
      return [`${g.tag} (${g.size} record${g.size === 1 ? '' : 's'}, shared key: ${g.keyType})${g.kGuess ? ` · K guess: ${g.kGuess}` : ''}`, ...shown, ...more].join('\n');
    })
    .join('\n\n');
  return { system, prompt };
}

/** The model's answer → tag → guess, keeping only known tags and ids from the closed list. */
export function parseGuesses(text: string, tags: readonly string[], space: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = parseJsonLoose(text);
  } catch {
    return out;
  }
  const rows = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && Array.isArray((parsed as { groups?: unknown }).groups) ? (parsed as { groups: unknown[] }).groups : [];
  const known = new Set(tags);
  const ids = new Set(space);
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const { group, guess } = r as { group?: unknown; guess?: unknown };
    if (typeof group === 'string' && typeof guess === 'string' && known.has(group) && ids.has(guess.trim()) && !out.has(group)) out.set(group, guess.trim());
  }
  return out;
}

/** One call for the day's top groups. A failed or unparseable call guesses nothing (K's questions stay 'choose'). */
export async function guessGroups(
  llm: LlmLike,
  task: TaskId,
  groups: readonly GuessGroup[],
  labelSpace: readonly string[],
  cards: readonly RegistryCard[],
): Promise<{ guesses: Map<string, string>; costUsd: number; error?: string }> {
  if (!groups.length) return { guesses: new Map(), costUsd: 0 };
  const space = guessSpace(task, labelSpace);
  const { system, prompt } = buildGuessPrompt(task, groups, space, cards);
  try {
    const r = await llm.call({ model: GUESS_MODEL, system, prompt, timeoutMs: 180_000 });
    if (r.error) return { guesses: new Map(), costUsd: r.costUsd || 0, error: r.error };
    return { guesses: parseGuesses(r.text, groups.map((g) => g.tag), space), costUsd: r.costUsd || 0 };
  } catch (err) {
    // No token, no CLI, a crashed runner: the questions simply stay K's own.
    return { guesses: new Map(), costUsd: 0, error: err instanceof Error ? err.message : String(err) };
  }
}
