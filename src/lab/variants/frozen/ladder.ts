// FROZEN copy of src/sources/attribution/ladder.ts as on main before this branch — the baseline variant's control:
// 'today's production' must not move when this branch improves the production ladder. Never edit; never import
// outside src/lab.
// Deterministic attribution ladder. Strong → weak; stop at the first rung that decides:
//   1.  tenant rules (annotations/rules.json) — a deciding rule decides; a candidates rule stops the
//       ladder with exactly that choice set (nothing below may widen what the tenant narrowed)
//   1b. admin bucket — payments/invoices/contracts/KYC/visa threads (and call titles) → the counterpart
//       umbrella's admin initiative, when the tenant names one (attribution.json `admin`)
//   2.  exclusive markers — a participant who always means one initiative (all of them must agree)
//   3.  registry routing — repo/path (work), channel names, Jira/YouTrack keys, calendar title patterns
//   4.  narrow markers — no decision, candidates narrowed to the person's set
//   5.  broad markers — no decision, a hint for the model step
// The ladder never guesses: an ambiguous registry hit is a candidate list, not a decision. Ported from
// the owen-ops CLI (src/review/ladder.ts + admin.ts); the admin map moved from code to tenant data.
import type { Registry } from './registry.js';
import type { FragmentDraft } from '../../../sources/attribution/fragment.js';

export type MarkerType = 'exclusive' | 'narrow' | 'broad';
export interface MarkedPerson {
  person_id: string;
  name: string;
  marker: { type: MarkerType; initiatives: string[] };
}
export interface Attribution {
  initiative: string;
  share: number;
}
export interface RuleRecord {
  id: string;
  when: { person?: string; container?: string; title_re?: string; repo?: string; project_key?: string; source?: string };
  then: { initiative?: string; candidates?: string[] };
  origin?: string;
  created?: string;
  note?: string;
}
export interface LadderCtx {
  rules: RuleRecord[];
  people: Map<string, MarkedPerson>;
  reg: Registry;
  /** The subject (whose day is fragmented): never a marker for their own fragments. */
  self: string;
  /** Umbrella → its non-billable admin initiative; absent → no admin rung. */
  admin?: Record<string, string>;
}
export interface LadderResult {
  decided: { attributions: Attribution[]; rule_id: string; rationale: string } | null;
  candidates: string[];
  hint: string;
}

const norm = (s: string) => s.toLowerCase().replace(/^(#|chat:@?|channel:)/, '').replace(/\s*\|.*$/, '').trim();

export function ruleMatches(r: RuleRecord, f: FragmentDraft): boolean {
  const w = r.when ?? {};
  const keys = Object.keys(w).filter((k) => (w as Record<string, unknown>)[k] !== undefined);
  if (!keys.length) return false;
  if (w.person && !f.participants.includes(w.person)) return false;
  if (w.container && (!f.container || norm(f.container) !== norm(w.container))) return false;
  if (w.title_re) {
    try {
      if (!new RegExp(w.title_re, 'i').test(f.title)) return false;
    } catch {
      return false;
    }
  }
  if (w.repo && f.repo !== w.repo) return false;
  if (w.project_key && !f.projectKeys.includes(w.project_key)) return false;
  if (w.source && f.source !== w.source) return false;
  return true;
}

const ADMIN_RE = new RegExp(
  [
    'invoice', 'invoic', 'payment', 'paid', 'payout', 'pay out', 'wire transfer', 'bank transfer', 'iban', 'swift',
    '\\bdeel\\b', '\\bkyc\\b', 'verification step', 'contract', 'agreement', '\\bnda\\b', '\\bsow\\b', 'retainer fee',
    'visa', 'residence permit', 'tax', 'vat', 'receipt',
    'rechnung', 'zahlung', 'überweisung', 'vertrag', 'steuer', 'quittung', 'aufenthalt',
    'сч[её]т', 'оплат', 'платеж', 'платёж', 'перевод денег', 'договор', 'контракт', 'виза', 'налог', 'инвойс', 'чек',
  ].join('|'),
  'i',
);

/** Admin chatter: money, contracts, visas — real, but billed to no project. */
export function isAdminText(text: string): boolean {
  return ADMIN_RE.test(text ?? '');
}

const one = (initiative: string, weight: number): Attribution[] => [{ initiative, share: weight }];

export function attribute(f: FragmentDraft, ctx: LadderCtx): LadderResult {
  const others = f.participants
    .filter((p) => p !== ctx.self)
    .map((p) => ctx.people.get(p))
    .filter((p): p is MarkedPerson => !!p);

  // 1. rules
  for (const r of ctx.rules) {
    if (!ruleMatches(r, f)) continue;
    if (r.then?.candidates?.length) return { decided: null, candidates: [...r.then.candidates], hint: `rule ${r.id}: choose by content among ${r.then.candidates.join(' | ')}` };
    if (r.then?.initiative) return { decided: { attributions: one(r.then.initiative, f.weight), rule_id: r.id, rationale: `rule ${r.id}` }, candidates: [r.then.initiative], hint: 'rule' };
  }
  // 1b. admin chatter: a thread (or a call whose TITLE says so) about money/contracts/visa.
  const adminText = f.kind === 'thread' ? (f.text ?? '') : f.kind === 'call' ? f.title : '';
  if (ctx.admin && adminText && isAdminText(adminText)) {
    const umbrellas = [...new Set(others.flatMap((p) => p.marker.initiatives).map((i) => ctx.reg.umbrellaOf(i)).filter((u): u is string => !!u))];
    const buckets = [...new Set(umbrellas.map((u) => ctx.admin![u]).filter((x): x is string => !!x))];
    if (buckets.length === 1) return { decided: { attributions: one(buckets[0]!, f.weight), rule_id: 'admin', rationale: `admin chatter with ${others.map((p) => p.name).join(', ')}` }, candidates: buckets, hint: 'admin' };
    if (buckets.length > 1) return { decided: null, candidates: buckets, hint: 'admin chatter, umbrella unclear' };
  }
  // 2. exclusive markers (all exclusive participants must agree)
  const excl = [...new Set(others.filter((p) => p.marker.type === 'exclusive').flatMap((p) => p.marker.initiatives))];
  if (excl.length === 1) {
    const who = others.find((p) => p.marker.type === 'exclusive')!;
    return { decided: { attributions: one(excl[0]!, f.weight), rule_id: `marker:${who.person_id}`, rationale: `${who.name} is exclusive to ${excl[0]}` }, candidates: excl, hint: 'exclusive' };
  }
  // 3. registry routing
  const reg = registryHit(f, ctx);
  if (reg.decided) return reg;
  const regCands = reg.candidates;
  // 4. narrow markers
  const narrow = others.filter((p) => p.marker.type === 'narrow');
  if (narrow.length && narrow.length === others.filter((p) => p.marker.initiatives.length).length) {
    const set = [...new Set(narrow.flatMap((p) => p.marker.initiatives))];
    const umbrellas = [...new Set(set.map((i) => ctx.reg.umbrellaOf(i)).filter(Boolean))];
    const cands = regCands.length ? set.filter((c) => regCands.includes(c)) : set;
    return { decided: null, candidates: cands.length ? cands : set, hint: `narrow:${umbrellas.join('|')} via ${narrow.map((p) => p.person_id).join(', ')}` };
  }
  // 5. broad markers
  const broad = [...new Set(others.flatMap((p) => p.marker.initiatives))];
  const cands = [...new Set([...regCands, ...broad])];
  return { decided: null, candidates: cands, hint: others.length ? `broad via ${others.map((p) => p.person_id).join(', ')}${reg.hint ? '; ' + reg.hint : ''}` : reg.hint || 'no signals' };
}

function registryHit(f: FragmentDraft, ctx: LadderCtx): LadderResult {
  const reg = ctx.reg;
  const decide = (id: string, why: string): LadderResult => ({ decided: { attributions: one(reg.resolveAlias(id), f.weight), rule_id: `registry:${why.split(' ')[0]}`, rationale: why }, candidates: [id], hint: 'registry' });
  if (f.kind === 'work' && f.route) {
    if (f.route.initiative && f.route.confidence === 'exact') return decide(f.route.initiative, `repo/path ${f.route.reason}`);
    if (f.route.candidates.length) return { decided: null, candidates: f.route.candidates, hint: f.route.reason };
  }
  const personNames = new Set([...ctx.people.values()].map((p) => p.name.toLowerCase()));
  if (f.container) {
    const c = norm(f.container);
    const hits = reg.data.initiatives
      // channel lists sometimes name people — people are markers, not places
      .filter((i) => reg.channelsOf(i).filter((x) => !personNames.has(x.toLowerCase())).some((x) => norm(x) === c))
      .map((i) => i.id);
    if (hits.length === 1) return decide(hits[0]!, `channel ${f.container}`);
  }
  if (f.projectKeys.length) {
    const hits = [...new Set(reg.data.initiatives.filter((i) => f.projectKeys.some((k) => reg.keysOf(i).includes(k))).map((i) => i.id))];
    if (hits.length === 1) return decide(hits[0]!, `key ${f.projectKeys.join(',')}`);
    if (hits.length > 1) return { decided: null, candidates: hits, hint: `keys ${f.projectKeys.join(',')} match several` };
  }
  if (f.kind === 'call') {
    const r = reg.routeTitle(f.title.split(' — ')[0]!);
    if (r.initiative && r.confidence !== 'ambiguous') return decide(r.initiative, r.reason);
    if (r.candidates.length) return { decided: null, candidates: r.candidates, hint: r.reason };
  }
  return { decided: null, candidates: [], hint: '' };
}
