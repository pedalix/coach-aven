// K2b's cards: J's case cards (judge/cards.ts, design §4.2) for ONE unit each, so the check reads what J reads — subject,
// text with URLs cut to their host, the thread before it, participants with their markers, a call's topic list, the
// subject's co-activity — minus everything that names the label the check is supposed to question:
//   - the unit's own floor guess, rung, hint and candidates (a "weak hint: velonord/shop (key:VN)" line would anchor it);
//   - the floor's decisions on the other units of its case ("decided today in this case: … → velonord/shop"): the topics
//     of one call or the comments of one ticket were routed by the same rule.
// Work blocks of other cases keep their floor labels on the co-activity line (another rung's structure: the timelog
// signal J also shows). Pure.

import { fragmentCard, itemCard, type PersonInfo } from '../judge/cards.js';
import type { FragmentUnit, ItemUnit } from '../../types.js';
import type { Floor } from '../stage0/index.js';

type FloorLite = Pick<Floor, 'label' | 'conf' | 'rung' | 'candidates' | 'hint'> & { participants?: string[]; cowork?: string[] };

/** What the card may say of a unit's own floor: who took part and which structure sat next to it — not its label. */
export const blankFloor = (f?: { participants?: string[]; cowork?: string[] }): FloorLite => ({
  label: null,
  conf: 0,
  rung: '',
  candidates: [],
  hint: '',
  ...(f?.participants ? { participants: f.participants } : {}),
  ...(f?.cowork ? { cowork: f.cowork } : {}),
});

export interface ItemCardCtx {
  pool: readonly ItemUnit[]; // the day's items (earlier messages of the thread)
  people: ReadonlyMap<string, PersonInfo>;
  subject?: string;
  tz: string;
}

/** The thread before an item, as J builds it: its own context lines and the pool's earlier items (root first, ≤6). */
export function earlierInThread(u: ItemUnit, pool: readonly ItemUnit[]): { author: string | null; ts: string; text: string }[] {
  const earlier = [
    ...(u.context ?? []).map((m) => ({ id: m.ref, author: m.author, ts: m.ts, text: m.text })),
    ...(u.thread ? pool.filter((p) => p.thread === u.thread && p.ts < u.ts && p.id !== u.id).map((p) => ({ id: p.id, author: p.author, ts: p.ts, text: p.text })) : []),
  ];
  const uniq = [...new Map(earlier.map((m) => [m.id, m])).values()].sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));
  const kept = uniq.length > 6 ? [uniq[0]!, ...uniq.slice(-5)] : uniq;
  return kept.map(({ author, ts, text }) => ({ author, ts, text }));
}

export function itemCheckCard(tag: string, u: ItemUnit, c: ItemCardCtx): string {
  return itemCard({ key: tag, units: [{ tag, u, floor: blankFloor() }], thread: earlierInThread(u, c.pool), people: c.people, subject: c.subject, tz: c.tz }).text;
}

export interface FragmentCardCtx {
  pool: FragmentUnit[]; // the day's fragments (topic list, co-activity)
  floorOf: (u: FragmentUnit) => FloorLite & { case?: string }; // the floor of any pool unit
  people: ReadonlyMap<string, PersonInfo>;
  subject?: string;
  tz: string;
  tau: number;
}

export function fragmentCheckCard(tag: string, u: FragmentUnit, c: FragmentCardCtx): string {
  const own = c.floorOf(u);
  const key = own.case ?? u.id;
  const caseOf = (p: FragmentUnit): string => c.floorOf(p).case ?? p.id;
  // Same case: hidden (one rule routed them all). Another case: a work block keeps its label for the co-activity line.
  const shown = (p: FragmentUnit) => (p.id === u.id || caseOf(p) === key ? blankFloor() : c.floorOf(p));
  return fragmentCard({ key, units: [{ tag, u, floor: blankFloor(own) }], pool: c.pool, floorOf: shown, caseOf, people: c.people, subject: c.subject, tz: c.tz, tau: c.tau }).text;
}
