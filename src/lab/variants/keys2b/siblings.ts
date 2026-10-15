// K2b's closed list for one structural decision (notes/20-iter2.md §K2b; "siblings" as §K2a defines them): the decided
// initiative X, its SIBLINGS — the other active initiatives of X's umbrella or company, admin buckets and `personal`
// excluded — then `none` and `unregistered`. The list is what the content check may answer, so it is exactly the
// confusion iteration 1 measured: key:VN = shop | erp-sync | (an unregistered portal), key:BKR = booker | booker-support,
// the Alpenhof channel = relaunch | retainer. Errors outside the umbrella were rare; the check does not look there.
//
// "Active" is read as "not finished": a done/dormant/archived initiative is no sibling, a planned or unknown one is (it may
// already receive work — on a real tenant a planned P-code is billed before its status flips). Pure.

import { NONE, UNREGISTERED } from '../../types.js';

export interface SiblingSource {
  id: string; // a label id (alias-resolved)
  umbrella: string | null;
  company: string | null;
  status?: string; // the registry's status ('' / undefined = not given = active)
  done?: boolean;
  label?: boolean; // false for an alias or a split (never a label of its own)
}

const INACTIVE = /^(done|closed|finished|archived|completed|dormant|inactive|paused|cancell?ed)$/i;
const ADMIN_ID = /(^|\/)admin$/;

export interface SiblingOpts {
  admin?: Iterable<string>; // admin bucket ids (attribution.json `admin` values); ids ending in /admin count too
  personal?: Iterable<string>; // personal label ids; an umbrella named `personal` counts too
  umbrellas?: Readonly<Record<string, string>>; // fallback umbrella of an id the sources lack (dataset meta)
}

/** X → its siblings, in source order. An X the sources do not know gets the siblings of its fallback umbrella. */
export function siblingIndex(sources: readonly SiblingSource[], opts: SiblingOpts = {}): (x: string) => string[] {
  const admin = new Set(opts.admin ?? []);
  const personal = new Set(opts.personal ?? []);
  const byId = new Map<string, SiblingSource>();
  for (const s of sources) if (!byId.has(s.id)) byId.set(s.id, s);
  const eligible = [...byId.values()].filter(
    (s) => s.label !== false && !s.done && !INACTIVE.test(s.status ?? '') && !admin.has(s.id) && !ADMIN_ID.test(s.id) && !personal.has(s.id) && s.umbrella !== 'personal',
  );
  const memo = new Map<string, string[]>();
  return (x: string): string[] => {
    const hit = memo.get(x);
    if (hit) return hit;
    const me = byId.get(x);
    const umbrella = me?.umbrella ?? opts.umbrellas?.[x] ?? (x.includes('/') ? x.split('/')[0]! : null);
    const company = me?.company ?? null;
    const out = x === NONE || x === UNREGISTERED ? [] : eligible.filter((s) => s.id !== x && ((!!umbrella && s.umbrella === umbrella) || (!!company && s.company === company))).map((s) => s.id);
    memo.set(x, out);
    return out;
  };
}

/**
 * The closed list of one check: X and its siblings in a per-unit seeded order (`shuffle`), then none and unregistered —
 * so the model is not told which option the rule chose (the first option is not always X).
 */
export function checkOptions(x: string, siblings: (x: string) => string[], shuffle: (ids: string[]) => string[] = (ids) => ids): string[] {
  const inis = [...new Set([x, ...siblings(x)])].filter((id) => id !== NONE && id !== UNREGISTERED);
  return [...shuffle(inis), NONE, UNREGISTERED];
}
