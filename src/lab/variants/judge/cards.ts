// J's cards (design §4.2–§4.3): what the model reads, built deterministically from the unit, the day's pool, the
// stage-0 floor and the tenant files. Shared with K+g (§3.7), which words its question guesses from the same cards.
//
//   closed list  every registry id (alias-resolved) ∪ admin buckets ∪ personal ∪ none ∪ unregistered, each as one
//                registry card: id | umbrella | name [done] | code | cues | marker people. NEVER the floor's
//                candidates: 16 of 142 past judgments fell outside them and 32 had none.
//   case card    ≤600 chars per unit, ≤1.5k per case. Units are short tags (u1…) — store ids and gold never appear.
//                Fragments: kind, local time, source, container, title, participants "Name (company; marker:
//                initiatives)", the evidence (URLs reduced to their host, keys kept), the call's topic list, the
//                CO-ACTIVITY line (the subject's work blocks within ±60 min and where they went — the timelog
//                signal), the floor's hint and candidates as a "weak hint", siblings decided today as a "hint".
//
// Each card also returns its fields (title / text / participants / coactivity) as plain strings: the cite check
// (cite.ts) asks whether a cited span really sits in the field the model named.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRegistry, type Initiative } from '../../../sources/attribution/registry.js';
import { loadPeople } from '../../../sources/people.js';
import { NONE, UNREGISTERED, type DatasetMeta, type FragmentUnit, type ItemUnit, type MentionUnit } from '../../types.js';
import type { Floor, RegistryCard } from '../stage0/index.js';
import { clip, clock, fold, hostsOnly, localTime, oneLine, tokens } from './text.js';

export const UNIT_MAX = 600; // chars per unit on a card
export const CASE_MAX = 1500; // chars per case card
export const COACTIVITY_MIN = 60; // the co-activity window, minutes on either side

export type CiteField = 'title' | 'text' | 'participants' | 'coactivity' | 'precedent';
export const CITE_FIELDS: readonly CiteField[] = ['title', 'text', 'participants', 'coactivity', 'precedent'];

export interface Card {
  key: string; // the case key
  text: string; // the rendered card
  fields: Record<Exclude<CiteField, 'precedent'>, string>;
}

// --- people ---------------------------------------------------------------------------------------------------

export interface PersonInfo {
  id: string;
  name: string;
  company?: string;
  marker?: { type: 'exclusive' | 'narrow' | 'broad'; initiatives: string[] };
  identities: string[];
}

/** The tenant roster (annotations/people.json); a tenant without one (or a malformed one) has nobody. */
export function loadPeopleDir(tenantDir: string): Map<string, PersonInfo> {
  const file = join(tenantDir, 'annotations', 'people.json');
  if (!existsSync(file)) return new Map();
  try {
    return new Map(loadPeople(file).map((p) => [p.person_id, { id: p.person_id, name: p.name, company: p.company, marker: p.marker, identities: p.identities }]));
  } catch {
    return new Map();
  }
}

/** "Mara Quill (acme; narrow: acme/web, acme/app)" — who a participant is and what they tell about the initiative. */
export function personLabel(id: string, people: ReadonlyMap<string, PersonInfo>): string {
  const p = people.get(id);
  if (!p) return id;
  const bits: string[] = [];
  if (p.company) bits.push(p.company);
  if (p.marker && p.marker.initiatives.length) {
    const ins = p.marker.initiatives;
    bits.push(`${p.marker.type}: ${ins.slice(0, 3).join(', ')}${ins.length > 3 ? ` +${ins.length - 3}` : ''}`);
  }
  return bits.length ? `${p.name} (${bits.join('; ')})` : p.name;
}

// --- the closed list ------------------------------------------------------------------------------------------

const ADMIN_EXPLAIN = 'admin bucket: invoices, contracts, payments, visas, taxes';
// Stems the admin bucket is grounded by (whole words, design F1) — a cite for an admin label must name the money.
export const ADMIN_TERMS = ['invoice', 'invoices', 'payment', 'payments', 'paid', 'contract', 'contracts', 'agreement', 'nda', 'visa', 'tax', 'taxes', 'vat', 'iban', 'receipt', 'rechnung', 'zahlung', 'vertrag', 'steuer', 'счет', 'счёт', 'оплата', 'оплату', 'платеж', 'платёж', 'договор', 'контракт', 'виза', 'налог', 'инвойс', 'fattura', 'pagamento', 'contratto'];

const strs = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.flatMap((x) => (typeof x === 'string' ? [x] : x && typeof x === 'object' && typeof (x as { name?: unknown }).name === 'string' ? [(x as { name: string }).name] : [])).filter(Boolean)
    : [];
const base = (p: string): string => p.replace(/[/*]+$/, '').split('/').filter(Boolean).pop() ?? p;

/** Registry cards straight from the tenant files — J's fallback while stage 0's cards() is still a bare stub. */
export function tenantCards(tenantDir: string, space: DatasetMeta['labelSpace'], people: ReadonlyMap<string, PersonInfo>): RegistryCard[] {
  let inis: Initiative[] = [];
  try {
    const file = join(tenantDir, 'initiatives.json');
    if (existsSync(file)) inis = parseRegistry(JSON.parse(readFileSync(file, 'utf8'))).initiatives;
  } catch {
    inis = [];
  }
  const byId = new Map(inis.map((i) => [i.id, i]));
  const markerPeople = (id: string): string[] =>
    [...people.values()].filter((p) => p.marker && p.marker.type !== 'broad' && p.marker.initiatives.includes(id)).map((p) => p.name);
  return space.initiatives.map((id) => {
    const ini = byId.get(id);
    const s = (ini?.sources ?? {}) as Record<string, unknown>;
    const cues = [
      ...strs(s.calendar_title_patterns),
      ...strs(s.slack_channels),
      ...strs(s.teams_channels),
      ...strs(s.jira_keys),
      ...strs(s.youtrack_prefixes),
      ...strs(s.repos).map(base),
      ...strs(s.local_paths).map(base),
      ...strs(s.hosts),
      ...strs(s.apps),
      ...(typeof ini?.company === 'string' ? [ini.company] : []),
    ];
    return {
      id,
      umbrella: space.umbrellas[id] ?? (typeof ini?.umbrella === 'string' ? ini.umbrella : id.split('/')[0]!),
      name: typeof ini?.name === 'string' && ini.name ? ini.name : id,
      done: ini?.status === 'done',
      ...(typeof ini?.billing_code === 'string' && ini.billing_code ? { code: ini.billing_code } : {}),
      cues: [...new Set(cues.map((c) => c.trim()).filter((c) => c && !/\s\(\d+ repos\)$/.test(c)))],
      people: markerPeople(id),
    };
  });
}

/** Stage 0's cards when they carry anything, else the tenant's (the stub's cards are bare ids). */
export function registryCards(fromFloor: RegistryCard[], tenantDir: string, space: DatasetMeta['labelSpace'], people: ReadonlyMap<string, PersonInfo>): RegistryCard[] {
  const bare = !fromFloor.length || fromFloor.every((c) => !c.cues.length && !c.people.length && c.name === c.id);
  return bare ? tenantCards(tenantDir, space, people) : fromFloor;
}

export interface ClosedList {
  ids: string[]; // every valid label, in canonical order
  cards: Map<string, RegistryCard>;
  admin: Set<string>; // admin bucket ids
  umbrellaOf(id: string): string;
  line(id: string): string; // one registry card line
  tokens(id: string): string[]; // registry tokens of a label (the cite check's "supports this label")
}

const isAdminId = (id: string): boolean => /(^|\/)admin$/.test(id);

export function closedList(cards: RegistryCard[], labelSpace: string[], opts: { admin?: Record<string, string> } = {}): ClosedList {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const adminIds = new Set([...Object.values(opts.admin ?? {}), ...labelSpace.filter(isAdminId)]);
  const ids = [...new Set([...labelSpace.filter((x) => x !== NONE && x !== UNREGISTERED), NONE, UNREGISTERED])];
  const umbrellaOf = (id: string): string => byId.get(id)?.umbrella ?? (id === NONE || id === UNREGISTERED ? id : id.split('/')[0]!);
  const line = (id: string): string => {
    if (id === NONE) return `${NONE} | — | not work, noise, or nothing to attribute`;
    if (id === UNREGISTERED) return `${UNREGISTERED} | — | real work on a topic this list lacks — do not force a fit`;
    const c = byId.get(id);
    const parts = [id, umbrellaOf(id), `${c?.name && c.name !== id ? clip(c.name, 90) : id}${c?.done ? ' [done]' : ''}`];
    if (c?.code) parts.push(c.code);
    if (adminIds.has(id)) parts.push(`${ADMIN_EXPLAIN} (umbrella ${umbrellaOf(id)})`);
    if (c?.cues.length) parts.push(`cues: ${clip(c.cues.slice(0, 14).join(', '), 220)}`);
    if (c?.people.length) parts.push(`people: ${clip(c.people.slice(0, 6).join(', '), 120)}`);
    return parts.join(' | ');
  };
  // Registry tokens per label. A token that several labels carry (a company, a split alias's title pattern, a word like
  // "agentic" in three names) cannot support one of them over the others, so only DISTINCTIVE tokens count — the ones
  // exactly one label has. The admin lexicon is exempt: every admin bucket owns it, the umbrella is decided elsewhere.
  const raw = new Map<string, Set<string>>();
  for (const id of ids) {
    const c = byId.get(id);
    const out = new Set<string>();
    if (c) {
      for (const w of tokens(c.name, 4)) out.add(w);
      if (c.code && c.code.length >= 2) out.add(fold(c.code));
      for (const cue of c.cues) {
        // '#channel' → 'channel'; a key prefix written 'WEB-' must still match inside 'WEB-12'
        const cc = fold(cue.replace(/^[#@]/, '').replace(/-$/, '').trim());
        if (cc.length >= 2) out.add(cc);
      }
    }
    raw.set(id, out);
  }
  const owners = new Map<string, number>();
  for (const set of raw.values()) for (const t of set) owners.set(t, (owners.get(t) ?? 0) + 1);
  const toks = new Map<string, string[]>();
  const tokensOf = (id: string): string[] => {
    let t = toks.get(id);
    if (t) return t;
    t = [...(raw.get(id) ?? [])].filter((x) => owners.get(x) === 1);
    if (adminIds.has(id)) t.push(...ADMIN_TERMS);
    toks.set(id, t);
    return t;
  };
  return { ids, cards: byId, admin: adminIds, umbrellaOf, line, tokens: tokensOf };
}

/** The closed list as the system prompt shows it: registry cards in `order` (pass B permutes), none/unregistered last. */
export function renderClosedList(list: ClosedList, order: string[] = list.ids): string {
  const body = order.filter((x) => x !== NONE && x !== UNREGISTERED);
  return [...body, NONE, UNREGISTERED].map((id) => list.line(id)).join('\n');
}

// --- case cards: fragments ------------------------------------------------------------------------------------

type FloorLite = Pick<Floor, 'label' | 'conf' | 'rung' | 'candidates' | 'hint'> & { participants?: string[]; cowork?: string[]; umbrella?: string };

export interface FragmentCaseInput {
  key: string;
  units: { tag: string; u: FragmentUnit; floor: FloorLite }[]; // the residue units of the case
  pool: FragmentUnit[]; // the day's fragments (topic list, co-activity, siblings)
  floorOf: (u: FragmentUnit) => FloorLite; // the floor of any pool unit
  caseOf: (u: FragmentUnit) => string; // the case key of any pool unit
  people: ReadonlyMap<string, PersonInfo>;
  subject?: string;
  tz: string;
  tau: number;
}

// A long candidate list is noise (one broad person can put a dozen there): four names, then a count.
const candidateText = (cands: string[]): string => (cands.length ? `candidates ${cands.slice(0, 4).join(', ')}${cands.length > 4 ? ` +${cands.length - 4} more` : ''}` : '');

const splitTitle = (t: string): { head: string; topic: string } => {
  const i = t.indexOf(' — ');
  return i < 0 ? { head: t, topic: '' } : { head: t.slice(0, i), topic: t.slice(i + 3) };
};
const ms = (iso: string): number => new Date(iso).getTime();

/** The subject's work blocks within ±60 min of a call or run, and where the floor put them: the timelog signal. */
export function coActivity(u: FragmentUnit, pool: FragmentUnit[], floorOf: (u: FragmentUnit) => FloorLite, tz: string, tau: number): string[] {
  if (u.kind === 'work') return [];
  const lo = ms(u.start) - COACTIVITY_MIN * 60_000;
  const hi = Math.max(ms(u.end), ms(u.start)) + COACTIVITY_MIN * 60_000;
  return pool
    .filter((w) => w.kind === 'work' && w.id !== u.id && ms(w.start) <= hi && Math.max(ms(w.end), ms(w.start)) >= lo)
    .sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id))
    .slice(0, 4)
    .map((w) => {
      const f = floorOf(w);
      const where = f.label && f.conf >= tau ? f.label : f.candidates.length ? `? (${f.candidates.slice(0, 2).join(' | ')})` : '?';
      const what = w.repo ? base(w.repo) : clip(oneLine(splitTitle(w.title).head), 40);
      return `${clock(w.start, tz)}–${clock(w.end, tz)} ${what} → ${where}`;
    });
}

export function fragmentCard(c: FragmentCaseInput): Card {
  const first = c.units[0]!.u;
  const tz = c.tz;
  const ff = c.units[0]!.floor;
  const others = [...new Set([...(ff.participants ?? []), ...c.units.flatMap((x) => x.u.participants)])].filter((p) => p !== c.subject);
  const participants = others.map((p) => personLabel(p, c.people)).join('; ');
  const siblings = c.pool.filter((p) => c.caseOf(p) === c.key).sort((a, b) => a.id.localeCompare(b.id));
  const co = [...new Set(c.units.flatMap((x) => coActivity(x.u, c.pool, c.floorOf, tz, c.tau)))];
  const cowork = [...new Set(c.units.flatMap((x) => x.floor.cowork ?? []))];
  const cands = [...new Set(c.units.flatMap((x) => x.floor.candidates))];
  const hints = [...new Set(c.units.map((x) => x.floor.hint).filter(Boolean))];
  const floorLabels = [...new Set(c.units.map((x) => (x.floor.label ? `${x.floor.label} (${x.floor.rung}, ${x.floor.conf.toFixed(2)})` : '')).filter(Boolean))];
  const mine = new Set(c.units.map((x) => x.u.id));
  const decidedSiblings = siblings
    .filter((s) => !mine.has(s.id))
    .map((s) => ({ s, f: c.floorOf(s) }))
    .filter(({ f }) => f.label && f.conf >= c.tau)
    .map(({ s, f }) => `${splitTitle(s.title).topic ? `"${clip(splitTitle(s.title).topic, 40)}"` : 'a sibling'} → ${f.label}`);
  const end = Math.max(...c.units.map((x) => ms(x.u.end)));
  const title = first.kind === 'call' ? splitTitle(first.title).head : first.title;
  const head: string[] = [
    `[${first.kind}] ${localTime(first.start, tz)}–${Number.isFinite(end) ? clock(new Date(end).toISOString(), tz) : '?'} · ${first.source}${first.container ? ` · ${clip(first.container, 60)}` : ''}${first.repo ? ` · repo ${base(first.repo)}` : ''}`,
    `title: ${clip(oneLine(title), 160)}`,
  ];
  if (participants) head.push(`participants: ${clip(participants, 260)}`);
  if (first.projectKeys.length) head.push(`keys: ${first.projectKeys.slice(0, 8).join(', ')}`);
  const coLine = [...co, ...cowork.map((x) => `work decided → ${x}`)].join('; ');
  if (coLine) head.push(`co-activity (subject's work ±${COACTIVITY_MIN} min): ${clip(coLine, 260)}`);
  if (first.kind === 'call' && siblings.length > 1) {
    const topics = siblings.map((s, i) => `#${i + 1} ${clip(splitTitle(s.title).topic || '(main)', 40)} (${Math.round((s.weight || 0) * 100)}%)`).join(' · ');
    head.push(`topics: ${clip(topics, 300)}`);
  }
  const weak = [floorLabels.length ? `floor guess ${floorLabels.join(', ')}` : '', hints.length ? clip(oneLine(hints.join('; ')), 140) : '', candidateText(cands)]
    .filter(Boolean)
    .join(' · ');
  if (weak) head.push(`weak hint (may be wrong): ${clip(weak, 240)}`);
  if (decidedSiblings.length) head.push(`hint (decided today in this case): ${clip(decidedSiblings.join('; '), 200)}`);

  const headText = head.join('\n');
  const room = Math.max(120, CASE_MAX - headText.length);
  const per = Math.max(60, Math.min(UNIT_MAX, Math.floor(room / c.units.length)));
  const unitLines: string[] = [];
  const texts: string[] = [];
  const titles: string[] = [title];
  for (const { tag, u } of c.units) {
    const topic = first.kind === 'call' ? splitTitle(u.title).topic : '';
    const meta = [topic ? `"${clip(topic, 60)}"` : first.kind !== 'call' && u.title !== first.title ? `"${clip(oneLine(u.title), 60)}"` : '', u.weight && u.weight < 1 ? `${Math.round(u.weight * 100)}%` : '', `${Math.round(u.minutes)} min`]
      .filter(Boolean)
      .join(' · ');
    const lead = `${tag} [${meta}]: `;
    // A call topic's text opens with its own heading: already in the unit's header.
    const text = topic ? u.text.replace(/^\s*#+\s*([^\n]*)\n?/, (m, h: string) => (h.trim() === topic.trim() ? '' : m)) : u.text;
    const body = clip(hostsOnly(text), Math.max(40, per - lead.length));
    unitLines.push(lead + body);
    texts.push(body);
    if (topic) titles.push(topic);
    else if (u.title !== first.title) titles.push(u.title);
  }
  return {
    key: c.key,
    text: `${headText}\n${unitLines.join('\n')}`,
    fields: { title: titles.join(' \n '), text: texts.join(' \n '), participants, coactivity: coLine },
  };
}

// --- case cards: items (t1-item) -------------------------------------------------------------------------------

export interface ItemCaseInput {
  key: string;
  units: { tag: string; u: ItemUnit; floor: FloorLite }[];
  family?: { size: number; sender: string; hosts: string[]; apps: string[] }; // a bot family's representative
  thread: { author: string | null; ts: string; text: string }[]; // earlier messages of the thread (root first, ≤6)
  people: ReadonlyMap<string, PersonInfo>;
  subject?: string;
  tz: string;
}

/** A tracker key stays as is; a link (with or without a scheme) is its host. */
export function keyText(k: string): string {
  const h = hostsOnly(k).trim();
  const m = /^((?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?(?:[/?#*]|$)/i.exec(h);
  return (m ? m[1]!.toLowerCase() : h).replace(/[^\p{L}\p{N}]+$/u, '');
}

const who = (u: ItemUnit, people: ReadonlyMap<string, PersonInfo>): string => (u.authorPerson ? personLabel(u.authorPerson, people) : clip(u.author ?? '?', 60));

export function itemCard(c: ItemCaseInput): Card {
  const first = c.units[0]!.u;
  const tz = c.tz;
  const to = [...new Set(c.units.flatMap((x) => x.u.toPersons))].filter((p) => p !== c.subject);
  const authors = [...new Set(c.units.map((x) => who(x.u, c.people)))];
  const cands = [...new Set(c.units.flatMap((x) => x.floor.candidates))];
  const hints = [...new Set(c.units.map((x) => x.floor.hint).filter(Boolean))];
  const floorLabels = [...new Set(c.units.map((x) => (x.floor.label ? `${x.floor.label} (${x.floor.rung}, ${x.floor.conf.toFixed(2)})` : '')).filter(Boolean))];
  const head: string[] = [];
  if (c.family) {
    head.push(`[bot family · ${c.family.size} item${c.family.size === 1 ? '' : 's'} today] ${first.source} · ${localTime(first.ts, tz)}${first.container ? ` · ${clip(first.container, 60)}` : ''}`);
    head.push(`from: ${clip(c.family.sender, 80)}`);
    if (c.family.hosts.length || c.family.apps.length) head.push(`hosts: ${c.family.hosts.slice(0, 5).join(', ') || '—'} · apps: ${c.family.apps.slice(0, 5).join(', ') || '—'}`);
  } else {
    head.push(`[${first.source} ${first.type}] ${localTime(first.ts, tz)}${first.container ? ` · ${clip(first.container, 60)}` : ''}`);
    head.push(`from: ${clip(authors.join('; '), 200)}${to.length ? ` · to: ${clip(to.map((p) => personLabel(p, c.people)).join('; '), 160)}` : ''}`);
  }
  const subject = first.subject ? oneLine(first.subject) : '';
  if (subject) head.push(`subject: ${clip(subject, 160)}`);
  const keys = [...new Set(c.units.flatMap((x) => x.u.keys).map(keyText).filter(Boolean))];
  if (keys.length) head.push(`keys: ${clip(keys.slice(0, 8).join(', '), 160)}`);
  const ctx = c.thread.slice(-6).map((m) => `[${clock(m.ts, tz)} ${clip(m.author ?? '?', 30)}] ${clip(oneLine(hostsOnly(m.text)), 120)}`);
  if (ctx.length) head.push(`earlier in thread: ${ctx.join(' / ')}`);
  const weak = [floorLabels.length ? `floor guess ${floorLabels.join(', ')}` : '', hints.length ? clip(oneLine(hints.join('; ')), 120) : '', candidateText(cands)].filter(Boolean).join(' · ');
  if (weak) head.push(`weak hint (may be wrong): ${clip(weak, 200)}`);
  const headText = head.join('\n');
  const room = Math.max(120, CASE_MAX - headText.length);
  const per = Math.max(60, Math.min(UNIT_MAX, Math.floor(room / c.units.length)));
  const lines: string[] = [];
  const texts: string[] = [...ctx];
  for (const { tag, u } of c.units) {
    const lead = `${tag}${c.family ? ` (representative of ${c.family.size})` : ''} [${clock(u.ts, tz)}${c.units.length > 1 && !c.family ? ` ${clip(who(u, c.people), 30)}` : ''}]: `;
    const body = clip(oneLine(hostsOnly(u.text)), Math.max(40, per - lead.length));
    lines.push(lead + body);
    texts.push(body);
  }
  return {
    key: c.key,
    text: `${headText}\n${lines.join('\n')}`,
    fields: { title: subject, text: texts.join(' \n '), participants: [authors.join('; '), to.map((p) => personLabel(p, c.people)).join('; ')].filter(Boolean).join(' · '), coactivity: '' },
  };
}

// --- t4 cards (one per item) ---------------------------------------------------------------------------------

export function t4Card(tag: string, u: ItemUnit, people: ReadonlyMap<string, PersonInfo>, tz: string): Card {
  const to = [...new Set(u.toPersons)];
  const head = `${tag} · ${u.source} ${u.type} · ${localTime(u.ts, tz)} · from ${who(u, people)}${u.authorPerson ? ` [${u.authorPerson}]` : ''}${to.length ? ` · to: ${to.join(', ')}` : ''}${u.container ? ` · in ${clip(u.container, 50)}` : ''}`;
  const ctx = (u.context ?? []).slice(-3).map((m) => `[${clip(m.author ?? '?', 30)}] ${clip(oneLine(hostsOnly(m.text)), 110)}`);
  const subject = u.subject ? `subject: ${clip(oneLine(u.subject), 120)}` : '';
  const room = UNIT_MAX - head.length - subject.length - (ctx.length ? ctx.join(' / ').length + 10 : 0);
  const body = clip(oneLine(hostsOnly(u.text)), Math.max(120, room));
  const lines = [head, subject, ctx.length ? `earlier: ${ctx.join(' / ')}` : '', `text: ${body}`].filter(Boolean);
  return { key: tag, text: lines.join('\n'), fields: { title: u.subject ?? '', text: [u.subject ?? '', body].join(' \n '), participants: to.join(', '), coactivity: '' } };
}

// --- t3 cards (one per surface form) -------------------------------------------------------------------------

export function mentionCard(tag: string, u: MentionUnit): Card {
  const c = u.context ?? {};
  const bits = [`${tag} · "${clip(u.raw, 120)}" · ${u.field} · ${u.source} · seen ${u.seen}×`];
  if (c.title) bits.push(`title: ${clip(oneLine(c.title), 100)}`);
  if (c.coMentions?.length) bits.push(`co-mentioned: ${clip(c.coMentions.slice(0, 8).join('; '), 200)}`);
  if (c.linkedEvent) bits.push(`linked event "${clip(c.linkedEvent.title, 60)}": ${clip(c.linkedEvent.attendees.slice(0, 10).join('; '), 220)}`);
  if (c.speakers?.length) bits.push(`speakers: ${clip(c.speakers.slice(0, 10).join('; '), 160)}`);
  const text = clip(bits.join('\n'), UNIT_MAX);
  return { key: tag, text, fields: { title: c.title ?? '', text, participants: [...(c.coMentions ?? []), ...(c.linkedEvent?.attendees ?? []), ...(c.speakers ?? [])].join('; '), coactivity: '' } };
}

/** The roster as t3/t4 prompts show it: id | name | company | identities (≤3). */
export function rosterLines(ids: string[], people: ReadonlyMap<string, PersonInfo>, withIdentities: boolean): string[] {
  return ids.map((id) => {
    const p = people.get(id);
    if (!p) return id;
    const parts = [id, p.name, p.company ?? '—'];
    if (withIdentities && p.identities.length) parts.push(clip(p.identities.slice(0, 3).join(', '), 120));
    return parts.join(' | ');
  });
}
