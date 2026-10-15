// K2a "trust repair" (notes/20-iter2.md §K2a.1) — siblings: the other ACTIVE initiatives of an initiative's client.
//
// A structural rung maps ONE key or place to ONE initiative: `VN-…` → the shop, `#ext-alpenhof` → the relaunch, Jürg →
// the retainer. When that initiative's client runs others too (VN = shop + ERP sync + an unregistered portal; BKR =
// booker + booker support; the Alpenhof channel = relaunch + retainer), the route is right about the CLIENT and only a
// guess about the initiative: iteration 1 measured key:VN 51.6% and key:BKR 54% right, every error inside the umbrella.
//
// The client is the registry's `company` when the initiative names one, else its umbrella. On bench-agency both are the
// same; on a team tenant the umbrella is the billing frame of many clients ("bluefin" holds caldora, dorfberg, sanity …) and
// only the company says which initiatives compete for one tracker key or channel. (`--opt siblingScope=umbrella` reads
// "umbrella/company" as the umbrella alone — the ablation that shows what that costs on a team tenant.)
// Never siblings (in either direction): admin buckets (invoices are not a project), `personal`, aliases and splits (they
// resolve to a label), and initiatives that are not active (`done`, `planned`, `dormant`, `unknown` …; a registry that
// gives no status at all counts as active).
// Pure: the parsed registry in, a map out.

import type { Ini, Reg } from '../stage0/registry.js';

export interface Scope {
  id: string; // the label id
  scope: string; // the client: company, else umbrella
  umbrella: string; // the billing frame (what umbrella-level scoring compares)
  siblings: string[]; // the client's other active initiatives, registry order (empty: the route is the initiative)
}

/** Which grouping makes initiatives siblings: the client (default) or, as an ablation, the umbrella alone. */
export type SiblingScope = 'client' | 'umbrella';

const ACTIVE = /^(?:active)?$/i;

/** May work go to this initiative today? Active (or no status given), not done, not an alias or a split. */
export const isActive = (i: Ini): boolean => !i.aliasOf && !i.splitInto && !i.done && ACTIVE.test(i.status.trim());

/** The client of an initiative: its company when the registry names one, else its umbrella (`by: 'umbrella'`: the umbrella). */
export const clientOf = (i: Ini, by: SiblingScope = 'client'): string => (by === 'umbrella' ? i.umbrella : (i.company ?? i.umbrella));

/**
 * Every label id of the registry → its client and siblings. `excluded`: admin buckets and personal label ids (the
 * tenant's attribution.json and the `personal` umbrella) — they neither have nor are siblings.
 */
export function siblingIndex(reg: Reg, excluded: ReadonlySet<string>, by: SiblingScope = 'client'): Map<string, Scope> {
  const out = new Map<string, Scope>();
  const out_ = (i: Ini): boolean => excluded.has(i.id) || i.umbrella === 'personal';
  for (const id of reg.labelIds()) {
    const ini = reg.get(id);
    if (!ini) continue;
    const scope = clientOf(ini, by);
    const siblings = out_(ini) ? [] : reg.list.filter((i) => i.id !== id && isActive(i) && !out_(i) && clientOf(i, by) === scope).map((i) => i.id);
    out.set(id, { id, scope, umbrella: ini.umbrella, siblings });
  }
  return out;
}

/** The client a label belongs to, for the client-level calibration: a registry label's client; anything else itself. */
export function clientOfLabel(reg: Reg, label: string, by: SiblingScope = 'client'): string {
  const ini = reg.get(reg.label(label));
  return ini ? clientOf(ini, by) : label;
}
