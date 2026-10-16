// One parser for a meeting/event attendee entry, whatever the recorder stored. Today five call sites read attendee
// lists five ways (store.ts meeting_people and calls, observations.ts, attribution/build.ts, commitments.ts), and the
// common `email ?? name` drops every entry whose email is an empty string — every Gemini name-only invitee and every
// Wispr attendee. The shapes as stored:
//   granola  {email: 'ana@acme.example', name: 'Ana Berg'}           a structured pair: one person
//            {email: …, name: 'Ana Berg | Acme Corp'}                  Teams/Granola company suffix
//   gmeet    {email: '', name: 'Ana Berg'}                             the "Invited" line, one chip
//            {email: '', name: 'Ana Berg Rui Rosa'}                    two chips glued — Gemini joins the invitee chips
//                                                                      with spaces and the normaliser splits on commas
//            {email: 'ana berg rui@x.example', name: ''}               a line with an '@' lands, lowercased, in `email`;
//                                                                      shapes seen: W W E, E W W, E W W W W E E, …
//   wispr    {email: '', name: 'Ana Berg'}                             names only, sometimes '<First Last> | <Company>'
//   msgraph  'Ana Berg | Acme <ana@acme.example>'                       plain strings, RFC display form
// parseAttendee() returns every address and the remaining name runs (a run = the words between two addresses), and
// says whether the entry holds more than one person (`glued`). A glued run is split against the people we know with
// splitGlued() — never by guessing: what matches nobody stays in `rest`, is used for co-occurrence only, never asked.
// Pure, no I/O. Used by the attribution layer (call participants), the identities collector and commitments — the
// tenant-gated paths; the store's own meeting_people/calls resolution (which prod reads) keeps its old parser for now.

export interface ParsedAttendee {
  /** Every address in the entry, lowercased, in order, deduplicated. */
  emails: string[];
  /** Name runs in display form ('| Company', parentheticals and stray punctuation dropped). A glued run holds 2+ people. */
  names: string[];
  /** The entry holds more than one person: several chips, or one name-only run of GLUED_MIN_WORDS+ words. */
  glued: boolean;
  /** The surface string: `Name <email>` for a structured pair, otherwise the stored line(s). */
  raw: string;
}

/**
 * A name-only run this long is two people, not one: Gemini's glued "First Last First Last". Three words stay one person
 * ("Ana Maria Berg", "Jan van Dijk") — a real four-word name (rare) is marked glued too, which only means splitGlued()
 * is tried first and an unmatched remainder is never asked about.
 */
export const GLUED_MIN_WORDS = 4;

const EMAIL_G = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Letters with no NFKD decomposition: without this, "Strauß"/"Strauss" or "Bjørn"/"Bjorn" never meet.
const TRANSLIT: Record<string, string> = { ß: 'ss', ẞ: 'SS', ø: 'o', Ø: 'O', æ: 'ae', Æ: 'AE', œ: 'oe', Œ: 'OE', ł: 'l', Ł: 'L', đ: 'd', Đ: 'D', ð: 'd', Ð: 'D', þ: 'th', Þ: 'TH', ı: 'i' };

/**
 * The comparison key for a person's name — the one normaliser the store and the collector should share. It is
 * identities/normalise.ts normaliseName (NFKD, accents dropped, '| Company' stripped, lowercase, collapsed spaces;
 * `.`, `'` and `-` kept) plus three folds normaliseName lacks:
 *   - German transliteration: ä/ö/ü fold to a/o/u under NFKD, so "ae"/"oe"/"ue" fold the same way ("Mueller" =
 *     "Müller" = "muller"). Not after a vowel ("Bauer", "Neuer" keep their "ue") and "ue" not after q/g ("Miguel",
 *     "Enrique"). The price: a few non-German names lose a letter on BOTH sides ("Michael" → "michal"), which only
 *     matters if a roster holds both spellings — keys are compared, never shown.
 *   - letters NFKD leaves alone (ß, ø, æ, ł …), transliterated first.
 *   - parentheticals ("Ana Berg (External)", "Ana (Annie) Berg") dropped: Teams and Outlook add them.
 * On every case normaliseName's tests cover, the two agree (attendees.test.ts checks it).
 */
export function foldName(s: string | null | undefined): string {
  return (s ?? '')
    .replace(/[ßẞøØæÆœŒłŁđĐðÐþÞı]/g, (c) => TRANSLIT[c] ?? c)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s*\|.*$/, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\p{N}\s.'-]/gu, ' ')
    .toLowerCase()
    .replace(/(?<![aeiouy])([ao])e/g, '$1')
    .replace(/(?<![aeiouyqg])ue/g, 'u')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Folded name tokens, split like match.ts nameTokens ("ana-maria b." → ana, maria, b). Addresses are not names. */
export function foldTokens(s: string): string[] {
  if (s.includes('@')) return [];
  return foldName(s).replace(/['.]/g, ' ').split(/[\s-]+/).filter(Boolean);
}

type Piece = { kind: 'name'; value: string } | { kind: 'email'; value: string; bound: boolean };

/** Display form of one name chunk; '' when nothing name-like is left. */
function cleanName(chunk: string): string {
  const s = chunk
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ') // "(External)", "[Guest]"
    .replace(/\bmailto:/gi, ' ')
    .replace(/[^\p{L}\p{M}\p{N}\s.'’-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-.'’\s]+|[-'’\s]+$/g, '');
  return /\p{L}/u.test(s) ? s : '';
}

/** The text between two addresses → name runs. '| Company' runs to the end of the chunk; & + ; / separate people. */
function namePieces(chunk: string): Piece[] {
  return chunk
    .replace(/\|[^]*$/, '')
    .split(/\s[&+;/]\s|\s*;\s*/)
    .map(cleanName)
    .filter(Boolean)
    .map((value) => ({ kind: 'name' as const, value }));
}

/**
 * A stored line → names and addresses in order. A bracketed address right after a name (`Ana Berg <ana@x>`,
 * `Ana Berg | Acme (ana@x)`) is that name's own address — one person (`bound`); a bare address next to a name is a
 * separate chip, as Gemini writes them.
 */
function pieces(line: string): Piece[] {
  const out: Piece[] = [];
  let at = 0;
  for (const m of line.matchAll(EMAIL_G)) {
    let before = line.slice(at, m.index);
    const open = /[<(\[]\s*(?:mailto:)?\s*$/i.exec(before);
    if (open) before = before.slice(0, open.index);
    const names = namePieces(before);
    out.push(...names);
    const tail = before.replace(/\|[^]*$/, '').trimEnd();
    out.push({ kind: 'email', value: m[0].toLowerCase(), bound: !!open && names.length > 0 && !/[&+;/,]$/.test(tail) });
    at = m.index! + m[0].length;
    const close = /^\s*[>)\]]/.exec(line.slice(at));
    if (close) at += close[0].length;
  }
  out.push(...namePieces(line.slice(at)));
  return out;
}

const chipsOf = (ps: Piece[]): number => ps.filter((p) => p.kind === 'name' || !p.bound).length;
const wordsOf = (name: string): number => name.split(/\s+/).filter(Boolean).length;
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const firstText = (...vs: unknown[]): string => vs.map(str).find((v) => v.trim()) ?? '';

function result(ps: Piece[], chips: number, raw: string): ParsedAttendee {
  const emails = [...new Set(ps.filter((p) => p.kind === 'email').map((p) => p.value))];
  const names = ps.filter((p) => p.kind === 'name').map((p) => p.value);
  const glued = chips > 1 || (emails.length === 0 && names.length === 1 && wordsOf(names[0]!) >= GLUED_MIN_WORDS);
  return { emails, names, glued, raw };
}

/** Any attendee entry as a recorder stored it — `{email, name}`, Graph `{emailAddress: {name, address}}`, or a string. */
export function parseAttendee(entry: unknown): ParsedAttendee {
  if (typeof entry === 'string') {
    const line = entry.replace(/\s+/g, ' ').trim();
    const ps = pieces(line);
    return result(ps, chipsOf(ps), line);
  }
  if (!entry || typeof entry !== 'object') return { emails: [], names: [], glued: false, raw: '' };
  const o = entry as Record<string, unknown>;
  const nested = (o.emailAddress && typeof o.emailAddress === 'object' ? o.emailAddress : {}) as Record<string, unknown>;
  const emailField = firstText(o.email, o.mail, o.address, nested.address).replace(/\s+/g, ' ').trim();
  const nameField = firstText(o.name, o.displayName, o.display_name, nested.name).replace(/\s+/g, ' ').trim();
  const e = pieces(emailField);
  const n = pieces(nameField);
  // The structured pair: the email field is one address and nothing else, the name field has no address — the
  // name IS that address's owner (Granola, Graph). Only a second name run in the name field adds a person.
  if (e.length === 1 && e[0]!.kind === 'email' && !n.some((p) => p.kind === 'email')) {
    const nameRuns = n.length;
    const raw = nameField ? `${nameField} <${e[0]!.value}>` : e[0]!.value;
    return result([...n, e[0]!], Math.max(1, nameRuns), raw);
  }
  // Anything else is a line (or two): Gemini's whole "Invited" line in either field.
  const all = [...n, ...e];
  const dup = n.filter((p) => p.kind === 'email' && e.some((q) => q.kind === 'email' && q.value === p.value)).length;
  return result(all, chipsOf(n) + chipsOf(e) - dup, nameField === emailField ? emailField : [nameField, emailField].filter(Boolean).join(' '));
}

/**
 * Split a glued name run into the known people it names: greedy longest match, left to right, on folded tokens,
 * against every known FULL name (2+ tokens) of every person. Never a guess: no partial-token match, no first names
 * alone, and a full name two people share matches neither. What matches nobody comes back in `rest` as the leftover
 * runs ("ana berg rui rosa" with only Ana known → persons ['ana-berg'], rest ['rui rosa']). `tokens` is a name run, a
 * list of runs or a list of tokens, or even a whole stored line: an address is a boundary no name or leftover run
 * crosses, and is itself skipped (parseAttendee returns the addresses).
 */
export function splitGlued(tokens: string | string[], known: readonly { person_id: string; names: string[] }[]): { persons: string[]; rest: string[] } {
  const toks: (string | null)[] = []; // null = an address stood here
  for (const s of Array.isArray(tokens) ? tokens : [tokens]) {
    (s ?? '').split(EMAIL_G).forEach((seg, i) => {
      if (i > 0) toks.push(null);
      toks.push(...foldTokens(seg));
    });
  }
  const owner = new Map<string, string | null>();
  for (const p of known) {
    for (const name of p.names) {
      const seq = foldTokens(name);
      if (seq.length < 2) continue;
      const key = seq.join(' ');
      const prev = owner.get(key);
      owner.set(key, prev === undefined || prev === p.person_id ? p.person_id : null);
    }
  }
  const byFirst = new Map<string, { seq: string[]; pid: string }[]>();
  for (const [key, pid] of owner) {
    if (!pid) continue;
    const seq = key.split(' ');
    byFirst.set(seq[0]!, [...(byFirst.get(seq[0]!) ?? []), { seq, pid }]);
  }
  for (const list of byFirst.values()) list.sort((a, b) => b.seq.length - a.seq.length);
  const persons: string[] = [];
  const rest: string[] = [];
  let run: string[] = [];
  for (let i = 0; i < toks.length; ) {
    const tok = toks[i];
    if (tok === null) {
      if (run.length) rest.push(run.join(' '));
      run = [];
      i++;
      continue;
    }
    const hit = byFirst.get(tok)?.find((c) => c.seq.every((t, j) => toks[i + j] === t));
    if (!hit) {
      run.push(tok);
      i++;
      continue;
    }
    if (run.length) rest.push(run.join(' '));
    run = [];
    if (!persons.includes(hit.pid)) persons.push(hit.pid);
    i += hit.seq.length;
  }
  if (run.length) rest.push(run.join(' '));
  return { persons, rest };
}
