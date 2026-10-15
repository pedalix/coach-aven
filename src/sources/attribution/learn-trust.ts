// Sibling-aware trust (notes/20-iter2.md K2a §1, "trust repair"): a structural rung — a tracker key, a container or
// channel rule, a registry channel, an exclusive marker, a title, a host — maps ONE key or place to ONE initiative X. When
// X's client runs other active initiatives ("siblings": VN = shop + ERP sync; BKR = booker + booker support; the Alpenhof
// channel = relaunch + retainer) the route is right about the CLIENT and only a guess about the initiative: iteration 1
// measured key:VN 52% and key:BKR 54% right, every error inside the client, and audits too rare to catch them. So:
//   no siblings                                       X keeps the rung's confidence
//   a cue of X, none of a sibling                     X keeps it
//   cues of one sibling Y, none of X                  Y at .60 (a guess: asked)
//   cues of both, or of several siblings equally      X at .85 (a confirm question, guess X)
//   no cue either way                                 X at .85 — unless answers on the route's own units (the `ctx` key,
//                                                     k agreeing answers, never contradicted) already confirmed X
// and in every case the CLIENT is decided at the route's (client-level calibrated) confidence: questions about such units
// are asked per client and day (learn.ts). A deciding key of the unit itself (its answered thread …) still decides on
// top of this — the keys outrank a floor that is below τ.
//
// Cues of an initiative are its registry card as L2 hands them over (InitiativeInfo.cues): name tokens, title patterns,
// channels, key prefixes, repo basenames, hosts/apps — plus the id's last segment split on '-' (`velonord/erp-sync` →
// erp, sync), added here. Plain strings are words or phrases; `#name` a channel, a dotted name a host; typed forms
// (`key:VN`, `host:h`, `channel:C0…`, `repo:org/r`, `app:a`, `title:p`) say what they are. Dropped, so a cue names a topic
// and not a party: cues that are only a client's name (an umbrella or company id: "Velo Nord" names the client, not the
// shop), function words, and within one client every cue two of its initiatives share ("booker" of booker and booker
// support). The cue the rung itself rests on (`key:VN` → `VN-…`, a channel rule's channel, a title pattern) never
// counts: a route cannot corroborate itself (`trigger` adds what only L2 knows, e.g. a rule's container).
//
// Matching is on the folded text (NFKD, marks dropped, lower case) with Unicode-aware word edges (JS \b is ASCII-only): a
// word of ≤ 4 letters is whole ("erp", "sync", "shop"/"shops"), a longer one a word start ("relaunch" also finds
// "relaunched"); a phrase's parts may be joined by space, '-', '_', '/' or '.'. Pure.

export const SIBLING_GUESS = 0.6;
export const DOUBT = 0.85;

/** What the trust step needs of an initiative (a subset of learn.ts InitiativeInfo). */
export interface TrustInitiative {
  id: string;
  umbrella: string;
  company?: string;
  active: boolean;
  cues: readonly string[];
  admin?: boolean;
}

export interface Cue {
  norm: string; // the comparable form: 'erp sync', 'key:VN', '#ext-velonord', 'id:c0ext00001', 'host:shop.example'
  re: RegExp; // tested against folded text
}

const L = '[\\p{L}\\p{N}]';
const CHANNEL_ID = /^[CGD][A-Z0-9]{6,}$/;
const HOST = /^(?:[a-z][a-z0-9+.-]*:\/\/)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}(?::\d+)?(?:\/\S*)?$/i;
// Function words (EN/DE/RU/IT): a name token like "and" or "für" is no cue.
const STOP = new Set(
  `the and for with from into onto over under this that these those our your their its own not but are was were has have
  der die das den dem des ein eine und oder mit von vom zum zur für fur auf aus bei nach über uber unter
  и в на с по для от до из за как что это
  il lo la gli le un una del della dei delle per con tra fra che non`
    .split(/\s+/)
    .filter(Boolean),
);

export const fold = (s: string | null | undefined): string => (s ?? '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
const parts = (s: string): string[] => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const letters = (s: string): number => (s.match(/\p{L}/gu) ?? []).length;
const basename = (p: string): string => p.replace(/\.git$/, '').replace(/[/*]+$/, '').split(/[/:]/).filter(Boolean).pop() ?? '';
const lastSegment = (id: string): string => id.split('/').pop() ?? id;

/** A word or phrase: a short last part is a whole word (an optional plural), a long one a word start. */
export function wordCue(text: string): Cue | null {
  const ps = parts(text);
  if (!ps.length) return null;
  if (ps.length === 1 && (letters(ps[0]!) < 2 || STOP.has(ps[0]!))) return null;
  const last = ps[ps.length - 1]!;
  const tail = [...last].length <= 4 ? `(?:e?s)?(?!${L})` : '';
  return { norm: ps.join(' '), re: new RegExp(`(?<!${L})${ps.map(esc).join('[\\s_\\-/.]+')}${tail}`, 'u') };
}

/** A tracker key prefix: matches `VN-<n>`, never the bare letters. */
export function keyCue(prefix: string): Cue | null {
  const k = prefix.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{0,9}$/.test(k)) return null;
  return { norm: `key:${k}`, re: new RegExp(`(?<!${L})${esc(k.toLowerCase())}-\\d+`, 'u') };
}

export function channelCue(name: string): Cue | null {
  const ps = parts(name.replace(/^(?:#|channel:)/i, ''));
  if (!ps.length) return null;
  return { norm: `#${ps.join('-')}`, re: new RegExp(`(?<!${L})#?${ps.map(esc).join('[\\s_\\-.]+')}(?!${L})`, 'u') };
}

const idCue = (id: string): Cue => ({ norm: `id:${fold(id)}`, re: new RegExp(`(?<!${L})${esc(fold(id))}(?!${L})`, 'u') });

export function hostCue(host: string): Cue | null {
  const h = fold(host)
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^www\./, '')
    .replace(/\.$/, '');
  if (!h.includes('.')) return null;
  return { norm: `host:${h}`, re: new RegExp(`(?<![\\p{L}\\p{N}-])${esc(h)}(?![\\p{L}\\p{N}-])`, 'u') };
}

/** One cue string as L2 hands it over: typed (`key:VN`, `host:h`, `channel:…`, `repo:…`, `app:…`) or plain. */
export function parseCue(raw: string): Cue | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const m = /^(key|host|channel|id|repo|path|app|title|word|name):\s*(.+)$/i.exec(s);
  if (m) {
    const body = m[2]!.trim();
    switch (m[1]!.toLowerCase()) {
      case 'key':
        return keyCue(body);
      case 'host':
        return hostCue(body);
      case 'channel':
      case 'id':
        return CHANNEL_ID.test(body) ? idCue(body) : channelCue(body);
      case 'repo':
      case 'path':
        return wordCue(basename(body));
      default:
        return wordCue(body);
    }
  }
  if (s.startsWith('#')) return channelCue(s);
  if (CHANNEL_ID.test(s)) return idCue(s);
  if (HOST.test(s)) return hostCue(s);
  return wordCue(s);
}

/**
 * The cue norms a rung instance rests on — a structural route cannot corroborate itself: `key:VN` → the `VN-…` key and
 * the bare word; `channel:<id|name>` → that channel; `title:<p>` → the pattern; `host:`/`app:`/`repo:` → that token.
 * `extra`: cues only the caller knows (a rule's container or project key).
 */
export function triggerNorms(rung: string, extra: readonly string[] = []): Set<string> {
  const out = new Set<string>();
  const add = (c: Cue | null) => {
    if (c) out.add(c.norm);
  };
  const i = rung.indexOf(':');
  const kind = i > 0 ? rung.slice(0, i) : rung;
  const via = i > 0 ? rung.slice(i + 1).trim() : '';
  if (via) {
    if (kind === 'key') {
      add(keyCue(via));
      add(wordCue(via));
    } else if (kind === 'channel') {
      if (CHANNEL_ID.test(via)) add(idCue(via));
      add(channelCue(via));
      add(wordCue(via));
    } else if (kind === 'host') add(hostCue(via));
    else if (kind === 'repo' || kind === 'path') add(wordCue(basename(via)));
    else if (kind === 'title' || kind === 'app') add(wordCue(via));
  }
  for (const x of extra) add(parseCue(x));
  return out;
}

/** The norms of the cues a folded text carries, in cue order. */
export const hits = (cues: readonly Cue[], folded: string, skip: ReadonlySet<string>): string[] => cues.filter((c) => !skip.has(c.norm) && c.re.test(folded)).map((c) => c.norm);

const isAdmin = (i: TrustInitiative): boolean => i.admin === true || lastSegment(i.id) === 'admin';
const isPersonal = (i: TrustInitiative): boolean => i.umbrella === 'personal' || i.id === 'personal' || lastSegment(i.id) === 'personal';
const clientOf = (i: TrustInitiative): string => i.company || i.umbrella;

export interface CueHits {
  siblings: string[];
  own: string[]; // X's distinctive cues the text carries (the trigger excluded)
  sib: [string, string[]][]; // per sibling (registry order): its distinctive cues the text carries
}

/** The registry as the trust step reads it: clients, siblings and their distinctive cues. */
export class Siblings {
  private readonly byId: Map<string, TrustInitiative>;
  private readonly parties: Set<string>;
  private readonly raw = new Map<string, Cue[]>();
  private readonly scopes = new Map<string, { siblings: string[]; cues: Map<string, Cue[]> }>();

  constructor(initiatives: readonly TrustInitiative[]) {
    this.byId = new Map();
    for (const i of initiatives) if (i?.id && !this.byId.has(i.id)) this.byId.set(i.id, i);
    // A client's own name is a party, not a topic: every umbrella and company id, compacted ("velo nord" = "velonord").
    this.parties = new Set([...this.byId.values()].flatMap((i) => [i.umbrella, i.company ?? '']).map((s) => parts(s).join('')).filter(Boolean));
  }

  get(id: string): TrustInitiative | undefined {
    return this.byId.get(id);
  }

  /** The client of a label: its company, else its umbrella; null for labels the registry does not hold (none, unregistered). */
  client(label: string | null | undefined): string | null {
    const i = label ? this.byId.get(label) : undefined;
    return i ? clientOf(i) : null;
  }

  umbrella(label: string | null | undefined): string | null {
    return (label && this.byId.get(label)?.umbrella) || null;
  }

  /** X's siblings: the client's other ACTIVE initiatives; admin buckets and `personal` neither have nor are siblings. */
  siblings(x: string): string[] {
    return this.scope(x).siblings;
  }

  private cuesOf(id: string): Cue[] {
    let out = this.raw.get(id);
    if (out) return out;
    out = [];
    const i = this.byId.get(id);
    const seen = new Set<string>();
    const add = (c: Cue | null) => {
      if (!c || seen.has(c.norm)) return;
      // a word cue that only names a party (all its parts, or the whole compacted)
      if (!/^(?:key|host|id):|^#/.test(c.norm)) {
        const ps = c.norm.split(' ');
        if (this.parties.has(ps.join('')) || ps.every((p) => this.parties.has(p))) return;
      }
      seen.add(c.norm);
      out!.push(c);
    };
    for (const s of i?.cues ?? []) if (typeof s === 'string') add(parseCue(s));
    for (const t of lastSegment(id).split('-')) if ([...t].length >= 3 && letters(t) >= 2) add(wordCue(t));
    this.raw.set(id, out);
    return out;
  }

  private scope(x: string): { siblings: string[]; cues: Map<string, Cue[]> } {
    let s = this.scopes.get(x);
    if (s) return s;
    const me = this.byId.get(x);
    const out = (i: TrustInitiative) => isAdmin(i) || isPersonal(i);
    const siblings = !me || out(me) ? [] : [...this.byId.values()].filter((i) => i.id !== x && i.active && !out(i) && clientOf(i) === clientOf(me)).map((i) => i.id);
    // Within the client a cue two initiatives share cannot tell them apart: keep only cues exactly one of them carries.
    const ids = [x, ...siblings];
    const owners = new Map<string, number>();
    for (const id of ids) for (const n of new Set(this.cuesOf(id).map((c) => c.norm))) owners.set(n, (owners.get(n) ?? 0) + 1);
    s = { siblings, cues: new Map(ids.map((id) => [id, this.cuesOf(id).filter((c) => owners.get(c.norm) === 1)])) };
    this.scopes.set(x, s);
    return s;
  }

  /** The cues a unit's text carries for X and each of its siblings; null when X has no siblings (trust stays as it is). */
  hits(x: string, text: string | null | undefined, skip: ReadonlySet<string>): CueHits | null {
    const s = this.scope(x);
    if (!s.siblings.length) return null;
    const folded = fold(text);
    return { siblings: s.siblings, own: hits(s.cues.get(x) ?? [], folded, skip), sib: s.siblings.map((y) => [y, hits(s.cues.get(y) ?? [], folded, skip)]) };
  }
}

export interface TrustOutcome {
  label: string;
  conf: number;
  rung: string;
  why: string;
  kept: boolean; // X keeps the rung's (calibrated) confidence
}

/**
 * K2a §1 for one structural decision X at (calibrated) confidence `conf`. `confirmed`: agreeing answers on the route's own
 * units (its ctx key, consistent, ≥ k) — 0 when none or contradicted; it repairs only the no-cue case: a cue of a sibling
 * in this unit's own words outweighs what the route's other units were.
 */
export function siblingTrust(x: string, conf: number, rung: string, h: CueHits, confirmed = 0): TrustOutcome {
  const sib = h.sib.filter(([, n]) => n.length);
  const doubt = (why: string): TrustOutcome => ({ label: x, conf: Math.min(DOUBT, conf), rung, why: `${why} (siblings ${h.siblings.join(', ')})`, kept: false });
  if (h.own.length && !sib.length) return { label: x, conf, rung, why: `cue "${h.own[0]}" of ${x}, none of its siblings`, kept: true };
  if (!h.own.length && sib.length) {
    const max = Math.max(...sib.map(([, n]) => n.length));
    const top = sib.filter(([, n]) => n.length === max);
    if (top.length === 1) {
      const [y, n] = top[0]!;
      return { label: y, conf: SIBLING_GUESS, rung: `cue:${rung}`, why: `${rung} says ${x}, but cue "${n[0]}" points at its sibling ${y}`, kept: false };
    }
    return doubt(`${rung}: cues of ${top.map(([y]) => y).join(' and ')}, none of ${x}`);
  }
  if (h.own.length) return doubt(`${rung}: cue "${h.own[0]}" of ${x} and "${sib[0]![1][0]}" of ${sib[0]![0]}`);
  if (confirmed > 0) return { label: x, conf, rung, why: `${rung} confirmed by ${confirmed} answer${confirmed === 1 ? '' : 's'} on its units`, kept: true };
  return doubt(`${rung}: no cue tells ${x} from its siblings`);
}
