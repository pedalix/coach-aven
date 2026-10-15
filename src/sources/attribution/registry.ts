// The tenant's initiative registry (`initiatives.json` at the tenant repo root): the routing table
// every piece of evidence is resolved through — repos, working directories, calendar title patterns,
// chat channels, tracker keys, and the hosts/apps bot posts name. Ported from the owen-ops CLI
// (src/registry.ts) without its legacy person map: people speak through markers (annotations/people.json),
// the registry through places. Pure — parsed JSON in, Routes out — so the ladder can explain why
// something landed where it did.
//
// Confidence: exact = a hard signal (repo or path); default = a soft one (a single title pattern, channel,
// host or app); ambiguous = several candidates and no tie-breaker (the model or a human decides); none = unknown.
export type Confidence = 'exact' | 'default' | 'ambiguous' | 'none';

export interface Route {
  initiative: string | null;
  confidence: Confidence;
  candidates: string[];
  /** Present when the matched initiative is a `split_into` alias: weights sum to 1. */
  split?: Record<string, number>;
  reason: string;
}

/**
 * A chat channel as the registry lists it: a name (`#shop`), or `{id, name}` — the id survives a rename, so
 * a team tenant writes every channel that way — optionally `closed: true` (every host that posts there is
 * listed in `hosts`, so an unknown one is unregistered work).
 */
export type ChannelEntry = string | { id?: string; name?: string; closed?: boolean };

export interface InitiativeSources {
  repos?: string[];
  local_paths?: string[];
  calendar_title_patterns?: string[];
  slack_channels?: ChannelEntry[];
  teams_channels?: ChannelEntry[];
  jira_keys?: string[];
  youtrack_prefixes?: string[];
  /** Hosts bot posts name (`shop.example.com`; a subdomain matches too) and app/deploy tokens — item routing. */
  hosts?: string[];
  apps?: string[];
  [k: string]: unknown;
}

export interface Initiative {
  id: string;
  umbrella?: string;
  name?: string;
  status?: string;
  sources: InitiativeSources;
  alias_of?: string;
  split_into?: Record<string, number>;
  [k: string]: unknown;
}

export interface RegistryData {
  initiatives: Initiative[];
  [k: string]: unknown;
}

/** A channel entry, parsed: matched by `id` first, then by the normalised `name`. */
export interface Channel {
  id: string | null;
  name: string | null;
  /** The entry's name as written, lower-cased: what the person filter compares (channel lists sometimes name people). */
  raw: string | null;
  closed: boolean;
}

/** Accepts `{initiatives: [...]}` (the owen-ops layout) or a bare array; anything else is an error the build logs. */
export function parseRegistry(raw: unknown, where = 'initiatives.json'): RegistryData {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? (raw as { initiatives?: unknown }).initiatives : undefined;
  if (!Array.isArray(list)) throw new Error(`${where}: expected an array of initiatives or {"initiatives": [...]}`);
  const initiatives = list.map((x, i) => {
    if (!x || typeof x !== 'object' || typeof (x as Initiative).id !== 'string' || !(x as Initiative).id) throw new Error(`${where}[${i}]: an initiative needs an "id"`);
    const sources = (x as Initiative).sources;
    return { ...(x as Initiative), sources: sources && typeof sources === 'object' && !Array.isArray(sources) ? sources : {} };
  });
  return { ...(Array.isArray(raw) ? {} : (raw as object)), initiatives };
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : []);

/** A container or channel name as rules and the registry compare it: `#`, `chat:@`, `channel:` and a `| Company` tail off. */
export const normChannel = (s: string): string =>
  s
    .toLowerCase()
    .replace(/^(#|chat:@?|channel:)/, '')
    .replace(/\s*\|.*$/, '')
    .trim();

/** Slack channel ids as entries and refs carry them (`C0…` channels, `G0…` private groups, `D0…` DMs). */
export const CHANNEL_ID = /^[CGD][A-Z0-9]{6,}$/;

/** The Slack channel id inside a message ref (`slack:<team>:<channel>:<ts>`), or null — other sources carry none we parse. */
export function channelIdOf(ref: string | null | undefined): string | null {
  const parts = (ref ?? '').split(':');
  return parts[0] === 'slack' && parts.length >= 4 && CHANNEL_ID.test(parts[2]!) ? parts[2]! : null;
}

function channelOf(entry: unknown): Channel | null {
  if (typeof entry === 'string') {
    const s = entry.trim();
    // An id-shaped string is an id as well as a name: a tenant that listed `C0…` by hand matched the container by name before.
    return s ? { id: CHANNEL_ID.test(s) ? s : null, name: normChannel(s), raw: s.toLowerCase(), closed: false } : null;
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const o = entry as Record<string, unknown>;
  const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : null;
  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : null;
  if (!id && !name) return null;
  return { id, name: name ? normChannel(name) : null, raw: name ? name.toLowerCase() : null, closed: o.closed === true };
}

/** `https://Shop.Example.com:8443/x` → `shop.example.com` — how a host is listed and how a bot post's host is compared. */
export function normHost(s: string): string {
  return (s ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
}

/**
 * Title patterns this short are words, not substrings: "ART" must not fire inside "Karte", nor "Mia" inside "Miami".
 * The word edge is Unicode-aware — JS `\b` only knows ASCII word characters, so it would see an edge inside a Cyrillic
 * word (`ЯERP`) and none where a Cyrillic word begins.
 */
export const SHORT_TITLE_PATTERN = 5;
const LETTER = '[\\p{L}\\p{M}\\p{N}]';
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function titleMatcher(pattern: string): (title: string) => boolean {
  const p = pattern.normalize('NFC').toLowerCase();
  if ([...p].length > SHORT_TITLE_PATTERN) return (t) => (t ?? '').normalize('NFC').toLowerCase().includes(p);
  const re = new RegExp(`(?<!${LETTER})${escapeRe(p)}(?!${LETTER})`, 'iu');
  return (t) => re.test((t ?? '').normalize('NFC'));
}

export class Registry {
  readonly byId: Map<string, Initiative>;
  private readonly parsed = new WeakMap<Initiative, Channel[]>();
  private readonly matchers = new Map<string, (title: string) => boolean>();
  constructor(readonly data: RegistryData) {
    this.byId = new Map(data.initiatives.map((i) => [i.id, i]));
  }

  get(id: string): Initiative | undefined {
    return this.byId.get(id);
  }

  /** Follow `alias_of` chains; an alias with `split_into` stays itself (the split is the answer). */
  resolveAlias(id: string): string {
    let cur = id;
    for (let i = 0; i < 5; i++) {
      const ini = this.byId.get(cur);
      if (!ini?.alias_of || ini.split_into) return cur;
      cur = ini.alias_of;
    }
    return cur;
  }

  private finish(initiative: string | null, confidence: Confidence, candidates: string[], reason: string): Route {
    const resolved = initiative ? this.resolveAlias(initiative) : null;
    const ini = resolved ? this.byId.get(resolved) : undefined;
    return {
      initiative: resolved,
      confidence,
      candidates: [...new Set(candidates.map((c) => this.resolveAlias(c)))],
      ...(ini?.split_into ? { split: ini.split_into } : {}),
      reason,
    };
  }

  /** One alias-resolved hit → default; several → ambiguous with candidates; none → none. */
  private soft(hits: string[], what: string): Route {
    const uniq = [...new Set(hits.map((h) => this.resolveAlias(h)))];
    if (uniq.length === 1) return this.finish(uniq[0]!, 'default', uniq, what);
    if (uniq.length > 1) return this.finish(null, 'ambiguous', uniq, `${what} matches several`);
    return this.finish(null, 'none', [], `${what} unknown`);
  }

  /** Repo routing: a remote URL or `org/repo`; registry entries may omit the host or end in a glob. A hit is exact. */
  routeRepo(remote: string): Route {
    const key = normaliseRepo(remote);
    if (!key) return this.finish(null, 'none', [], 'no remote');
    const hits: string[] = [];
    for (const ini of this.data.initiatives) {
      for (const pat of strings(ini.sources.repos)) {
        if (repoMatches(normaliseRepo(pat), key)) {
          hits.push(ini.id);
          break;
        }
      }
    }
    if (hits.length === 1) return this.finish(hits[0]!, 'exact', hits, `repo ${key}`);
    if (hits.length > 1) return this.finish(null, 'ambiguous', hits, `repo ${key} matches several`);
    return this.finish(null, 'none', [], `repo ${key} unknown`);
  }

  /** Local path routing: the longest `local_paths` prefix wins (folders that are not repos, worktrees under a repo). */
  routePath(cwd: string): Route {
    let best: { id: string; len: number } | null = null;
    const norm = cwd.replace(/\/+$/, '');
    for (const ini of this.data.initiatives) {
      for (const p of strings(ini.sources.local_paths)) {
        const pp = p.replace(/\/+$/, '');
        if (norm === pp || norm.startsWith(pp + '/')) {
          if (!best || pp.length > best.len) best = { id: ini.id, len: pp.length };
        }
      }
    }
    return best ? this.finish(best.id, 'exact', [best.id], `path ${cwd}`) : this.finish(null, 'none', [], `path ${cwd} unknown`);
  }

  /** Calendar title patterns: case-insensitive substring, whole words for patterns of ≤ 5 characters. One hit → default; several → ambiguous. */
  routeTitle(title: string): Route {
    if (!(title ?? '').trim()) return this.finish(null, 'none', [], 'empty title');
    const test = (p: string) => {
      let m = this.matchers.get(p);
      if (!m) this.matchers.set(p, (m = titleMatcher(p)));
      return m(title);
    };
    const hits = this.data.initiatives.filter((ini) => strings(ini.sources.calendar_title_patterns).some(test)).map((ini) => ini.id);
    return this.soft(hits, `title "${title}"`);
  }

  /** Chat channels (Slack, Teams) an initiative lists, parsed: names, `{id, name}` objects, or both. */
  channels(ini: Initiative): Channel[] {
    let cs = this.parsed.get(ini);
    if (!cs) {
      const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
      cs = [...list(ini.sources.slack_channels), ...list(ini.sources.teams_channels)].map(channelOf).filter((c): c is Channel => !!c);
      this.parsed.set(ini, cs);
    }
    return cs;
  }

  /**
   * A chat container: by channel id first (rename-proof), then by normalised name. One initiative → default; a channel
   * several initiatives list → ambiguous, with them as candidates. `people`: lower-case names that are markers, not
   * places — a name-only entry naming a person is skipped (an entry with an id is a place by construction).
   */
  routeChannel(container: string | null | undefined, channelId?: string | null, people: ReadonlySet<string> = new Set()): Route {
    const lists = (match: (c: Channel) => boolean) => this.data.initiatives.filter((i) => this.channels(i).some((c) => match(c) && (!!c.id || !c.raw || !people.has(c.raw)))).map((i) => i.id);
    if (channelId) {
      const byId = lists((c) => c.id === channelId);
      if (byId.length) return this.soft(byId, `channel ${channelId}`);
    }
    const name = normChannel(container ?? '');
    return name ? this.soft(lists((c) => c.name === name), `channel ${container}`) : this.finish(null, 'none', [], 'no channel');
  }

  /** Does the tenant list every host posting in this channel (`closed: true`)? An unknown host there is unregistered work. */
  closedChannel(container: string | null | undefined, channelId?: string | null): boolean {
    const name = normChannel(container ?? '');
    return this.data.initiatives.some((i) => this.channels(i).some((c) => c.closed && ((!!channelId && c.id === channelId) || (!!name && c.name === name))));
  }

  /** Bot items: a host → the initiatives listing it or a parent domain of it; the longest listed host wins (like paths). */
  routeHost(host: string): Route {
    const h = normHost(host);
    if (!h) return this.finish(null, 'none', [], 'no host');
    let best: { ids: string[]; len: number } | null = null;
    for (const ini of this.data.initiatives) {
      for (const x of strings(ini.sources.hosts).map(normHost)) {
        if (!x || (h !== x && !h.endsWith(`.${x}`))) continue;
        if (!best || x.length > best.len) best = { ids: [ini.id], len: x.length };
        else if (x.length === best.len && !best.ids.includes(ini.id)) best.ids.push(ini.id);
      }
    }
    return this.soft(best?.ids ?? [], `host ${h}`);
  }

  /** Bot items: an app/deploy token (case-insensitive, exact) → the initiatives listing it. */
  routeApp(app: string): Route {
    const a = (app ?? '').trim().toLowerCase();
    if (!a) return this.finish(null, 'none', [], 'no app');
    return this.soft(this.data.initiatives.filter((i) => strings(i.sources.apps).some((x) => x.trim().toLowerCase() === a)).map((i) => i.id), `app ${a}`);
  }

  /** Tracker keys (Jira keys, YouTrack prefixes) an initiative lists. */
  keysOf(ini: Initiative): string[] {
    return [...strings(ini.sources.jira_keys), ...strings(ini.sources.youtrack_prefixes)];
  }

  umbrellaOf(initiative: string | null): string | null {
    return initiative ? (this.byId.get(initiative)?.umbrella ?? null) : null;
  }
}

/** `https://github.com/Org/Repo.git` | `git@host:Org/Repo.git` | `Org/Repo` → `host/org/repo` or `org/repo` (lowercase). */
export function normaliseRepo(s: string): string {
  let r = s.trim();
  r = r.replace(/^[a-z+]+:\/\//i, '');
  r = r.replace(/^[^@/]+@([^:/]+)[:/]/, '$1/');
  r = r.replace(/\.git$/, '').replace(/\/+$/, '');
  return r.toLowerCase();
}

/** Match on the `org/repo` tail so entries with or without a host both work; `*` is a glob. */
export function repoMatches(pattern: string, key: string): boolean {
  const tail = (x: string) => x.split('/').slice(-2).join('/');
  const p = pattern.includes('/') && pattern.split('/').length >= 3 ? tail(pattern) : pattern;
  const k = tail(key);
  if (!p.includes('*')) return p === k;
  const re = new RegExp('^' + p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(k);
}
