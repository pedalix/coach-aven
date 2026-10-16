// Stage 0 — the tenant's registry (initiatives.json) as the floor reads it (design notes/10-design.md §2.1 F2, F6).
// The production Registry (src/sources/attribution/registry.ts) is left untouched; this bench copy fixes what the
// design lists, so the fixes can be measured before they are ported:
//   F6  channel entries may be `{id, name}` objects (a team tenant writes them all that way, and production drops them);
//       the channel id is matched first (rename-proof), then the normalised name; a channel listed by ≥2 initiatives
//       gives candidates instead of falling through; optional `sources.hosts` / `sources.apps` route bot items, and a
//       channel object may declare its host list closed (`closed: true`), so an unknown host there is `unregistered`.
//   F2  title patterns of ≤5 characters match whole words only (Unicode-aware: JS `\b` fails on Cyrillic), so
//       "ART" no longer fires inside "Karte" nor "Mia" inside "Miami"; longer patterns stay case-insensitive substrings.
// Ids are alias-resolved (`alias_of` chains); a `split_into` alias stays itself until expand() spreads it into its
// targets — the label space never holds an alias. `done` initiatives stay routable (work is still billed to them) and
// are only flagged on their cards. Pure: parsed JSON in, routes out.

import { normaliseRepo, repoMatches } from '../../../sources/attribution/registry.js';

export interface Channel {
  id: string | null; // Slack/Teams channel id (rename-proof)
  name: string | null; // normalised name (normChannel)
  closed: boolean; // the tenant lists every host that posts here: an unknown host is unregistered work
}

export interface Ini {
  id: string;
  umbrella: string;
  name: string;
  status: string;
  done: boolean;
  code: string | null; // billing code
  company: string | null;
  aliasOf: string | null;
  splitInto: Record<string, number> | null;
  repos: string[];
  paths: string[];
  titles: string[];
  channels: Channel[];
  keys: string[]; // tracker key prefixes (Jira keys, YouTrack prefixes), upper case
  hosts: string[]; // normalised host names
  apps: string[]; // app/deploy tokens, lower case
}

export interface Company {
  id: string;
  umbrella: string | null;
  name: string;
  domains: string[];
}

export interface Hits {
  hits: string[]; // alias-resolved initiative ids (a split alias stays itself; expand() spreads it)
  via: string; // what matched first (the rung instance's tail: a pattern, a key, a channel)
}

const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : typeof v === 'string' && v.trim() ? [v.trim()] : [];

/** A channel or container name as rules and registries compare it (production ladder norm: `#`, `chat:@`, `channel:`, `| Co` off). */
export const normChannel = (s: string | null | undefined): string =>
  (s ?? '')
    .toLowerCase()
    .replace(/^(#|chat:@?|channel:)/, '')
    .replace(/\s*\|.*$/, '')
    .trim();

/** Slack/Teams channel ids as they appear in refs (`C0…`, `G0…`, `D0…`). */
export const CHANNEL_ID = /^[CGD][A-Z0-9]{6,}$/;

/** `https://Shop.Example.com:8443/x` → `shop.example.com`. */
export const normHost = (s: string): string =>
  (s ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Patterns this short are words, not substrings (F2). */
export const SHORT_PATTERN = 5;

export function titleMatcher(pattern: string): (title: string) => boolean {
  const p = pattern.toLowerCase();
  if ([...p].length <= SHORT_PATTERN) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(p)}(?![\\p{L}\\p{N}])`, 'iu');
    return (t) => re.test(t ?? '');
  }
  return (t) => (t ?? '').toLowerCase().includes(p);
}

function channelOf(entry: unknown): Channel | null {
  if (typeof entry === 'string') {
    const s = entry.trim();
    if (!s) return null;
    return CHANNEL_ID.test(s) ? { id: s, name: null, closed: false } : { id: null, name: normChannel(s), closed: false };
  }
  if (!entry || typeof entry !== 'object') return null;
  const o = entry as Record<string, unknown>;
  const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : null;
  const name = typeof o.name === 'string' && o.name.trim() ? normChannel(o.name) : null;
  if (!id && !name) return null;
  return { id, name, closed: o.closed === true || o.hosts === 'closed' };
}

// Domains in free text ("acme.example, acme-hotels.example" in a company's notes): a token with a dot and a TLD.
const DOMAIN_TOKEN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
const domainsIn = (text: string): string[] =>
  (text ?? '')
    .toLowerCase()
    .split(/[\s,;()]+/)
    .map((t) => t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''))
    .filter((t) => DOMAIN_TOKEN.test(t) && !/\.(?:md|json|ts|js|txt)$/.test(t));

export class Reg {
  readonly list: Ini[];
  readonly byId: Map<string, Ini>;
  readonly companies: Company[];
  private readonly titleMatchers: { ini: Ini; pattern: string; test: (t: string) => boolean }[];

  /** `raw`: initiatives.json as parsed (`{initiatives: [...]}` or a bare array). `personNames`: folded or lower-case names of
   * people — a channel list naming a person is a marker, not a place (production skips those entries too). */
  constructor(raw: unknown, personNames: ReadonlySet<string> = new Set()) {
    const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? (raw as { initiatives?: unknown }).initiatives : undefined;
    const out: Ini[] = [];
    const seen = new Set<string>();
    for (const x of Array.isArray(list) ? list : []) {
      if (!x || typeof x !== 'object') continue;
      const o = x as Record<string, unknown>;
      const id = typeof o.id === 'string' ? o.id.trim() : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const src = (o.sources && typeof o.sources === 'object' && !Array.isArray(o.sources) ? o.sources : {}) as Record<string, unknown>;
      const status = typeof o.status === 'string' ? o.status : '';
      const split = o.split_into && typeof o.split_into === 'object' && !Array.isArray(o.split_into) ? (o.split_into as Record<string, unknown>) : null;
      const channels = [...(Array.isArray(src.slack_channels) ? src.slack_channels : []), ...(Array.isArray(src.teams_channels) ? src.teams_channels : []), ...(Array.isArray(src.channels) ? src.channels : [])]
        .map(channelOf)
        .filter((c): c is Channel => !!c && !(c.name && !c.id && personNames.has(c.name)));
      out.push({
        id,
        umbrella: typeof o.umbrella === 'string' && o.umbrella ? o.umbrella : id.split('/')[0]!,
        name: typeof o.name === 'string' && o.name ? o.name : id,
        status,
        done: /^(done|closed|finished|archived|completed)$/i.test(status),
        code: typeof o.billing_code === 'string' && o.billing_code ? o.billing_code : typeof o.code === 'string' && o.code ? o.code : null,
        company: typeof o.company === 'string' && o.company ? o.company : null,
        aliasOf: typeof o.alias_of === 'string' && o.alias_of ? o.alias_of : null,
        splitInto: split ? Object.fromEntries(Object.entries(split).filter((e): e is [string, number] => typeof e[1] === 'number' && e[1] > 0)) : null,
        repos: strs(src.repos),
        paths: strs(src.local_paths),
        titles: strs(src.calendar_title_patterns),
        channels,
        keys: [...new Set([...strs(src.jira_keys), ...strs(src.youtrack_prefixes), ...strs(src.tracker_keys)].map((k) => k.toUpperCase()))],
        hosts: [...new Set(strs(src.hosts).map(normHost).filter(Boolean))],
        apps: [...new Set(strs(src.apps).map((a) => a.toLowerCase()))],
      });
    }
    this.list = out;
    this.byId = new Map(out.map((i) => [i.id, i]));
    const comps = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { companies?: unknown }).companies : undefined;
    this.companies = (Array.isArray(comps) ? comps : [])
      .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && typeof (c as { id?: unknown }).id === 'string')
      .map((c) => ({
        id: String(c.id),
        umbrella: typeof c.umbrella === 'string' && c.umbrella ? c.umbrella : null,
        name: typeof c.name === 'string' ? c.name : String(c.id),
        domains: [...new Set([...strs(c.domains).map((d) => d.toLowerCase()), ...domainsIn(typeof c.notes === 'string' ? c.notes : '')])],
      }));
    this.titleMatchers = out.flatMap((ini) => ini.titles.map((pattern) => ({ ini, pattern, test: titleMatcher(pattern) })));
  }

  get(id: string): Ini | undefined {
    return this.byId.get(id);
  }

  /** Follow `alias_of` chains; a `split_into` alias stays itself (expand() spreads it). Unknown ids pass through. */
  resolve(id: string): string {
    let cur = id;
    for (let i = 0; i < 6; i++) {
      const ini = this.byId.get(cur);
      if (!ini?.aliasOf || ini.splitInto) return cur;
      cur = ini.aliasOf;
    }
    return cur;
  }

  /** An id as labels: alias-resolved, a split spread into its targets (shares sum to 1, largest first, ties in registry order). */
  expand(id: string, depth = 0): { id: string; share: number }[] {
    const r = this.resolve(id);
    const split = this.byId.get(r)?.splitInto;
    if (!split || depth > 3 || !Object.keys(split).length) return [{ id: r, share: 1 }];
    const sum = Object.values(split).reduce((a, b) => a + b, 0) || 1;
    const acc = new Map<string, number>();
    for (const [t, w] of Object.entries(split)) for (const x of this.expand(t, depth + 1)) acc.set(x.id, (acc.get(x.id) ?? 0) + (w / sum) * x.share);
    return [...acc].map(([i, share]) => ({ id: i, share })).sort((a, b) => b.share - a.share);
  }

  /** The label an id stands for: its largest expanded share. */
  label(id: string): string {
    return this.expand(id)[0]!.id;
  }

  /** Every label id an id may stand for (a split: all its targets). */
  labels(id: string): string[] {
    return this.expand(id).map((x) => x.id);
  }

  umbrellaOf(id: string | null | undefined): string | null {
    if (!id) return null;
    const l = this.label(id);
    return this.byId.get(l)?.umbrella ?? this.byId.get(this.resolve(id))?.umbrella ?? null;
  }

  /** The registry's label ids: every initiative that is neither an alias nor a split, in registry order. */
  labelIds(): string[] {
    return [...new Set(this.list.flatMap((i) => (i.aliasOf || i.splitInto ? this.labels(i.id) : [i.id])))];
  }

  private uniq(ids: string[]): string[] {
    return [...new Set(ids.map((i) => this.resolve(i)))];
  }

  /** Work: a repo remote (`org/repo`, URL, scp form); exact matches only. */
  routeRepo(remote: string | null | undefined): Hits {
    const key = remote ? normaliseRepo(remote) : '';
    if (!key) return { hits: [], via: '' };
    const hits = this.list.filter((i) => i.repos.some((p) => repoMatches(normaliseRepo(p), key))).map((i) => i.id);
    return { hits: this.uniq(hits), via: key.split('/').slice(-2).join('/') };
  }

  /** Work: the longest `local_paths` prefix of a working directory. */
  routePath(cwd: string | null | undefined): Hits {
    const norm = (cwd ?? '').replace(/\/+$/, '');
    if (!norm) return { hits: [], via: '' };
    let best: { ids: string[]; len: number; p: string } | null = null;
    for (const ini of this.list) {
      for (const p of ini.paths) {
        const pp = p.replace(/\/+$/, '');
        if (norm !== pp && !norm.startsWith(pp + '/')) continue;
        if (!best || pp.length > best.len) best = { ids: [ini.id], len: pp.length, p: pp };
        else if (pp.length === best.len) best.ids.push(ini.id);
      }
    }
    return best ? { hits: this.uniq(best.ids), via: best.p } : { hits: [], via: '' };
  }

  /** Calls: a meeting title against every calendar title pattern (F2: ≤5 chars whole-word). */
  routeTitle(title: string | null | undefined): Hits {
    const t = title ?? '';
    if (!t.trim()) return { hits: [], via: '' };
    const hits: string[] = [];
    let via = '';
    for (const m of this.titleMatchers) {
      if (!m.test(t)) continue;
      hits.push(m.ini.id);
      if (!via) via = m.pattern.toLowerCase();
    }
    return { hits: this.uniq(hits), via };
  }

  /** A container by channel id first (rename-proof), then by normalised name (F6). */
  routeChannel(container: string | null | undefined, channelId?: string | null): Hits {
    if (channelId) {
      const byId = this.list.filter((i) => i.channels.some((c) => c.id === channelId)).map((i) => i.id);
      if (byId.length) return { hits: this.uniq(byId), via: channelId };
    }
    const name = normChannel(container);
    if (!name) return { hits: [], via: '' };
    const byName = this.list.filter((i) => i.channels.some((c) => c.name === name)).map((i) => i.id);
    return { hits: this.uniq(byName), via: name };
  }

  /** Does the tenant say every host posting in this channel is listed (an unknown one is then unregistered work)? */
  closedChannel(container: string | null | undefined, channelId?: string | null): boolean {
    const name = normChannel(container);
    return this.list.some((i) => i.channels.some((c) => c.closed && ((!!channelId && c.id === channelId) || (!!name && c.name === name))));
  }

  /** Tracker key prefixes (`VN`, `ESET`): every initiative listing one of them. `via` = the first prefix that hit. */
  routeKeys(prefixes: readonly string[]): Hits {
    const hits: string[] = [];
    let via = '';
    for (const k of prefixes) {
      const K = k.toUpperCase();
      const here = this.list.filter((i) => i.keys.includes(K)).map((i) => i.id);
      if (here.length && !via) via = K;
      hits.push(...here);
    }
    return { hits: this.uniq(hits), via };
  }

  /** Bot items: a host name (exact, or a subdomain of a listed host). */
  routeHost(host: string): Hits {
    const h = normHost(host);
    if (!h) return { hits: [], via: '' };
    const hits = this.list.filter((i) => i.hosts.some((x) => h === x || h.endsWith(`.${x}`))).map((i) => i.id);
    return { hits: this.uniq(hits), via: h };
  }

  routeApp(app: string): Hits {
    const a = (app ?? '').trim().toLowerCase();
    if (!a) return { hits: [], via: '' };
    return { hits: this.uniq(this.list.filter((i) => i.apps.includes(a)).map((i) => i.id)), via: a };
  }

  /** Does the registry route bot items by host/app at all? (No tenant does today; the rungs stay silent then.) */
  hasHostsOrApps(): boolean {
    return this.list.some((i) => i.hosts.length > 0 || i.apps.length > 0);
  }

  /** A mail domain → the company that owns it (explicit `domains`, or domains named in its notes). */
  companyOfDomain(domain: string | null | undefined): Company | null {
    const d = (domain ?? '').toLowerCase();
    if (!d) return null;
    const hits = this.companies.filter((c) => c.domains.some((x) => d === x || d.endsWith(`.${x}`)));
    return hits.length === 1 ? hits[0]! : null;
  }

  /** The label ids of a company's initiatives (a company with none: its umbrella's). */
  initiativesOfCompany(company: string, umbrella: string | null): string[] {
    const own = this.list.filter((i) => i.company === company && !i.aliasOf && !i.splitInto).map((i) => i.id);
    if (own.length) return own;
    return umbrella ? this.list.filter((i) => i.umbrella === umbrella && !i.aliasOf && !i.splitInto).map((i) => i.id) : [];
  }
}
