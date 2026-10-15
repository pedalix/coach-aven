// Stage 0 — the tenant as the floor is GIVEN it (a dataset's tenant/ directory): initiatives.json in either shape, the
// rules, the people file with its markers, and annotations/attribution.json when the layer is on (the subject and each
// umbrella's admin bucket). Read leniently — a bench must not die on a tenant typo the build would only log: a malformed
// rule, person or initiative is skipped (and counted), never guessed.
//
// Time: a tenant's rules carry `created`. Rules written from the owner's answers during the window leak those answers
// into a replay (design §1.2 hazards); `rulesFor(day, 'day')` keeps only rules created before that local day, so a
// replay can use the tenant as it stood. The default ('all') is the tenant as given — what the baseline's frozen
// ladder saw, so the two compare like for like.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuleRecord } from '../../../sources/attribution/ladder.js';
import { foldName } from '../../../sources/identities/attendees.js';
import { buildResolver, type PersonLike, type Resolver } from './people.js';
import { Reg } from './registry.js';

export type MarkerType = 'exclusive' | 'narrow' | 'broad';
export interface Marker {
  type: MarkerType;
  initiatives: string[]; // label ids (alias-resolved, splits expanded)
}

export interface Rule extends RuleRecord {
  created?: string;
}

export interface Tenant {
  dir: string;
  reg: Reg;
  rules: Rule[];
  people: PersonLike[];
  resolver: Resolver;
  markers: Map<string, Marker>; // person_id → marker (label ids)
  subject: string | null;
  admin: Record<string, string>; // umbrella → its admin bucket (label id)
  personal: string[]; // label ids under a `personal` umbrella
  tz: string;
  skipped: { initiatives: number; rules: number; people: number };
  /** Rules in force on a local day: 'all' = as given; 'day' = only those created before that day (no answer leaks). */
  rulesFor(day: string, mode?: 'all' | 'day'): Rule[];
}

const readJson = (path: string): unknown => {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
};

const PERSON_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** YYYY-MM-DD of an instant in a zone (build.ts localDay, without importing the build). */
export const localDay = (iso: string, tz: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

function lenientPeople(raw: unknown): { people: PersonLike[]; skipped: number } {
  const out: PersonLike[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const e of Array.isArray(raw) ? raw : []) {
    const o = e && typeof e === 'object' && !Array.isArray(e) ? (e as Record<string, unknown>) : null;
    const pid = o && typeof o.person_id === 'string' ? o.person_id.trim() : '';
    if (!o || !PERSON_ID.test(pid) || seen.has(pid)) {
      skipped++;
      continue;
    }
    seen.add(pid);
    const ids = Array.isArray(o.identities) ? o.identities.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : [];
    const m = o.marker && typeof o.marker === 'object' && !Array.isArray(o.marker) ? (o.marker as Record<string, unknown>) : null;
    const marker =
      m && typeof m.type === 'string' && ['exclusive', 'narrow', 'broad'].includes(m.type) && Array.isArray(m.initiatives)
        ? { type: m.type, initiatives: m.initiatives.filter((x): x is string => typeof x === 'string' && !!x.trim()) }
        : typeof o.default_initiative === 'string' && o.default_initiative
          ? { type: 'broad', initiatives: [o.default_initiative] }
          : null;
    out.push({ person_id: pid, name: typeof o.name === 'string' && o.name.trim() ? o.name.trim() : pid, company: typeof o.company === 'string' ? o.company : null, identities: ids, marker });
  }
  return { people: out, skipped };
}

function lenientRules(raw: unknown): { rules: Rule[]; skipped: number } {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? (raw as { rules?: unknown }).rules : undefined;
  const rules: Rule[] = [];
  let skipped = 0;
  for (const r of Array.isArray(list) ? list : []) {
    const o = r && typeof r === 'object' ? (r as Rule) : null;
    if (!o || typeof o.id !== 'string' || !o.when || typeof o.when !== 'object' || !o.then || typeof o.then !== 'object') {
      skipped++;
      continue;
    }
    rules.push(o);
  }
  return { rules, skipped };
}

export interface TenantOpts {
  subject?: string | null; // the dataset's subject when attribution.json names none
  tz?: string;
}

export function loadTenant(dir: string, opts: TenantOpts = {}): Tenant {
  const ann = join(dir, 'annotations');
  const { people, skipped: skippedPeople } = lenientPeople(readJson(join(ann, 'people.json')));
  // A channel list naming a person is a marker, not a place: skip those entries (production does the same).
  const names = new Set(people.flatMap((p) => [p.name.toLowerCase(), foldName(p.name)]));
  const rawReg = readJson(join(dir, 'initiatives.json'));
  const reg = new Reg(rawReg, names);
  const listed = Array.isArray(rawReg) ? rawReg.length : Array.isArray((rawReg as { initiatives?: unknown[] } | undefined)?.initiatives) ? (rawReg as { initiatives: unknown[] }).initiatives.length : 0;
  const { rules, skipped: skippedRules } = lenientRules(readJson(join(ann, 'rules.json')));
  const cfg = readJson(join(ann, 'attribution.json')) as Record<string, unknown> | undefined;
  const subject = (cfg && typeof cfg.subject === 'string' && cfg.subject) || opts.subject || null;
  const admin: Record<string, string> = {};
  if (cfg?.admin && typeof cfg.admin === 'object' && !Array.isArray(cfg.admin)) {
    for (const [u, id] of Object.entries(cfg.admin as Record<string, unknown>)) if (typeof id === 'string' && id) admin[u] = reg.label(id);
  }
  const markers = new Map<string, Marker>();
  for (const p of people) {
    if (!p.marker) continue;
    markers.set(p.person_id, { type: p.marker.type as MarkerType, initiatives: [...new Set(p.marker.initiatives.flatMap((i) => reg.labels(i)))] });
  }
  const personal = reg.labelIds().filter((id) => reg.umbrellaOf(id) === 'personal');
  const tz = opts.tz ?? 'UTC';
  const dayOfRule = new Map<string, string | null>();
  for (const r of rules) {
    const ok = typeof r.created === 'string' && !Number.isNaN(Date.parse(r.created));
    dayOfRule.set(r.id, ok ? localDay(new Date(Date.parse(r.created!)).toISOString(), tz) : null);
  }
  return {
    dir,
    reg,
    rules,
    people,
    resolver: buildResolver(people),
    markers,
    subject,
    admin,
    personal,
    tz,
    skipped: { initiatives: Math.max(0, listed - reg.list.length), rules: skippedRules, people: skippedPeople },
    rulesFor(day, mode = 'all') {
      if (mode === 'all') return rules;
      return rules.filter((r) => {
        const d = dayOfRule.get(r.id);
        return !d || d < day;
      });
    },
  };
}
