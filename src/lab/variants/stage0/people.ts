// Stage 0 — one resolver for every surface form a record carries (design notes/10-design.md §2.1 F4a–c). Production has
// two that disagree (the store's identityKey: lower case and two prefixes; the collector's normaliser: folded), never
// indexes a person's `name`, and reads attendees as `email ?? name` — so a name-only Gemini/Wispr invitee resolves to
// nobody. This one:
//   - folds like the collector (attendees.ts foldName: NFKD, accents and `| Company` dropped, German ae/oe/ue folds),
//     strips the source prefixes (slack:, msgraph:, teams:, jira:, youtrack:, asana:), maps a tracker `login@ORG` (no
//     dot in ORG: not a mail address) to the login, and tries the address inside `Name <addr>` first;
//   - indexes each person's own `name` as an implicit identity; a name two people share resolves NOBODY (a collision
//     is ambiguous, never a guess), and an explicit identity always beats an implicit name;
//   - reads an attendee entry with parseAttendee (every address and name run of a stored line) and splits a glued
//     run ("Ana Berg Rui Rosa") with splitGlued against the full names it knows — what matches nobody stays unresolved.
// Pure; the roster comes in as data.

import { foldName, parseAttendee, splitGlued } from '../../../sources/identities/attendees.js';

export interface PersonLike {
  person_id: string;
  name: string;
  company?: string | null;
  identities: string[];
  marker?: { type: string; initiatives: string[] } | null;
}

const PREFIX = /^(?:slack|msgraph|teams|jira|youtrack|asana|github|gitlab):/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const BRACKETED = /<\s*(?:mailto:)?([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\s*>/;
const LOGIN_AT_ORG = /^([^@\s]+)@([A-Za-z0-9_-]+)$/; // youtrack:<login>@<ORG> — a dotless "domain" is an org, not mail

/** The comparison key of one surface form: a mail address lower-cased, anything else folded (foldName). '' = nothing. */
export function formKey(raw: string | null | undefined): string {
  let s = (raw ?? '').trim();
  for (let i = 0; i < 2 && PREFIX.test(s); i++) s = s.replace(PREFIX, '').trim();
  const login = LOGIN_AT_ORG.exec(s);
  if (login && !s.includes('.')) s = login[1]!;
  const bracket = BRACKETED.exec(s);
  if (bracket) return bracket[1]!.toLowerCase();
  if (/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(s)) return s.toLowerCase();
  return foldName(s.replace(/^@/, ''));
}

/** Every key a surface form may resolve by, most specific first: its addresses, then the whole form, then the name part. */
export function formKeys(raw: string | null | undefined): string[] {
  const s = (raw ?? '').trim();
  if (!s) return [];
  const out: string[] = [];
  const bracket = BRACKETED.exec(s);
  if (bracket) out.push(bracket[1]!.toLowerCase());
  for (const m of s.matchAll(EMAIL)) out.push(m[0].toLowerCase());
  out.push(formKey(s));
  const namePart = s.replace(BRACKETED, ' ').replace(EMAIL, ' ').trim();
  if (namePart && namePart !== s) out.push(formKey(namePart));
  return [...new Set(out.filter(Boolean))];
}

export interface Resolver {
  /** The one person a surface form names, or null (unknown, or ambiguous). */
  resolve(raw: string | null | undefined): string | null;
  /** Like resolve, but says whether a key hit two people (a collision resolves nobody, and is never asked as "new"). */
  lookup(raw: string | null | undefined): { pid: string | null; ambiguous: boolean };
  /**
   * The people an attendee entry names: its addresses and clean names; a glued run is split against the known full
   * names, and the split counts only when it covers the WHOLE run — `cover` adds names that are no roster person (the
   * linked event's attendees, the transcript's speakers) but may fill a gap. A partial cover resolves nobody (F4c).
   */
  attendee(entry: unknown, cover?: readonly string[]): string[];
  /** For splitGlued: each person's full name plus every name-like identity. */
  readonly known: { person_id: string; names: string[] }[];
  person(pid: string): PersonLike | undefined;
}

const AMBIGUOUS = '\u0000ambiguous';

export function buildResolver(people: readonly PersonLike[]): Resolver {
  const explicit = new Map<string, string>();
  const implicit = new Map<string, string>();
  const byId = new Map(people.map((p) => [p.person_id, p]));
  const put = (m: Map<string, string>, k: string, pid: string) => {
    if (!k) return;
    const cur = m.get(k);
    m.set(k, cur === undefined || cur === pid ? pid : AMBIGUOUS);
  };
  for (const p of people) for (const id of p.identities ?? []) put(explicit, formKey(id), p.person_id);
  for (const p of people) {
    const k = formKey(p.name);
    if (k && !explicit.has(k)) put(implicit, k, p.person_id);
  }
  const known = people.map((p) => ({
    person_id: p.person_id,
    names: [...new Set([p.name, ...(p.identities ?? []).map((i) => i.replace(PREFIX, '').trim()).filter((i) => !i.includes('@'))].filter(Boolean))],
  }));

  const lookup = (raw: string | null | undefined): { pid: string | null; ambiguous: boolean } => {
    let ambiguous = false;
    for (const k of formKeys(raw)) {
      const hit = explicit.get(k) ?? implicit.get(k);
      if (hit === AMBIGUOUS) {
        ambiguous = true;
        continue;
      }
      if (hit) return { pid: hit, ambiguous: false };
    }
    return { pid: null, ambiguous };
  };
  const resolve = (raw: string | null | undefined): string | null => lookup(raw).pid;

  const attendee = (entry: unknown, cover: readonly string[] = []): string[] => {
    const a = parseAttendee(entry);
    const out = new Set<string>();
    for (const e of a.emails) {
      const pid = resolve(e);
      if (pid) out.add(pid);
    }
    const extra = cover.filter((n) => n && !n.includes('@')).map((n, i) => ({ person_id: `\u0000cover${i}`, names: [n] }));
    for (const n of a.names) {
      const pid = resolve(n);
      if (pid) {
        out.add(pid);
        continue;
      }
      // A run nobody owns whole is one unknown person — unless it is glued: then only a full cover splits it.
      if (!a.glued) continue;
      const split = splitGlued(n, [...known, ...extra]);
      if (split.rest.length) continue;
      for (const p of split.persons) if (!p.startsWith('\u0000')) out.add(p);
    }
    return [...out];
  };

  return { resolve, lookup, attendee, known, person: (pid) => byId.get(pid) };
}

/** Names a DM/group container encodes: `chat:@Ana Berg | Acme`, `chat:group:A | Co+B`, `dm:@ana`, `mpim:@ana+@rui` (F5). */
export function containerForms(container: string | null | undefined): string[] {
  const c = container ?? '';
  const m = /^(?:chat:(?:group:)?|dm:|mpim:)(.+)$/i.exec(c);
  if (!m) return [];
  return m[1]!
    .split('+')
    .map((x) => x.trim().replace(/^@/, ''))
    .filter((x) => x && !/^[UBW][A-Z0-9]{8,}$/.test(x));
}

/** Group DMs (`mpim:`) are as direct as DMs: the store writes `mpim:`, the readouts expected `mpdm` (F5). */
export const isDirectContainer = (container: string | null | undefined): boolean => /^(?:dm:|mpim:|chat:)/i.test(container ?? '');
