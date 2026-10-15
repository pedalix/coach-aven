// The tenant's initiative registry (`initiatives.json` at the tenant repo root): the routing table
// every piece of evidence is resolved through — repos, working directories, calendar title patterns,
// chat channels and tracker keys. Ported from the owen-ops CLI (src/registry.ts) without its legacy
// person map: people speak through markers (annotations/people.json), the registry through places.
// Pure — parsed JSON in, Routes out — so the ladder can explain why something landed where it did.
//
// Confidence: exact = a hard signal (repo or path); default = a soft one (a single title pattern);
// ambiguous = several candidates and no tie-breaker (the model or a human decides); none = unknown.
export type Confidence = 'exact' | 'default' | 'ambiguous' | 'none';

export interface Route {
  initiative: string | null;
  confidence: Confidence;
  candidates: string[];
  /** Present when the matched initiative is a `split_into` alias: weights sum to 1. */
  split?: Record<string, number>;
  reason: string;
}

export interface InitiativeSources {
  repos?: string[];
  local_paths?: string[];
  calendar_title_patterns?: string[];
  slack_channels?: string[];
  teams_channels?: string[];
  jira_keys?: string[];
  youtrack_prefixes?: string[];
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

export class Registry {
  readonly byId: Map<string, Initiative>;
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

  /** Calendar title patterns: case-insensitive substring. One hit → default; several → ambiguous. */
  routeTitle(title: string): Route {
    const t = (title ?? '').toLowerCase();
    if (!t) return this.finish(null, 'none', [], 'empty title');
    const hits: string[] = [];
    for (const ini of this.data.initiatives) {
      if (strings(ini.sources.calendar_title_patterns).some((p) => t.includes(p.toLowerCase()))) hits.push(ini.id);
    }
    const uniq = [...new Set(hits.map((h) => this.resolveAlias(h)))];
    if (uniq.length === 1) return this.finish(uniq[0]!, 'default', uniq, `title "${title}"`);
    if (uniq.length > 1) return this.finish(null, 'ambiguous', uniq, `title "${title}" matches several`);
    return this.finish(null, 'none', [], `title "${title}" unknown`);
  }

  /** Chat channel names (Slack, Teams) an initiative lists. */
  channelsOf(ini: Initiative): string[] {
    return [...strings(ini.sources.slack_channels), ...strings(ini.sources.teams_channels)];
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
