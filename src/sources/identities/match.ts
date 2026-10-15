// Smart identity matching, ported from the owen-ops collector. Before an unmapped identity becomes a question it
// is matched against the known people:
//   certain  — same full name (order-insensitive, "ana b." = "Ana B"), or an email local part that is the
//              person's name glued together (anaberg, ana.berg, aberg, bergana)
//   first    — only a first name that a known person has, with no conflicting last name
//   nickname — a first name that is a prefix of a known one or vice versa
// The collector merges `certain`, merges `first` when the identity co-occurs with the person (same
// container/thread, or an email domain/company the person is known under), and otherwise asks. Pure.
import { normaliseName, type ParsedIdentity } from './normalise.js';

export interface KnownPerson {
  person_id: string;
  name: string;
  company?: string | null;
  identities: string[];
}

export type Certainty = 'certain' | 'first' | 'nickname';
export interface Guess {
  person_id: string;
  name: string;
  certainty: Certainty;
  reason: string;
}

/** Name tokens: "Hana 'Hanni' Hill" → hana, hanni, hill; "ana b.s." → ana, b, s. */
export function nameTokens(name: string | null | undefined): string[] {
  return normaliseName(name ?? '').replace(/['.]/g, ' ').split(/[\s-]+/).filter(Boolean);
}

/** Email local part tokens: "ana.berg+x" → ana, berg; "anaberg" → anaberg. */
export function localTokens(email: string): string[] {
  const local = email.split('@')[0]!.replace(/\+.*$/, '').toLowerCase();
  return local.split(/[._\-\d]+/).filter(Boolean);
}

export const domainLabel = (email: string): string => (email.split('@')[1] ?? '').toLowerCase().split('.').slice(-2, -1)[0] ?? '';

/** Ways a person's name gets glued into a mailbox. */
function gluedForms(tokens: string[]): Set<string> {
  const out = new Set<string>();
  if (tokens.length < 2) return out;
  const first = tokens[0]!;
  const last = tokens[tokens.length - 1]!;
  for (const f of [first + last, last + first, first[0]! + last, first + last[0]!, last + first[0]!]) out.add(f);
  return out;
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Known-person tokens without nickname quotes. */
function personTokens(p: KnownPerson): string[] {
  return nameTokens(p.name.replace(/'[^']*'/g, ' '));
}

/**
 * When an identity carries both a name and a mailbox, the name only counts if the mailbox plausibly belongs to it:
 * recorders put several attendees in one field ("rui.rosa@example.com ana berg"), which must not merge a stranger's
 * address into a known person.
 */
export function mailboxFitsName(email: string, tokens: string[]): boolean {
  const lt = localTokens(email);
  if (!lt.length || !tokens.length) return false;
  if (lt.some((t) => tokens.includes(t))) return true;
  const glued = gluedForms(tokens);
  if (lt.length === 1 && (glued.has(lt[0]!) || lt[0]!.startsWith(tokens[0]!) || (lt[0]!.length <= 2 && lt[0]![0] === tokens[0]![0]))) return true;
  return false;
}

function compare(cand: string[], email: string | null, p: KnownPerson, nameFromIdentity = false): Guess | null {
  const pt = personTokens(p);
  if (!pt.length) return null;
  if (email && nameFromIdentity && !mailboxFitsName(email, pt) && !mailboxFitsName(email, cand)) return null;
  const base = { person_id: p.person_id, name: p.name };
  if (cand.length >= 2 && pt.length >= 2 && sameSet(cand, pt)) return { ...base, certainty: 'certain', reason: 'same full name' };
  if (email) {
    const lt = localTokens(email);
    if (lt.length >= 2 && pt.length >= 2 && sameSet(lt, pt)) return { ...base, certainty: 'certain', reason: 'mailbox is the full name' };
    if (lt.length === 1 && gluedForms(pt).has(lt[0]!)) return { ...base, certainty: 'certain', reason: 'mailbox is the glued full name' };
  }
  const cfirst = cand[0];
  const pfirst = pt[0]!;
  if (!cfirst) return null;
  const clast = cand.length >= 2 ? cand[cand.length - 1]! : null;
  const plast = pt.length >= 2 ? pt[pt.length - 1]! : null;
  const lastConflicts = !!(clast && plast && clast !== plast && !(clast.length === 1 && plast.startsWith(clast)));
  if (lastConflicts) return null;
  if (cfirst === pfirst) return { ...base, certainty: 'first', reason: 'same first name' };
  if (!clast && cfirst.length >= 3 && pfirst.length >= 3 && (pfirst.startsWith(cfirst) || cfirst.startsWith(pfirst))) {
    return { ...base, certainty: 'nickname', reason: `"${cfirst}" looks like a short form of "${pfirst}"` };
  }
  return null;
}

/** All plausible matches for an unmapped identity, strongest first. `self` (the subject) is never a guess. */
export function guessPeople(p: ParsedIdentity, people: readonly KnownPerson[], self?: string): Guess[] {
  const cand = p.name ? nameTokens(p.name) : p.email ? localTokens(p.email) : [];
  const out: Guess[] = [];
  for (const person of people) {
    if (person.person_id === self) continue;
    const g = compare(cand, p.email, person, !!p.name);
    if (g) out.push(g);
  }
  const rank: Record<Certainty, number> = { certain: 0, first: 1, nickname: 2 };
  return out.sort((a, b) => rank[a.certainty] - rank[b.certainty]);
}

export type MatchVerdict = { kind: 'merge'; guess: Guess; reason: string } | { kind: 'ask'; guesses: Guess[] } | { kind: 'none' };

/** What to do with the guesses; `coOccurs(person_id)` says whether the identity was seen together with that person. */
export function verdict(guesses: Guess[], coOccurs: (personId: string) => boolean): MatchVerdict {
  if (!guesses.length) return { kind: 'none' };
  const certain = guesses.filter((g) => g.certainty === 'certain');
  if (certain.length === 1) return { kind: 'merge', guess: certain[0]!, reason: certain[0]!.reason };
  if (certain.length > 1) return { kind: 'ask', guesses: certain };
  const first = guesses.filter((g) => g.certainty === 'first');
  if (first.length === 1 && coOccurs(first[0]!.person_id)) return { kind: 'merge', guess: first[0]!, reason: `${first[0]!.reason}, seen together` };
  if (first.length >= 1) return { kind: 'ask', guesses: first };
  return { kind: 'ask', guesses };
}
