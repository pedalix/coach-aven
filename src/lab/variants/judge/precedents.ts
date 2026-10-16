// Precedents (design §4.7): how an answer reaches tomorrow's judgment in J. The model reads earlier HUMAN decisions
// on similar records as examples — the answer generalises through the model's reading, not through a key table.
//
//   pool        units of earlier days with a `human` or `seed` memory row (kept in ctx.state). NEVER `machine`
//               rows: the pipeline's own output is not evidence (design §0).
//   similarity  token Jaccard (EN/DE/RU/IT stopwords out) + .2 same container + .2 same series + .1 per shared
//               counterpart
//   split       pass A gets ranks 1–5, pass B ranks 6–10 (a seeded shuffle of the pool when it holds ≤10), so the
//               two framings stay independent and their agreement means something
//   format      `[label] (day) title — 200 chars`

import type { FragmentUnit, ItemUnit, MentionUnit, TaskId, Unit } from '../../types.js';
import { UNIT_OF } from '../../types.js';
import { clip, fold, hostsOnly, oneLine, seededShuffle, tokens } from './text.js';

export interface Summary {
  title: string;
  text: string; // ≤400 chars, URLs reduced to hosts
  container: string | null;
  series: string; // the recurring title: digits, dates and the "— topic" part removed
  counterparts: string[]; // person ids other than the subject
}

export interface Precedent extends Summary {
  id: string;
  label: string;
  day: string;
  source: 'human' | 'seed';
  toks: Set<string>;
}

/** A recurring title: "Weekly sync 12.10 — budget" and "Weekly sync 19.10 — hiring" are one series. */
export function seriesOf(title: string): string {
  const head = title.split(' — ')[0] ?? title;
  return fold(head)
    .replace(/^(re|fwd?|aw|wg|sv)\s*:\s*/g, '')
    .replace(/\d+([./:-]\d+)*/g, ' ')
    .replace(/[^\p{L}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function summaryOf(task: TaskId, u: Unit, subject?: string): Summary {
  const kind = UNIT_OF[task];
  if (kind === 'fragment') {
    const f = u as FragmentUnit;
    return { title: f.title, text: clip(oneLine(hostsOnly(f.text)), 400), container: f.container, series: f.kind === 'call' ? seriesOf(f.title) : (f.container ?? ''), counterparts: f.participants.filter((p) => p !== subject) };
  }
  if (kind === 'item') {
    const it = u as ItemUnit;
    const people = [...new Set([it.authorPerson, ...it.toPersons].filter((p): p is string => !!p && p !== subject))];
    return { title: it.subject ?? '', text: clip(oneLine(hostsOnly(it.text)), 400), container: it.container, series: seriesOf(it.subject ?? ''), counterparts: people };
  }
  const m = u as MentionUnit;
  return { title: m.context?.title ?? '', text: m.raw, container: m.context?.container ?? null, series: seriesOf(m.context?.title ?? ''), counterparts: [] };
}

const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
};

export function similarity(q: Summary & { toks?: Set<string> }, p: Precedent): number {
  const qt = q.toks ?? new Set(tokens(`${q.title} ${q.text}`));
  let s = jaccard(qt, p.toks);
  if (q.container && p.container && q.container === p.container) s += 0.2;
  if (q.series && p.series && q.series === p.series) s += 0.2;
  for (const c of q.counterparts) if (p.counterparts.includes(c)) s += 0.1;
  return s;
}

export class PrecedentPool {
  private byId = new Map<string, Precedent>();

  get size(): number {
    return this.byId.size;
  }

  /** A human (or seed) answer on a unit we kept a summary of; a later answer on the same unit replaces it. */
  add(id: string, label: string, day: string, source: 'human' | 'seed', s: Summary): void {
    this.byId.set(id, { ...s, id, label, day, source, toks: new Set(tokens(`${s.title} ${s.text}`)) });
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** Every precedent by similarity to `q` (best first; ties by recency, then id). */
  rank(q: Summary, exclude: ReadonlySet<string> = new Set()): { p: Precedent; sim: number }[] {
    const qq = { ...q, toks: new Set(tokens(`${q.title} ${q.text}`)) };
    return [...this.byId.values()]
      .filter((p) => !exclude.has(p.id))
      .map((p) => ({ p, sim: similarity(qq, p) }))
      .sort((a, b) => b.sim - a.sim || b.p.day.localeCompare(a.p.day) || a.p.id.localeCompare(b.p.id));
  }

  /** Pass A: ranks 1–5. Pass B: ranks 6–10, or a seeded draw of 5 when the pool is small (≤10). */
  forPasses(q: Summary, seed: string, exclude: ReadonlySet<string> = new Set(), k = 5): { a: Precedent[]; b: Precedent[] } {
    const ranked = this.rank(q, exclude).map((r) => r.p);
    const a = ranked.slice(0, k);
    const b = ranked.length > 2 * k ? ranked.slice(k, 2 * k) : seededShuffle(ranked, seed).slice(0, k);
    return { a, b };
  }
}

export const formatPrecedent = (p: Precedent): string => `[${p.label}] (${p.day}) ${clip(oneLine(p.title), 100)} — ${clip(oneLine(p.text), 200)}`;

/** Tokens of shown precedents carrying `label` that no shown precedent with another label has: what a precedent cite may lean on. */
export function distinctiveTokens(shown: readonly Precedent[], label: string): string[] {
  const mine = new Set<string>();
  const theirs = new Set<string>();
  for (const p of shown) for (const t of tokens(`${p.title} ${p.text}`, 4)) (p.label === label ? mine : theirs).add(t);
  return [...mine].filter((t) => !theirs.has(t));
}
