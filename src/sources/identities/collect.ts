// Identity collector, ported from the owen-ops tenant (2026-10-15). Every identity the store has seen (message
// authors, event and meeting attendees, task assignees/reporters) is checked against the tenant's people file.
// People must be identified exactly, so the only merges made without a human are deterministic:
//   1. an identity the people file already lists (mapped);
//   2. a `certain` match (the same full name in any order, or a mailbox that is the glued full name — match.ts);
//   3. a unique first name that co-occurs with the person (shared container/thread, or an email domain/company the
//      person is known under).
// Real ambiguity becomes a yes/no question with the best guesses; an unknown with no match is asked about only when
// seen ≥ 5× with the subject. System senders are counted and dropped; opaque ids (Slack U…, Jira account ids) are
// counted as unresolved because they cannot be judged by name at all. Pure: no I/O.
import { domainLabel, guessPeople, verdict, type Guess, type KnownPerson } from './match.js';
import { isFullName, isSystem, normaliseName, parseIdentity, type ParsedIdentity } from './normalise.js';

export interface Observation {
  raw: string;
  source: string;
  container: string;
  thread?: string | null;
  /** Seen in a conversation with the subject. */
  withSubject: boolean;
}

export interface IdentityMerge {
  person_id: string;
  identity: string;
  reason: string;
}

/** A question for the tenant's review — the same ids as the owen-ops collector's, so nothing is asked twice. */
export interface IdentityQuestion {
  id: string;
  kind: 'identity_merge';
  question: string;
  options: string[];
  refs: string[];
  seen: number;
}

export interface IdentityReadout {
  merges: IdentityMerge[];
  questions: IdentityQuestion[];
  counts: { mapped: number; candidates: number; dormant: number; system: number; unresolved: number };
}

interface Index {
  byEmail: Map<string, string>;
  byRawName: Map<string, string>;
}

export function indexPeople(people: readonly KnownPerson[]): Index {
  const ix: Index = { byEmail: new Map(), byRawName: new Map() };
  for (const p of people) {
    for (const id of p.identities) {
      const q = parseIdentity(id);
      if (q.email) ix.byEmail.set(q.email, p.person_id);
      else if (q.name) ix.byRawName.set(q.name, p.person_id); // explicit name identities map exactly
    }
  }
  return ix;
}

export function resolveParsed(ix: Index, p: ParsedIdentity): string | null {
  if (p.email && ix.byEmail.has(p.email)) return ix.byEmail.get(p.email)!;
  if (!p.email && p.name && ix.byRawName.has(p.name)) return ix.byRawName.get(p.name)!;
  return null;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

export const UNKNOWN_MIN_SEEN = 5;
/** The readout keeps the most-seen questions; the tenant asks a few new ones per run. */
export const MAX_QUESTIONS = 50;

export function collectIdentities(people: readonly KnownPerson[], obs: readonly Observation[], self: string, maxQuestions = MAX_QUESTIONS): IdentityReadout {
  const ix = indexPeople(people);
  const counts = { mapped: 0, candidates: 0, dormant: 0, system: 0, unresolved: 0 };
  const merges: IdentityMerge[] = [];
  // Where each mapped person shows up (containers/threads) — the co-occurrence evidence.
  const personPlaces = new Map<string, Set<string>>();
  const groups = new Map<string, { parsed: ParsedIdentity; sources: Set<string>; places: Set<string>; withSubject: boolean; n: number; direct: boolean }>();
  const mappedKeys = new Set<string>();
  for (const o of obs) {
    const p = parseIdentity(o.raw);
    const who = resolveParsed(ix, p);
    const places = [o.container, o.thread].filter((x): x is string => !!x);
    if (who) {
      mappedKeys.add(p.email ?? p.name ?? p.raw);
      const s = personPlaces.get(who) ?? new Set<string>();
      places.forEach((x) => s.add(x));
      personPlaces.set(who, s);
      continue;
    }
    const key = p.email ?? (p.name ? `name:${p.name}` : `opaque:${p.raw}`);
    const g = groups.get(key) ?? { parsed: p, sources: new Set<string>(), places: new Set<string>(), withSubject: false, n: 0, direct: false };
    g.sources.add(o.source);
    places.forEach((x) => g.places.add(x));
    g.withSubject ||= o.withSubject;
    g.direct ||= o.withSubject && /^(dm:|mpdm|chat:)/i.test(o.container);
    g.n++;
    groups.set(key, g);
  }
  counts.mapped = mappedKeys.size;

  const byId = new Map(people.map((p) => [p.person_id, p]));
  const knownDomains = (pid: string): Set<string> => {
    const out = new Set<string>();
    const person = byId.get(pid);
    if (!person) return out;
    for (const id of person.identities) {
      const q = parseIdentity(id);
      if (q.email) out.add(domainLabel(q.email));
    }
    if (person.company) out.add(String(person.company).toLowerCase());
    return out;
  };

  const pending: IdentityQuestion[] = [];
  for (const [key, g] of groups) {
    const p = g.parsed;
    if (isSystem(p)) {
      counts.system++;
      continue;
    }
    if (p.kind === 'opaque') {
      counts.unresolved++;
      continue;
    }
    counts.candidates++;
    const coOccurs = (pid: string) => {
      const known = personPlaces.get(pid);
      if (known && [...g.places].some((pl) => known.has(pl))) return true;
      return !!p.email && knownDomains(pid).has(domainLabel(p.email));
    };
    const v = verdict(guessPeople(p, people, self), coOccurs);
    if (v.kind === 'merge') {
      merges.push({ person_id: v.guess.person_id, identity: p.email ?? p.raw, reason: v.reason });
      continue;
    }
    const label = p.email ? (p.name ? `${p.name} <${p.email}>` : p.email) : p.name!;
    const srcs = [...g.sources].join(', ');
    if (v.kind === 'ask') {
      // A best guess exists: worth a yes/no once the identity actually talked with the subject.
      if (!g.withSubject || (g.n < 2 && !g.direct)) {
        counts.dormant++;
        continue;
      }
      pending.push({ ...yesNo(key, label, srcs, v.guesses, [...g.places]), seen: g.n });
      continue;
    }
    // No match at all: only a regular contact is worth asking about.
    if (!g.withSubject || g.n < UNKNOWN_MIN_SEEN) {
      counts.dormant++;
      continue;
    }
    pending.push({
      id: `esc-identity-${slug(key)}`,
      kind: 'identity_merge',
      question: `Who is "${label}"? Seen ${g.n}× in ${srcs} talking with you — new person, or someone known under another name?`,
      options: [`new person "${p.name ?? p.email}"`, 'merge into <person_id>', 'ignore (system/irrelevant)'],
      refs: [...g.places].slice(0, 5),
      seen: g.n,
    });
  }
  pending.sort((a, b) => b.seen - a.seen || a.id.localeCompare(b.id));
  return { merges: merges.sort((a, b) => a.identity.localeCompare(b.identity)), questions: pending.slice(0, maxQuestions), counts };
}

/** The yes/no question with the best guess(es). Id suffix `-yn` so it never collides with an older "who is". */
export function yesNo(key: string, label: string, sources: string, guesses: Guess[], places: string[]): Omit<IdentityQuestion, 'seen'> {
  const names = guesses.map((g) => g.name);
  return {
    id: `esc-identity-${slug(key)}-yn`,
    kind: 'identity_merge',
    question: guesses.length === 1 ? `Is “${label}” (${sources}) = ${names[0]}?` : `Is “${label}” (${sources}) one of: ${names.join(', ')}?`,
    options: [...guesses.map((g) => `yes: ${g.person_id}`), 'no — new person', 'ignore'],
    refs: places.slice(0, 5),
  };
}

/** Whether a name is a full name — re-exported for the observations' crowd check and tests. */
export { isFullName, normaliseName };
