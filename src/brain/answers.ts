// Company brain: the answer log (design D4). For a turn that read or changed an `investigation` record the host
// logs what was asked and what was answered — from the turn it already ran, not from what the agent chose to
// write down — and answers "what did we say on this ticket, and did anything follow" from that log. Pure.

import type { BrainIndex } from './index.js';
import type { Provenance } from './uses.js';

export interface AnswerEntry {
  at: string; // ISO
  key: string; // the conversation
  turnId: string;
  asker?: string; // the platform's user id, when a person's message started the turn
  question: string; // as the sandbox received it (past the inbound scrub)
  answer: string; // as posted
  records: string[]; // the investigation records involved
  tickets: string[];
  link?: string; // the thread, when the surface has links
}

export function answerEntry(o: {
  at: string;
  key: string;
  turnId: string;
  asker?: string;
  question: string;
  answer: string;
  link?: string;
  used: readonly string[]; // records the turn read or changed
  index: BrainIndex;
}): AnswerEntry | undefined {
  const used = new Set(o.used);
  const inv = o.index.records.filter((r) => r.kind === 'investigation' && used.has(r.name));
  if (!inv.length) return undefined;
  return {
    at: o.at,
    key: o.key,
    turnId: o.turnId,
    ...(o.asker ? { asker: o.asker } : {}),
    question: o.question,
    answer: o.answer,
    records: inv.map((r) => r.name),
    tickets: [...new Set(inv.map((r) => r.ticket).filter((t): t is string => !!t))].sort(),
    ...(o.link ? { link: o.link } : {}),
  };
}

const norm = (s: string): string => s.trim().toLowerCase().replace(/\.md$/, '');

/** The logged answers for a ticket or a record name, oldest first. */
export function answersFor(entries: readonly AnswerEntry[], query: string): AnswerEntry[] {
  const q = norm(query);
  if (!q) return [];
  return entries
    .filter((e) => e.tickets.some((t) => norm(t) === q) || e.records.some((r) => norm(r) === q))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

export interface Later {
  count: number;
  last?: string; // ISO
}

const day = (iso: string | undefined): string => (iso ?? '').slice(0, 10);

// The tool's answer, as text the agent reads. `later` says what followed each answer in its conversation;
// `records` are the index rows the query names, with their provenance.
export function historyText(o: {
  query: string;
  answers: readonly AnswerEntry[];
  later: (e: AnswerEntry) => Later;
  records: readonly { name: string; kind?: string; status?: string; ticket?: string; provenance?: Provenance }[];
  maxAnswerChars?: number;
}): string {
  const cap = o.maxAnswerChars ?? 4000;
  const out: string[] = [];
  for (const r of o.records) {
    const p = r.provenance;
    const used = p?.uses ? `used in ${p.uses} turn${p.uses === 1 ? '' : 's'} started by a person (last ${day(p.lastUsed)})` : 'not used in a turn started by a person yet';
    const checked = p?.revisedAfterReply
      ? `revised after a person's reply on ${day(p.revisedAfterReply)}`
      : 'never revised after a person\'s reply — your own note, checked by nobody';
    out.push(`Record ${r.name}${r.kind ? ` (${r.kind}${r.status ? `, ${r.status}` : ''}${r.ticket ? `, ${r.ticket}` : ''})` : ' (no kind)'}: ${used}; ${checked}.`);
  }
  if (!o.answers.length) {
    out.push(`No logged answer for "${o.query}" in this project.`);
    return out.join('\n');
  }
  out.push(`${o.answers.length} logged answer${o.answers.length === 1 ? '' : 's'} for "${o.query}", oldest first:`);
  o.answers.forEach((e, i) => {
    const l = o.later(e);
    const followed = l.count ? `${l.count} later turn${l.count === 1 ? '' : 's'} in that conversation (last ${day(l.last)})` : 'no later turn in that conversation';
    out.push(
      '',
      `── ${i + 1}. ${day(e.at)}${e.link ? ` — ${e.link}` : ''} — ${followed}`,
      `Records: ${e.records.join(', ')}${e.tickets.length ? ` · Tickets: ${e.tickets.join(', ')}` : ''}`,
      `Asked: ${e.question.slice(0, 600)}`,
      `Answered: ${e.answer.length > cap ? `${e.answer.slice(0, cap)} … [cut, ${e.answer.length} characters]` : e.answer}`,
    );
  });
  return out.join('\n');
}
