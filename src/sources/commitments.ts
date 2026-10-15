// The subject's promised next steps, ported from the owen-ops extractor (2026-10-15). Every recorder already
// produces `next_steps` per call; they are parsed per recorder, all copies of one call are unioned and deduped by
// normalised text, and become proposed rows with the call's refs as provenance. No LLM. Who the subject is comes
// from the tenant's people file (their full and first name, every identity, and "me"), not from code. `due` and the
// initiative stay with the tenant: they are interpretation, confirmed by a human.
import { hash } from './attribution/fragment.js';
import { parseAttendee } from './identities/attendees.js';
import { normaliseName } from './identities/normalise.js';

export interface Step {
  text: string;
  owner: string | null;
}

/** Recorder-specific `next_steps` shapes → {text, owner}. Lines without an owner tag are details or narrative, skipped. */
export function parseNextSteps(source: string, steps: readonly string[]): Step[] {
  const out: Step[] = [];
  for (const raw of steps) {
    const line = (raw ?? '').trim();
    if (!line) continue;
    if (source === 'wispr') {
      const m = line.match(/^\(([^)]+)\)\s*(.+)$/);
      if (m) out.push({ text: m[2]!.trim(), owner: m[1]!.trim() });
      continue;
    }
    if (source === 'gmeet') {
      if (/^details$/i.test(line)) break; // Gemini appends a "Details" narrative after the action items
      const m = line.match(/^\[([^\]]+)\]\s*(.+)$/);
      if (m) out.push({ text: m[2]!.trim(), owner: m[1]!.trim() });
      continue;
    }
    // granola: "step (Owner)" lines followed by detail lines without a trailing owner tag
    const m = line.match(/^(.*\S)\s*\(([^()]{1,40})\)\s*$/);
    if (m && !/\d/.test(m[2]!)) out.push({ text: m[1]!.trim(), owner: m[2]!.trim() });
  }
  return out;
}

export const normText = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const slug = (s: string) => s.toLowerCase().replace(/<[^>]*>/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export interface CallCopy {
  source: string;
  ref: string;
  next_steps: string[];
  attendees: string[];
}
export interface CallIn {
  call_id: string;
  start: string;
  title: string;
  copies: CallCopy[];
}

/**
 * Attendee names for `to` (names win over addresses here: the ledger wants a person, not a mailbox). Entries are read by
 * the one attendee parser (identities/attendees.ts): a `| Company` suffix is no part of a name, and a Gemini line that
 * lands in the email field ("ana berg rui@x.example") gives its name runs and its addresses, not one string.
 */
export function attendeeNames(v: unknown): string[] {
  let list: unknown[] = [];
  try {
    const j = typeof v === 'string' ? JSON.parse(v || '[]') : v;
    list = Array.isArray(j) ? j : [];
  } catch {
    list = [];
  }
  const parsed = list.map(parseAttendee);
  const names = parsed.flatMap((p) => p.names);
  if (names.length) return [...new Set(names)];
  return [...new Set(parsed.flatMap((p) => p.emails))];
}

export interface CommitmentRow {
  id: string;
  owner: string | null;
  to: string | null;
  what: string;
  source: string;
  call: string;
  call_title: string;
  call_start: string;
  provenance: { kind: 'meeting'; ref: string }[];
}

/** The subject's names and addresses, normalised: their full and first name, every identity, and "me". */
export function subjectNames(person: { name: string; identities: readonly string[] } | undefined): Set<string> {
  const out = new Set<string>(['me']);
  if (!person) return out;
  const full = normaliseName(person.name);
  if (full) {
    out.add(full);
    out.add(full.split(' ')[0]!);
  }
  for (const id of person.identities) {
    const body = id.replace(/^(slack|msgraph|teams):/i, '').trim();
    if (body.includes('@')) out.add(body.toLowerCase());
    else if (normaliseName(body)) out.add(normaliseName(body));
  }
  return out;
}

const isSubjectName = (names: ReadonlySet<string>, raw: string) => {
  const s = raw.replace(/\s*<.*$/, '').trim();
  return names.has(s.toLowerCase()) || names.has(normaliseName(s));
};

/**
 * Pure: proposed rows for the calls; ids `c-<hash(call|normalised text)>`, the same as the tenant extractor's. A step the
 * subject owns carries their person id as `owner` and the single other attendee (if there is exactly one) as `to`.
 */
export function extractCommitments(calls: readonly CallIn[], names: ReadonlySet<string>, self: string): CommitmentRow[] {
  const out: CommitmentRow[] = [];
  for (const call of calls) {
    const others = [...new Set(call.copies.flatMap((c) => c.attendees))].filter((a) => !isSubjectName(names, a));
    const to = others.length === 1 ? slug(others[0]!) : null;
    const seen = new Set<string>();
    for (const copy of call.copies) {
      for (const step of parseNextSteps(copy.source, copy.next_steps)) {
        const key = normText(step.text);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const mine = !!step.owner && isSubjectName(names, step.owner);
        out.push({
          id: `c-${hash(call.call_id + '|' + key)}`,
          owner: mine ? self : step.owner ? slug(step.owner) : null,
          to: mine ? to : null,
          what: step.text,
          source: `extract:${copy.source}`,
          call: call.call_id,
          call_title: call.title,
          call_start: call.start,
          provenance: call.copies.map((c) => ({ kind: 'meeting' as const, ref: c.ref })),
        });
      }
    }
  }
  return out;
}
