// Deterministic attribution ladder. Strong → weak; stop at the first rung that decides:
//   1. tenant rules (annotations/rules.json) — a deciding rule decides; a candidates rule stops the
//      ladder with exactly that choice set (nothing below may widen what the tenant narrowed)
//   2. exclusive markers — a participant who always means one initiative (all of them must agree)
//   3. registry routing — repo/path (work), channels (id first, then name), Jira/YouTrack keys (work: the
//      block's commits too), calendar title patterns
//   4. admin bucket — payments/invoices/contracts/KYC/visa threads (and call titles) → the counterpart
//      umbrella's admin initiative, when the tenant names one (attribution.json `admin`)
//   5. narrow markers — no decision, candidates narrowed to the person's set
//   6. broad markers — no decision, a hint for the model step
// The ladder never guesses: an ambiguous registry hit is a candidate list, not a decision. Every decision
// carries the deciding rung's graded confidence (`conf`, RUNG_CONF): data for an operating point that may
// one day drop a weak rung — today every rung still decides. Ported from the owen-ops CLI
// (src/review/ladder.ts + admin.ts); the admin map moved from code to tenant data.
//
// Stage-0 fixes (each measured on the lab bench before the port):
//   F1  the admin lexicon matches whole words (Unicode-aware: JS `\b` fails on Cyrillic) — `vat` no longer fires
//       on "private", `tax` on "syntax", `visa` on "advisable", `договор` on "договорились", `чек` on "чеклист",
//       `Steuer` on "Steuerung" — and the rung runs after the markers and the registry: a channel, a key or an
//       exclusive person is a stronger cue than one word.
//   F2  calendar title patterns of ≤ 5 characters match whole words (registry.ts titleMatcher).
//   F6  `{id, name}` channel entries route (the id first); a channel several initiatives list gives them as
//       candidates instead of falling through; a work block's own tracker keys can still decide when its repo
//       is shared by several initiatives.
//   F7  broad people no longer switch the narrow rung off: they only join its hint.
import { channelIdOf, normChannel, type Registry } from './registry.js';
import type { FragmentDraft } from './fragment.js';

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
  decided: {
    attributions: Attribution[];
    rule_id: string;
    rationale: string;
    /** The deciding rung's graded confidence (RUNG_CONF) — how far its kind of evidence is trusted, never a threshold here. */
    conf?: number;
  } | null;
  candidates: string[];
  hint: string;
}

/**
 * How much each deciding rung's evidence is worth (the lab's stage-0 priors): a repo route is near-certain, a tenant
 * rule or a ticket key nearly so, a single calendar-title hit and one admin word are guesses that happen to decide.
 */
export const RUNG_CONF = { repo: 0.99, key: 0.97, rule: 0.97, exclusive: 0.95, channel: 0.95, title: 0.8, admin: 0.75 } as const;

export function ruleMatches(r: RuleRecord, f: FragmentDraft): boolean {
  const w = r.when ?? {};
  const keys = Object.keys(w).filter((k) => (w as Record<string, unknown>)[k] !== undefined);
  if (!keys.length) return false;
  if (w.person && !f.participants.includes(w.person)) return false;
  if (w.container && (!f.container || normChannel(f.container) !== normChannel(w.container))) return false;
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

// The admin lexicon (EN/DE/RU/IT), whole words only. `stem*` = the stem with any ending; `*stem` = any compound head
// (German puts the admin noun last: Lohnabrechnung, Bezahlung, Rahmenvertrag, Umsatzsteuer — compounds the old
// substring match caught and a whole-word one must not lose; but Berechnung/Umrechnung/Hochrechnung are calculations,
// and Steuerung is control, so those heads and tails are spelled out); anything else is the exact word, with its
// inflections listed wherever a free ending would catch another word (договор|договорились, чек|чеклист, виза|визит).
// Entries are regex source: `[её]` spells both, `(?!-)` keeps `чек` off чек-лист/чек-ин, a space matches any
// whitespace; the first entry that matches names the word, so a hyphenated form goes before its head.
const ADMIN_WORDS = [
  // en
  'invoic*', 'payment*', 'paid', 'unpaid', 'payout*', 'pay out', 'wire transfer*', 'bank transfer*', 'iban', 'ibans', 'swift code', 'deel', 'kyc',
  'verification step', 'contract', 'contracts', 'contractual', 'agreement*', 'nda', 'ndas', 'sow', 'retainer fee*', 'visa', 'visas', 'residence permit*',
  'tax', 'taxes', 'taxation', 'vat', 'receipt*', 'reimburs*', 'purchase order*',
  // de
  '*(?<!be|um|hoch|nach)rechnung*', '*zahlung*', '*überweisung*', '*vertrag', '*vertrags*', '*verträge*', 'vertraglich*', '*steuer', '*steuern',
  '*steuer(?:berat|erklär|nummer|bescheid|bescheinig|satz|sätz|pflicht|abzug|jahr|recht|amt|schuld|zahl)*', '*quittung*', 'aufenthaltstitel*',
  'aufenthaltserlaubnis*', 'aufenthaltsgenehmigung*', 'mwst',
  // ru
  'сч[её]т-фактур*', 'сч[её]т', 'сч[её]та', 'сч[её]ту', 'сч[её]том', 'сч[её]те', 'сч[её]ты', 'сч[её]тов', 'сч[её]там', 'сч[её]тами', 'сч[её]тах',
  '*оплат*', '*оплач*', 'плат[её]ж*', 'перевод денег', 'договор', 'договора', 'договору', 'договором', 'договоре', 'договоры', 'договоров',
  'договорам', 'договорами', 'договорах', 'контракт*', 'виза', 'визы', 'визу', 'визой', 'визе', 'виз', 'визам', 'визами', 'визах', 'налог*',
  'инвойс*', 'чек(?!-)', 'чека', 'чеку', 'чеком', 'чеке', 'чеки', 'чеков', 'квитанци*', 'ндс',
  // it
  'fattur*', 'pagament*', 'contratt*', 'bonifico', 'bonifici', 'ricevut*', 'iva',
];
const LETTER = '[\\p{L}\\p{M}\\p{N}]';
const ADMIN_RE = new RegExp(
  `(?<!${LETTER})(?:${ADMIN_WORDS.map((w) => w.replace(/^\*/, `${LETTER}*`).replace(/\*$/, `${LETTER}*`).replace(/ /g, '\\s+')).join('|')})(?!${LETTER})`,
  'iu',
);

/** The admin word a text holds (whole words, any case), or null. */
export function adminWord(text: string | null | undefined): string | null {
  return ADMIN_RE.exec((text ?? '').normalize('NFC'))?.[0] ?? null;
}

/** Admin chatter: money, contracts, visas — real, but billed to no project. */
export function isAdminText(text: string): boolean {
  return adminWord(text) !== null;
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
    if (r.then?.initiative) return { decided: { attributions: one(r.then.initiative, f.weight), rule_id: r.id, rationale: `rule ${r.id}`, conf: RUNG_CONF.rule }, candidates: [r.then.initiative], hint: 'rule' };
  }
  // 2. exclusive markers (all exclusive participants must agree)
  const excl = [...new Set(others.filter((p) => p.marker.type === 'exclusive').flatMap((p) => p.marker.initiatives))];
  if (excl.length === 1) {
    const who = others.find((p) => p.marker.type === 'exclusive')!;
    return { decided: { attributions: one(excl[0]!, f.weight), rule_id: `marker:${who.person_id}`, rationale: `${who.name} is exclusive to ${excl[0]}`, conf: RUNG_CONF.exclusive }, candidates: excl, hint: 'exclusive' };
  }
  // 3. registry routing
  const reg = registryHit(f, ctx);
  if (reg.decided) return reg;
  const regCands = reg.candidates;
  // 4. admin chatter (F1): a thread (or a call whose TITLE says so) about money/contracts/visa — after the markers and
  //    the registry, so a channel, a key or an exclusive person outranks one word.
  const adminText = f.kind === 'thread' ? (f.text ?? '') : f.kind === 'call' ? f.title : '';
  const word = ctx.admin && adminText ? adminWord(adminText) : null;
  if (word) {
    const umbrellas = [...new Set(others.flatMap((p) => p.marker.initiatives).map((i) => ctx.reg.umbrellaOf(i)).filter((u): u is string => !!u))];
    const buckets = [...new Set(umbrellas.map((u) => ctx.admin![u]).filter((x): x is string => !!x))];
    if (buckets.length === 1) return { decided: { attributions: one(buckets[0]!, f.weight), rule_id: 'admin', rationale: `admin chatter ("${word}") with ${others.map((p) => p.name).join(', ')}`, conf: RUNG_CONF.admin }, candidates: buckets, hint: 'admin' };
    if (buckets.length > 1) return { decided: null, candidates: buckets, hint: 'admin chatter, umbrella unclear' };
  }
  // 5. narrow markers (F7: broad people no longer switch this rung off — they only join the hint; exclusive people who
  //    disagreed above still do, the union of their initiatives being no narrower)
  const narrow = others.filter((p) => p.marker.type === 'narrow' && p.marker.initiatives.length);
  if (narrow.length && !others.some((p) => p.marker.type === 'exclusive' && p.marker.initiatives.length)) {
    const set = [...new Set(narrow.flatMap((p) => p.marker.initiatives))];
    const umbrellas = [...new Set(set.map((i) => ctx.reg.umbrellaOf(i)).filter(Boolean))];
    const cands = regCands.length ? set.filter((c) => regCands.includes(c)) : set;
    const along = others.filter((p) => p.marker.type === 'broad' && p.marker.initiatives.length);
    return { decided: null, candidates: cands.length ? cands : set, hint: `narrow:${umbrellas.join('|')} via ${narrow.map((p) => p.person_id).join(', ')}${along.length ? `; broad via ${along.map((p) => p.person_id).join(', ')}` : ''}` };
  }
  // 6. broad markers
  const broad = [...new Set(others.flatMap((p) => p.marker.initiatives))];
  const cands = [...new Set([...regCands, ...broad])];
  return { decided: null, candidates: cands, hint: others.length ? `broad via ${others.map((p) => p.person_id).join(', ')}${reg.hint ? '; ' + reg.hint : ''}` : reg.hint || 'no signals' };
}

function registryHit(f: FragmentDraft, ctx: LadderCtx): LadderResult {
  const reg = ctx.reg;
  const decide = (id: string, why: string, conf: number): LadderResult => ({ decided: { attributions: one(reg.resolveAlias(id), f.weight), rule_id: `registry:${why.split(' ')[0]}`, rationale: why, conf }, candidates: [id], hint: 'registry' });
  // What a cue could only narrow (a repo or a channel several initiatives share) stays on the table while a sharper cue
  // further down may still decide (F6) — before, a shared repo ended the routing and a shared channel was dropped.
  const held: string[] = [];
  const why: string[] = [];
  const open = (ids: string[], reason: string): LadderResult => ({ decided: null, candidates: [...new Set([...held, ...ids])], hint: [...why, reason].filter(Boolean).join('; ') });
  if (f.kind === 'work' && f.route) {
    if (f.route.initiative && f.route.confidence === 'exact') return decide(f.route.initiative, `repo/path ${f.route.reason}`, RUNG_CONF.repo);
    if (f.route.candidates.length) {
      held.push(...f.route.candidates);
      why.push(f.route.reason);
    }
  }
  if (f.container) {
    // channel lists sometimes name people — people are markers, not places
    const personNames = new Set([...ctx.people.values()].map((p) => p.name.toLowerCase()));
    // A run's refs carry its Slack channel id: it routes even after the channel was renamed.
    const channelId = f.kind === 'thread' ? (f.refs.map(channelIdOf).find((x) => !!x) ?? null) : null;
    const r = reg.routeChannel(f.container, channelId, personNames);
    if (r.initiative && r.confidence !== 'ambiguous') return decide(r.initiative, `channel ${f.container}`, RUNG_CONF.channel);
    if (r.candidates.length) {
      held.push(...r.candidates);
      why.push(`channel ${f.container} is shared by ${r.candidates.join(' | ')}`);
    }
  }
  if (f.projectKeys.length) {
    const hits = [...new Set(reg.data.initiatives.filter((i) => f.projectKeys.some((k) => reg.keysOf(i).includes(k))).map((i) => i.id))];
    if (hits.length === 1) return decide(hits[0]!, `key ${f.projectKeys.join(',')}`, RUNG_CONF.key);
    if (hits.length > 1) return open(hits, `keys ${f.projectKeys.join(',')} match several`);
  }
  if (f.kind === 'call') {
    const r = reg.routeTitle(f.title.split(' — ')[0]!);
    if (r.initiative && r.confidence !== 'ambiguous') return decide(r.initiative, r.reason, RUNG_CONF.title);
    if (r.candidates.length) return open(r.candidates, r.reason);
  }
  return open([], '');
}
