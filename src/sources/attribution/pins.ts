// Pinned rule decisions (OpenSpec attribution-pins-timelog). A `rule` decision follows the current rules
// until its day has closed; then it is pinned — decided once, with the rule and the rules version — so
// billed time never moves because a rule changed later. Pins live OUTSIDE the store (which is rebuilt
// from raw at will): `data/<slug>/attribution/pins.jsonl` on the bot host, append-only, last line per
// fragment id wins; an `unpinned_at` line (the redo command) releases a fragment to the ladder again.
// The tenant ledger still wins over a pin (plan.ts). Pure helpers + two tiny file functions.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { Attribution } from './ladder.js';
import type { Planned } from './plan.js';

export interface Pin {
  id: string;
  attributions: Attribution[];
  rule_id: string | null;
  rationale: string;
  /** sha256 of the rules, the registry and the people markers that decided (12 hex). */
  rules_version: string;
  pinned_at: string;
}
interface Unpin {
  id: string;
  unpinned_at: string;
}

/** Pure: the file's lines → the live pins (last line per id; an unpin line removes). Bad lines are skipped. */
export function parsePins(text: string): Map<string, Pin> {
  const out = new Map<string, Pin>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r: Partial<Pin & Unpin>;
    try {
      r = JSON.parse(line) as Partial<Pin & Unpin>;
    } catch {
      continue;
    }
    if (!r || typeof r.id !== 'string' || !r.id) continue;
    if (typeof r.unpinned_at === 'string') {
      out.delete(r.id);
      continue;
    }
    if (!Array.isArray(r.attributions) || typeof r.pinned_at !== 'string') continue;
    out.set(r.id, { id: r.id, attributions: r.attributions, rule_id: r.rule_id ?? null, rationale: r.rationale ?? '', rules_version: r.rules_version ?? '', pinned_at: r.pinned_at });
  }
  return out;
}

export function readPins(path: string): Map<string, Pin> {
  return existsSync(path) ? parsePins(readFileSync(path, 'utf8')) : new Map();
}

export function appendPinLines(path: string, lines: Array<Pin | Unpin>): void {
  if (!lines.length) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

export function rulesVersion(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 12);
}

/**
 * Pure: which `rule` fragments to pin now — those whose local day (`dayOf(start)`) is before `cutoff`, the
 * first still-open day (today minus pinAfterDays). Already pinned or ledger-decided fragments are never `rule`.
 */
export function pinsToAdd(planned: readonly Planned[], dayOf: (iso: string) => string, cutoff: string, version: string, now: string): Pin[] {
  return planned
    .filter((p) => p.state === 'rule' && dayOf(p.draft.start) < cutoff)
    .map((p) => ({ id: p.draft.id, attributions: p.attributions, rule_id: p.rule_id, rationale: p.rationale, rules_version: version, pinned_at: now }));
}

/** Pure: the unpin lines for these ids (only ids that are pinned). */
export function unpinLines(pins: ReadonlyMap<string, Pin>, ids: Iterable<string>, now: string): Unpin[] {
  return [...new Set(ids)].filter((id) => pins.has(id)).map((id) => ({ id, unpinned_at: now }));
}
