// K2a (notes/20-iter2.md §K2a.1) — cues: what in a unit's own words points at one initiative of a client rather than at
// its siblings. A structural rung (key, rule, channel, exclusive marker, title) says WHICH CLIENT; the cues are the only
// thing that may say which of the client's initiatives, and only where they discriminate.
//
// Cues of an initiative are its registry card (stage0 cards(): the facts the tenant wrote down, never labels):
//   word     name tokens (≥4 letters; a parenthesised note like "(fixed price, go-live W3→W4)" or "(Alpenhof is the
//            pilot)" is a remark, not a name), calendar title patterns, repo / local-path basenames, app tokens, and the
//            id's last segment split on '-' (`velonord/erp-sync` → erp, sync)
//   key      tracker key prefixes, as `VN-<n>`
//   channel  channel names (`#ext-velonord`, '#' optional) and ids
//   host     registry hosts
// The alias entries of an initiative lend it their cues (a renamed project keeps its old words), as on the cards.
//
// Dropped, so a cue names a topic and not a party: tokens of a company name or an umbrella id ("Velo Nord" is the client,
// not the shop; "Alpenhof" in Booker's remark is the pilot customer), person names, function words. Within one client a
// cue two initiatives share (`#ext-alpenhof`, the `ALP` prefix, "booker") cannot tell them apart and is dropped from all
// of them (distinctive()). The cue that made the rung fire (`key:VN` → the `VN-` prefix; a rule's container; a title
// pattern) is excluded by the caller (triggerCues): a key cannot corroborate itself.
//
// Matching is on the folded text (NFKD, marks dropped, lower case) with Unicode-aware word edges (JS \b is ASCII-only):
// a word of ≤4 letters is whole ("erp", "sync", "shop"/"shops"), a longer one a word START ("relaunch" also finds
// "relaunched"), a phrase's parts may be joined by space, '-', '_', '/' or '.'. Pure.

import { STOPWORDS, fold } from '../judge/text.js';
import type { Ini, Reg } from '../stage0/registry.js';
import { normChannel } from '../stage0/registry.js';
import type { Rule } from '../stage0/tenant.js';

export type CueKind = 'word' | 'key' | 'channel' | 'host';

export interface Cue {
  kind: CueKind;
  norm: string; // the comparable form: 'erp sync', 'key:VN', '#ext-velonord', 'id:c0ext00001', 'host:shop.example'
  re: RegExp; // tested against folded text
}

const L = '[\\p{L}\\p{N}]';
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const parts = (s: string): string[] => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const letters = (s: string): number => (s.match(/\p{L}/gu) ?? []).length;

/** A word or phrase cue: short last parts are whole words (an optional plural), long ones a word start. */
export function wordCue(text: string): Cue | null {
  const ps = parts(text);
  if (!ps.length) return null;
  const last = ps[ps.length - 1]!;
  const body = ps.map(escapeRe).join('[\\s_\\-/.]+');
  const tail = [...last].length <= 4 ? `(?:e?s)?(?!${L})` : '';
  return { kind: 'word', norm: ps.join(' '), re: new RegExp(`(?<!${L})${body}${tail}`, 'u') };
}

export function keyCue(prefix: string): Cue | null {
  const k = prefix.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{0,9}$/.test(k)) return null;
  return { kind: 'key', norm: `key:${k}`, re: new RegExp(`(?<!${L})${escapeRe(k.toLowerCase())}-\\d+`, 'u') };
}

export function channelCues(c: { id: string | null; name: string | null }): Cue[] {
  const out: Cue[] = [];
  if (c.name) {
    const ps = parts(c.name);
    if (ps.length) out.push({ kind: 'channel', norm: `#${normChannel(c.name)}`, re: new RegExp(`(?<!${L})#?${ps.map(escapeRe).join('[\\s_\\-.]+')}(?!${L})`, 'u') });
  }
  if (c.id) out.push({ kind: 'channel', norm: `id:${fold(c.id)}`, re: new RegExp(`(?<!${L})${escapeRe(fold(c.id))}(?!${L})`, 'u') });
  return out;
}

export function hostCue(host: string): Cue | null {
  const h = fold(host).trim();
  if (!h.includes('.')) return null;
  return { kind: 'host', norm: `host:${h}`, re: new RegExp(`(?<![\\p{L}\\p{N}-])${escapeRe(h)}(?![\\p{L}\\p{N}-])`, 'u') };
}

export interface CueVocab {
  parties: ReadonlySet<string>; // folded tokens of company names/ids and umbrella ids: they name a client, not a topic
  names: ReadonlySet<string>; // folded tokens of people's names
}

/** The parties a registry names: every company's id and name tokens, every umbrella id (folded). */
export function partyTokens(reg: Reg): Set<string> {
  const out = new Set<string>();
  for (const c of reg.companies) for (const t of [...parts(c.id), ...parts(c.name)]) out.add(t);
  for (const i of reg.list) for (const t of parts(i.umbrella)) out.add(t);
  return out;
}

const noRemarks = (name: string): string => name.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');
const basename = (p: string): string => p.replace(/\.git$/, '').replace(/[/*]+$/, '').split('/').filter(Boolean).pop() ?? '';

/** A word cue unless the phrase is only parties, names or function words. */
function topical(text: string, v: CueVocab): Cue | null {
  const ps = parts(text);
  if (!ps.length || ps.every((p) => v.parties.has(p) || v.names.has(p) || STOPWORDS.has(p) || /^\d+$/.test(p))) return null;
  return wordCue(text);
}

/** The raw cues of one registry initiative and its aliases (before the distinctiveness filter). */
export function initiativeCues(reg: Reg, id: string, v: CueVocab): Cue[] {
  const ini = reg.get(id);
  const sources: Ini[] = [...(ini ? [ini] : []), ...reg.list.filter((i) => (i.aliasOf || i.splitInto) && i.id !== id && reg.labels(i.id).includes(id))];
  const out: Cue[] = [];
  const add = (c: Cue | null) => {
    if (c && !out.some((x) => x.norm === c.norm)) out.push(c);
  };
  for (const s of sources) {
    for (const t of parts(noRemarks(s.name))) if ([...t].length >= 4 && letters(t) >= 3 && !STOPWORDS.has(t) && !v.parties.has(t) && !v.names.has(t)) add(wordCue(t));
    for (const p of s.titles) add(topical(p, v));
    for (const r of [...s.repos, ...s.paths]) add(topical(basename(r), v));
    for (const a of s.apps) add(topical(a, v));
    for (const k of s.keys) add(keyCue(k));
    for (const c of s.channels) for (const x of channelCues(c)) add(x);
    for (const h of s.hosts) add(hostCue(h));
  }
  // the id's last segment, split on '-': `velonord/erp-sync` → erp, sync (3 letters suffice: erp, app, hub)
  for (const t of (id.split('/').pop() ?? '').split('-')) {
    const f = fold(t);
    if ([...f].length >= 3 && letters(f) >= 2 && !STOPWORDS.has(f) && !v.parties.has(f) && !v.names.has(f)) add(wordCue(f));
  }
  return out;
}

/** Within one client: keep only the cues exactly one of `ids` carries. */
export function distinctive(raw: ReadonlyMap<string, Cue[]>, ids: readonly string[]): Map<string, Cue[]> {
  const owners = new Map<string, number>();
  for (const id of ids) for (const n of new Set((raw.get(id) ?? []).map((c) => c.norm))) owners.set(n, (owners.get(n) ?? 0) + 1);
  return new Map(ids.map((id) => [id, (raw.get(id) ?? []).filter((c) => owners.get(c.norm) === 1)]));
}

/**
 * The cue norms the rung itself rests on — a structural route cannot corroborate itself: `key:VN` → `key:VN`;
 * `channel:<id|name>` → that channel; `rule:<id>` → the rule's container and project key; `title:<pattern>` → the pattern.
 * An exclusive marker is a person, never a cue: nothing to drop.
 */
export function triggerCues(rung: string, rules: ReadonlyMap<string, Rule>): Set<string> {
  const out = new Set<string>();
  const i = rung.indexOf(':');
  const kind = i > 0 ? rung.slice(0, i) : rung;
  const via = i > 0 ? rung.slice(i + 1) : '';
  if (kind === 'key') out.add(`key:${via.toUpperCase()}`);
  else if (kind === 'channel') {
    out.add(`#${normChannel(via)}`);
    out.add(`id:${fold(via)}`);
  } else if (kind === 'title') {
    const c = wordCue(via);
    if (c) out.add(c.norm);
  } else if (kind === 'rule') {
    const r = rules.get(via);
    if (r?.when?.container) out.add(`#${normChannel(r.when.container)}`);
    if (r?.when?.project_key) out.add(`key:${r.when.project_key.toUpperCase()}`);
  }
  return out;
}

/** The norms of the cues a folded text carries, in cue order. */
export function hits(cues: readonly Cue[], folded: string, skip: ReadonlySet<string> = new Set()): string[] {
  return cues.filter((c) => !skip.has(c.norm) && c.re.test(folded)).map((c) => c.norm);
}

/** The text a unit's cues are read from, folded: an item's subject and text, a fragment's title and text. */
export const cueText = (u: { subject?: string | null; title?: string | null; text?: string | null }): string => fold([u.subject ?? u.title ?? '', u.text ?? ''].join('\n'));
