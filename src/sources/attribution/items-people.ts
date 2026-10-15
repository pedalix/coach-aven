// Item mode (attribution/items.ts): one resolver from a raw participant string to a person of people.json. Ported from
// the bench's stage-0 floor (src/lab/variants/stage0/t234-people.ts). The store's resolver (people.ts resolveIdentity:
// lower case, two prefixes, exact key) stays what prod uses; this one is read only by item mode, where it decides
// who an item's author is when the store left it unresolved, whom an @handle or a "Ana, …" names, and whom a reply
// answers. Rungs, first hit wins, with graded confidences — only ≥ .95 counts as the person ("people exact"):
//   exact folded identity .99 · <addr> .99 · plus-address .97 · unique name-as-identity .97 (a name two people share
//   resolves nobody; order-swapped or dotted handle .95; Cyrillic transliterated first) · a mailbox or tracker login
//   that spells a roster name .95 (a first-name mailbox at the person's own domain .95, elsewhere .85) · a typo of a
//   roster name (same surname, first name ≤ 2 edits) .85 · a glued line split against known full names, full cover
//   only (.95 with every segment in the linked event, else .90) · a first name unique among the people present .85.
// Pure: the roster comes in as data.

import type { Person } from '../people.js';
import { foldName, foldTokens, parseAttendee, splitGlued } from '../identities/attendees.js';

export interface Resolved {
  label: string | null; // person id, '+'-joined sorted ids (glued), or null
  conf: number;
  rung: string; // exact | addr | plus | name | name:swapped | name:handle | name:fuzzy | mailbox | mailbox:first | login | login:first |
  //               glued | glued:event | glued:one | first — undecided: ambiguous | glued:partial | first:absent | first:ambiguous | abstain
  candidates: string[];
  split?: string[]; // glued: the persons in the line, in line order
}

const PREFIX = /^(?:slack|msgraph|teams|jira|youtrack|asana|gitlab|github):/i;
const ADDR = /[A-Za-z0-9._%+=-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const BRACKETED = /[<(\[]\s*(?:mailto:)?\s*([A-Za-z0-9._%+=-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\s*[>)\]]/;
const LOGIN_AT_ORG = /^([^@\s]+)@([A-Za-z0-9_-]+)$/; // youtrack:<login>@<ORG>: no dot, no domain

/** The comparison key of a raw string as an identity: prefix off, lowercase, `login@ORG` → login. */
export function identityForm(raw: string): string {
  const s = (raw ?? '').trim().replace(PREFIX, '').trim();
  const m = LOGIN_AT_ORG.exec(s);
  return (m ? m[1]! : s).toLowerCase();
}

/** A raw form as a key: an address as is (lowercase), anything else folded. */
export function formKey(raw: string): string {
  const id = identityForm(raw);
  if (ADDR.test(id) && !/\s/.test(id)) return id;
  return foldName(id) || id;
}

const plusless = (email: string): string => email.replace(/^([^@+]+)\+[^@]*@/, '$1@');
const domainOf = (email: string): string => email.split('@')[1] ?? '';

/** A single owner per key; a key two people share maps to null (ambiguous: it resolves nobody). */
function own<K>(m: Map<K, string | null>, k: K, pid: string): void {
  const cur = m.get(k);
  m.set(k, cur === undefined || cur === pid ? pid : null);
}

export interface Roster {
  people: readonly Person[];
  identity: Map<string, string | null>; // identityForm / folded name identity → person
  names: Map<string, string | null>; // folded person.name → person (the implicit identity)
  firsts: Map<string, Set<string>>; // folded first name → persons
  tokens: Map<string, string[]>; // person → folded name tokens
  domains: Map<string, Set<string>>; // person → domains of their address identities
  known: { person_id: string; names: string[] }[]; // full-name forms for the glued split
}

export function roster(people: readonly Person[]): Roster {
  const identity = new Map<string, string | null>();
  const names = new Map<string, string | null>();
  const firsts = new Map<string, Set<string>>();
  const tokens = new Map<string, string[]>();
  const domains = new Map<string, Set<string>>();
  const known: Roster['known'] = [];
  for (const p of people) {
    const forms = new Set<string>([p.name]);
    for (const raw of p.identities) {
      const key = identityForm(raw);
      own(identity, key, p.person_id);
      if (key.includes('@')) {
        const d = domainOf(key);
        if (d) domains.set(p.person_id, new Set([...(domains.get(p.person_id) ?? []), d]));
      } else {
        const folded = foldName(key);
        if (folded && folded !== key) own(identity, folded, p.person_id);
        forms.add(key);
      }
    }
    const fn = foldName(p.name);
    if (fn) own(names, fn, p.person_id);
    const toks = foldTokens(p.name);
    tokens.set(p.person_id, toks);
    if (toks[0]) firsts.set(toks[0], new Set([...(firsts.get(toks[0]) ?? []), p.person_id]));
    known.push({ person_id: p.person_id, names: [...forms].filter((f) => !f.includes('@')) });
  }
  return { people, identity, names, firsts, tokens, domains, known };
}

const hit = (label: string, conf: number, rung: string, extra: Partial<Resolved> = {}): Resolved => ({ label, conf, rung, candidates: [label], ...extra });
const miss = (rung = 'abstain', candidates: string[] = []): Resolved => ({ label: null, conf: 0, rung, candidates });

/** Exact identity (.99) or the plus-less address (.97); undefined = no key, null = a key two people share. */
function exactOf(r: Roster, raw: string): { pid: string | null; rung: 'exact' | 'plus' } | undefined {
  const key = identityForm(raw);
  if (r.identity.has(key)) return { pid: r.identity.get(key)!, rung: 'exact' };
  if (!key.includes('@')) {
    const folded = foldName(key);
    if (folded && r.identity.has(folded)) return { pid: r.identity.get(folded)!, rung: 'exact' };
    return undefined;
  }
  const pl = plusless(key);
  if (pl !== key && r.identity.has(pl)) return { pid: r.identity.get(pl)!, rung: 'plus' };
  return undefined;
}

function ambiguousOf(r: Roster, folded: string): string[] {
  return r.people.filter((p) => foldName(p.name) === folded || p.identities.some((i) => foldName(identityForm(i)) === folded)).map((p) => p.person_id);
}

/** A display name (no address) → its person via the roster's names; swapped "Berg, Ana" and handles "ana_berg" too. */
function byName(r: Roster, display: string, original = display): Resolved | null {
  const d = display.trim();
  if (!d) return null;
  const tryKey = (k: string, conf: number, rung: string): Resolved | null => {
    if (!k) return null;
    const viaName = r.names.get(k);
    const viaIdentity = r.identity.get(k);
    // null = a name two people share: ambiguous, never a decision (and never "not found").
    const pid = viaName !== undefined ? viaName : viaIdentity;
    if (pid === undefined) return null;
    if (pid === null || viaIdentity === null || (viaName && viaIdentity && viaName !== viaIdentity)) return miss('ambiguous', ambiguousOf(r, k));
    return hit(pid, conf, rung);
  };
  const straight = tryKey(foldName(d), 0.97, 'name');
  if (straight) return straight;
  const swapped = /^([^,<@]+),\s*([^,<@]+)$/.exec(original.replace(/\s*\|.*$/, '').trim());
  if (swapped) {
    const s = tryKey(foldName(`${swapped[2]} ${swapped[1]}`), 0.95, 'name:swapped');
    if (s) return s;
  }
  if (!/\s/.test(d) && /[._]/.test(d)) {
    const h = tryKey(foldName(d.replace(/[._]+/g, ' ')), 0.95, 'name:handle');
    if (h) return h;
  }
  return null;
}

/** A mailbox (or a tracker login) that spells a roster name: ana.berg@, berg.ana@, anaberg@, aberg@, nina@ (one-word name). */
function byMailbox(r: Roster, local0: string, domain: string, rung = 'mailbox'): Resolved | null {
  const local = local0.toLowerCase().replace(/\+.*$/, '');
  const parts = local.split(/[._-]+/).map((x) => x.replace(/\d+/g, '')).filter(Boolean);
  if (!parts.length) return null;
  const joined = parts.join('');
  const fits: string[] = [];
  for (const [pid, toks0] of r.tokens) {
    const toks = toks0.map((t) => t.replace(/[^a-z]/g, '')).filter(Boolean);
    if (!toks.length) continue;
    const first = toks[0]!;
    const last = toks[toks.length - 1]!;
    if (toks.length === 1) {
      if (joined === first && first.length >= 3) fits.push(pid);
      continue;
    }
    const forms = new Set([toks.join(''), [...toks].reverse().join(''), `${first}${last}`, `${last}${first}`, `${first[0]}${last}`, `${last}${first[0]}`]);
    if (forms.has(joined) && joined.length >= 4) fits.push(pid);
  }
  const uniq = [...new Set(fits)];
  if (uniq.length === 1) return hit(uniq[0]!, 0.95, rung);
  if (uniq.length > 1) return miss('ambiguous', uniq);
  // A first-name mailbox (ana@): one roster person with that first name — strong at their own domain, weak elsewhere.
  if (parts.length === 1) {
    const owners = [...(r.firsts.get(parts[0]!) ?? [])].filter((pid) => (r.tokens.get(pid)?.length ?? 0) >= 2);
    if (owners.length === 1) {
      const pid = owners[0]!;
      return domain && r.domains.get(pid)?.has(domain) ? hit(pid, 0.95, `${rung}:first`) : hit(pid, 0.85, `${rung}:first`);
    }
  }
  return null;
}

// Cyrillic → Latin (a plain BGN-like table): "Ольга Иванова" meets the roster's "Olga Ivanova". Lossy on purpose.
const CYR: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};
export function translit(s: string): string {
  if (!/[Ѐ-ӿ]/.test(s)) return s;
  return s.replace(/[Ѐ-ӿ]/g, (c) => {
    const lower = c.toLowerCase();
    const t = CYR[lower] ?? c;
    return c !== lower && t ? t[0]!.toUpperCase() + t.slice(1) : t;
  });
}

/** Optimal string alignment distance (a swap of two letters is one edit — "Tobais" → "Tobias"). */
function edits(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}

/** The same surname and a first name ≤ 2 edits away (4+ letters) — one person only, .85. */
function byFuzzyName(r: Roster, display: string): Resolved | null {
  const toks = foldTokens(display);
  if (toks.length !== 2) return null;
  const [first, last] = toks as [string, string];
  if (first.length < 4) return null;
  const hits = [...r.tokens].filter(([, t]) => t.length >= 2 && t.at(-1) === last && edits(t[0]!, first) <= 2).map(([pid]) => pid);
  return hits.length === 1 ? hit(hits[0]!, 0.85, 'name:fuzzy') : null;
}

export interface MentionContext {
  eventPeople?: ReadonlySet<string>; // persons of the linked calendar event
  coPresent?: ReadonlySet<string>; // persons present on the record (container members, speakers, co-mentions)
}

/** The rungs, in order. */
export function resolveMention(r: Roster, raw0: string, ctx: MentionContext = {}): Resolved {
  const raw = (raw0 ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return miss();
  // 1. exact folded identity (and the plus-less address)
  const ex = exactOf(r, raw);
  if (ex && ex.pid) return hit(ex.pid, ex.rung === 'exact' ? 0.99 : 0.97, ex.rung);
  if (ex && ex.pid === null) return miss('ambiguous', ambiguousOf(r, foldName(identityForm(raw))));
  // 2. <addr>: the address inside "Name <addr>" / "Name (addr)"
  const br = BRACKETED.exec(raw);
  if (br) {
    const a = exactOf(r, br[1]!);
    if (a?.pid) return hit(a.pid, a.rung === 'exact' ? 0.99 : 0.97, a.rung === 'exact' ? 'addr' : 'plus');
  }
  // The display form: prefix off, a tracker login without its org ("ana.berg@ACME" → "ana.berg"), Cyrillic in Latin.
  const core0 = raw.replace(PREFIX, '').trim();
  const isLogin = PREFIX.test(raw) || LOGIN_AT_ORG.test(core0);
  const core = translit(LOGIN_AT_ORG.exec(core0)?.[1] ?? core0);
  const parsed = parseAttendee(core);
  const multi = parsed.glued || parsed.emails.length > 1 || (parsed.names.length > 1 && !br);
  if (!multi) {
    // 3. a display name that is a roster person's name (the implicit identity)
    const display = parsed.names[0] ?? (parsed.emails.length ? '' : core);
    const n = byName(r, display, parsed.emails.length ? display : core);
    if (n && n.label) return n;
    // 4. a mailbox (or a tracker login) that spells a roster name
    const email = parsed.emails[0];
    if (email) {
      const [local = '', domain = ''] = email.split('@');
      const mb = byMailbox(r, local, domain);
      if (mb) return mb;
    } else if (isLogin && !/\s/.test(core)) {
      const lg = byMailbox(r, core, '', 'login');
      if (lg) return lg;
    }
    if (n) return n; // ambiguous name: candidates, no decision
    // 4b. a name with a typo or another transliteration (same surname, a first name ≤ 2 edits away): a guess
    const fz = byFuzzyName(r, display);
    if (fz) return fz;
  }
  // 5. glued line: names split against known full names, addresses resolved exactly; only a full cover decides
  if (multi || parsed.glued) {
    const persons: string[] = [];
    let rest = 0;
    for (const e of parsed.emails) {
      const a = exactOf(r, e);
      if (a?.pid) persons.push(a.pid);
      else rest++;
    }
    const sp = splitGlued(parsed.names, r.known);
    persons.push(...sp.persons);
    rest += sp.rest.length;
    const ids = [...new Set(persons)];
    if (ids.length && !rest) {
      const label = [...ids].sort().join('+');
      const inEvent = !!ctx.eventPeople && ids.every((p) => ctx.eventPeople!.has(p));
      if (ids.length === 1) return hit(label, 0.95, 'glued:one', { split: ids });
      return { label, conf: inEvent ? 0.95 : 0.9, rung: inEvent ? 'glued:event' : 'glued', candidates: ids, split: ids };
    }
    return miss('glued:partial', ids);
  }
  // 6. a first name alone ("Ana", "Ana B."): unique among the people present on the record
  const toks = foldTokens(core);
  if (toks.length >= 1 && toks.length <= 2 && (toks.length === 1 || toks[1]!.length <= 1) && !core.includes('@')) {
    const owners = [...(r.firsts.get(toks[0]!) ?? [])].filter((p) => toks.length === 1 || (r.tokens.get(p)?.at(-1) ?? '').startsWith(toks[1]!));
    const present = owners.filter((p) => ctx.coPresent?.has(p));
    if (present.length === 1) return hit(present[0]!, 0.85, 'first');
    if (owners.length) return miss(owners.length === 1 ? 'first:absent' : 'first:ambiguous', owners);
  }
  return miss();
}
