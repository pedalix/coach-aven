// The normalised MEETING record every recorder (Granola, Gemini in Meet, Wispr Flow) emits — one
// shape so the store, the search tool and the tenant's review session learn meetings once
// (docs/sources.md → "Meetings"). Why meetings are a first-class shape and not "a long message":
// commitments are born on calls, and the review session cuts a call into topic FRAGMENTS — it
// needs start/end, attendees and the summary's structure (headings, next steps), not a blob.
//
// Raw files: raw/meetings/<provider>/<account>/meetings.jsonl; the store compacts by
// `source:account:id` (last line wins). Pure functions only — the pullers do the I/O.
import { scrubText, type ScrubMeta } from '../../scrub.js';
import { scrubForWrite, type SinkOptions } from '../common/sink.js';
import type { MeetingProvider } from '../types.js';

export interface MeetingAttendee {
  /** Lower-cased e-mail when the recorder knows it, else ''. */
  email: string;
  name: string;
}

export interface MeetingRecord {
  source: MeetingProvider;
  /** granola: owner e-mail · gmeet: google account · wispr: wispr account e-mail (or "wispr"). */
  account: string;
  id: string;
  title: string;
  /** ISO datetimes; `end` may equal `start` when the recorder does not know the duration. */
  start: string;
  end: string;
  attendees: MeetingAttendee[];
  /** Markdown summary as the recorder wrote it (headings preserved — the review session splits on them). */
  summary: string;
  /** "(Who) what" lines from the recorder's next-steps / action-items section. */
  next_steps: string[];
  /** Plain-text transcript ("Speaker: text" lines), possibly empty. */
  transcript: string;
  /** Where a human opens it (Granola note, Google Doc, Wispr share link). */
  url: string;
  /** Searchable flattening (title + summary + next steps) — what `text` means for every shape. */
  text: string;
  deleted?: boolean;
}

export type ScrubbedMeeting = MeetingRecord & { scrub: ScrubMeta };

type Rec = Record<string, unknown>;
const s = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const isoOr = (v: unknown, fallback = ''): string => {
  const t = Date.parse(s(v));
  return Number.isNaN(t) ? fallback : new Date(t).toISOString();
};

export function flatten(m: Pick<MeetingRecord, 'title' | 'summary' | 'next_steps'>): string {
  return [m.title, m.summary, m.next_steps.length ? `Next steps:\n${m.next_steps.join('\n')}` : ''].filter(Boolean).join('\n\n');
}

/**
 * Pull the "next steps" / "action items" bullets out of a markdown or plain summary. Recorders
 * phrase the heading differently (Granola "Next Steps", Wispr "### Next Steps", Gemini "Suggested
 * next steps" — in the meeting's language, e.g. "Vorgeschlagene nächste Schritte"), so the
 * heading match is loose and the section ends at the next heading.
 */
export function extractNextSteps(summary: string): string[] {
  const lines = summary.split(/\r?\n/);
  const out: string[] = [];
  let inside = false;
  const heading = /^(#{1,6}\s*|\*\*)?\s*(suggested\s+)?(next\s+steps|action\s+items|to-?dos?|vorgeschlagene\s+n[äa]chste\s+schritte|n[äa]chste\s+schritte|дальнейшие\s+шаги|следующие\s+шаги)(?=[\s:*]|$)/iu;
  for (const raw of lines) {
    const line = raw.trim();
    if (heading.test(line)) {
      inside = true;
      continue;
    }
    // A section ends at the next heading, a bold-only line, a horizontal rule or a "Decisions" label
    // (JS \b is ASCII-only, so Cyrillic labels are matched by a lookahead instead).
    if (inside && (/^#{1,6}\s/.test(line) || /^\*\*[^*]+\*\*\s*$/.test(line) || /^(-{3,}|\*{3,}|_{3,})$/.test(line) || /^(decisions?|принятые решения|entscheidungen)(?=[\s:]|$)/iu.test(line))) {
      inside = false;
      continue;
    }
    if (!inside || !line) continue;
    const item = line.replace(/^[-*•]\s*|^\d+[.)]\s*/, '').replace(/\*\*/g, '').trim();
    if (item) out.push(item);
  }
  return out;
}

// ── Granola ──────────────────────────────────────────────────────────────────────────────
// Personal API note (GET /v1/notes/{id}?include=transcript). Real fields: id, title, created_at,
// updated_at, owner{email}, attendees[{email,name}], calendar_event{start_time,end_time,…},
// summary_markdown|summary_text, private_notes_markdown, transcript[{text,start_time,end_time,
// speaker{attribution:me|them}}], web_url.

export function granolaTranscript(t: unknown): string {
  if (!Array.isArray(t)) return '';
  const out: string[] = [];
  let last = '';
  let buf: string[] = [];
  for (const seg of t as Rec[]) {
    const sp = (seg?.speaker ?? {}) as Rec;
    const who = sp.attribution === 'me' ? 'Me' : sp.attribution === 'them' ? 'Them' : s(sp.name) || s(sp.diarization_label) || s(sp.source) || '?';
    if (who !== last && buf.length) {
      out.push(`${last}: ${buf.join(' ')}`);
      buf = [];
    }
    last = who;
    const text = s(seg?.text).trim();
    if (text) buf.push(text);
  }
  if (buf.length) out.push(`${last}: ${buf.join(' ')}`);
  return out.join('\n');
}

export function normaliseGranolaNote(raw: Rec, accountFallback = 'granola'): MeetingRecord {
  const cal = (raw.calendar_event && typeof raw.calendar_event === 'object' ? raw.calendar_event : {}) as Rec;
  const owner = (raw.owner && typeof raw.owner === 'object' ? raw.owner : {}) as Rec;
  const segs = Array.isArray(raw.transcript) ? (raw.transcript as Rec[]) : [];
  const created = isoOr(raw.created_at);
  const start = isoOr(cal.start_time ?? cal.start ?? (cal.start as Rec | undefined)?.dateTime, '') || isoOr(segs[0]?.start_time, '') || created;
  const end = isoOr(cal.end_time ?? cal.end ?? (cal.end as Rec | undefined)?.dateTime, '') || isoOr(segs[segs.length - 1]?.end_time, '') || start;
  const attendees: MeetingAttendee[] = (Array.isArray(raw.attendees) ? (raw.attendees as Rec[]) : []).map((a) => ({ email: s(a?.email).toLowerCase(), name: s(a?.name) }));
  const summary = s(raw.summary_markdown) || s(raw.summary_text) || s(raw.summary);
  const notes = s(raw.private_notes_markdown).trim();
  const m: MeetingRecord = {
    source: 'granola',
    account: s(owner.email).toLowerCase() || accountFallback,
    id: s(raw.id),
    title: s(raw.title) || 'Untitled meeting',
    start,
    end,
    attendees,
    summary: notes ? `${summary}\n\n## Private notes\n\n${notes}` : summary,
    next_steps: extractNextSteps(summary),
    transcript: granolaTranscript(raw.transcript),
    url: s(raw.web_url),
    text: '',
  };
  m.text = flatten(m);
  return m;
}

// ── Gemini in Google Meet ────────────────────────────────────────────────────────────────
// Drive doc named "<title> – 2026/10/07 09:11 CEST – Notes by Gemini" (en dash), exported as
// text/plain. Body sections (language follows the meeting): Summary, topic headings, "Suggested
// next steps", optionally "Details" and a "Transcript" tab.

const TZ_OFFSETS: Record<string, string> = {
  UTC: '+00:00', GMT: '+00:00', CET: '+01:00', CEST: '+02:00', EET: '+02:00', EEST: '+03:00', MSK: '+03:00',
  WET: '+00:00', WEST: '+01:00', BST: '+01:00', EST: '-05:00', EDT: '-04:00', CST: '-06:00', CDT: '-05:00',
  MST: '-07:00', MDT: '-06:00', PST: '-08:00', PDT: '-07:00',
};

export function parseGeminiDocName(name: string): { title: string; start: string } | undefined {
  const m = /^(.*?)\s+[–-]\s+(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})(?:\s+([A-Z]{2,5}|[+-]\d{2}:?\d{2}))?\s+[–-]\s+Notes by Gemini\s*$/.exec(name.trim());
  if (!m) return undefined;
  const [, title, y, mo, d, h, mi, tz] = m;
  const off = tz ? (/^[+-]/.test(tz) ? (tz.includes(':') ? tz : `${tz.slice(0, 3)}:${tz.slice(3)}`) : TZ_OFFSETS[tz]) : undefined;
  const t = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:00${off ?? 'Z'}`);
  if (Number.isNaN(t)) return undefined;
  return { title: (title ?? '').trim() || 'Untitled meeting', start: new Date(t).toISOString() };
}

/** Split an exported Gemini notes doc into summary (everything before the transcript) and transcript. */
export function parseGeminiDoc(text: string): { summary: string; transcript: string; attendees: string[] } {
  const body = text.replace(/\r\n/g, '\n').replace(/^﻿/, '');
  // The transcript tab starts with a heading line "Transcript" (or localised) on its own line.
  const tm = /\n\s*(?:📖\s*)?(Transcript|Transkript|Transcripción|Trascrizione|Transcription|Расшифровка)\s*\n/i.exec(body);
  const summary = (tm ? body.slice(0, tm.index) : body).trim();
  const transcript = tm ? body.slice(tm.index + tm[0].length).trim() : '';
  // Gemini lists invitees right under the title as "Invited <names, comma separated>".
  const inv = /^\s*(?:Invited|Eingeladen|Invitados|Invités|Приглашены)\s+(.+)$/im.exec(summary);
  const attendees = inv?.[1] ? inv[1].split(/\s*,\s*/).map((x) => x.trim()).filter(Boolean) : [];
  return { summary, transcript, attendees };
}

export function normaliseGeminiDoc(file: { id: string; name: string; modified?: string; link?: string }, docText: string, account: string): MeetingRecord | undefined {
  const head = parseGeminiDocName(file.name);
  if (!head) return undefined;
  const doc = parseGeminiDoc(docText);
  const m: MeetingRecord = {
    source: 'gmeet',
    account: account.toLowerCase(),
    id: file.id,
    title: head.title,
    start: head.start,
    end: head.start,
    attendees: doc.attendees.map((a) => (a.includes('@') ? { email: a.toLowerCase(), name: '' } : { email: '', name: a })),
    summary: doc.summary,
    next_steps: extractNextSteps(doc.summary),
    transcript: doc.transcript,
    url: file.link || `https://docs.google.com/document/d/${file.id}`,
    text: '',
  };
  m.text = flatten(m);
  return m;
}

// ── Wispr Flow ───────────────────────────────────────────────────────────────────────────
// MCP `get_meeting` result: id, title, summary (markdown with ### Next Steps / ### Decisions),
// attendees[{name, response, organizer}], start, end, share_link; transcript text fetched in pages.

export function normaliseWisprMeeting(raw: Rec, transcript: string, account = 'wispr'): MeetingRecord {
  const attendees: MeetingAttendee[] = (Array.isArray(raw.attendees) ? (raw.attendees as unknown[]) : []).map((a) =>
    typeof a === 'string' ? { email: a.includes('@') ? a.toLowerCase() : '', name: a.includes('@') ? '' : a } : { email: s((a as Rec)?.email).toLowerCase(), name: s((a as Rec)?.name) },
  );
  const start = isoOr(raw.start, '') || isoOr(raw.modified_at, '');
  const summary = s(raw.summary) || s(raw.content) || s(raw.content_excerpt);
  const m: MeetingRecord = {
    source: 'wispr',
    account,
    id: s(raw.id),
    title: s(raw.title) || 'Untitled meeting',
    start,
    end: isoOr(raw.end, '') || start,
    attendees,
    summary,
    next_steps: extractNextSteps(summary),
    transcript,
    url: s(raw.share_link),
    text: '',
  };
  m.text = flatten(m);
  return m;
}

// ── scrub at the one write path ──────────────────────────────────────────────────────────
// Summary and transcript are scrubbed as separate messages: a transcript where someone READ OUT
// a password is withheld on its own (marker + vault) without taking the summary with it.

export function scrubMeeting(m: MeetingRecord, sink: SinkOptions = {}): ScrubbedMeeting {
  const sum = scrubForWrite({ source: m.source, id: m.id, subject: m.title, text: m.summary }, sink);
  const tr = m.transcript ? scrubForWrite({ source: m.source, id: `${m.id}#transcript`, text: m.transcript }, sink) : { text: '', scrub: { withheld: false, kinds: [], redactions: 0 } as ScrubMeta };
  const title = scrubText(m.title);
  const steps = m.next_steps.map((x) => scrubText(x));
  const kinds = new Set([...sum.scrub.kinds, ...tr.scrub.kinds, ...title.findings.map((f) => f.kind), ...steps.flatMap((x) => x.findings.map((f) => f.kind))]);
  const out: MeetingRecord = { ...m, title: title.text, summary: sum.text, transcript: tr.text, next_steps: steps.map((x) => x.text) };
  out.text = flatten(out);
  return {
    ...out,
    scrub: {
      withheld: sum.scrub.withheld || tr.scrub.withheld,
      kinds: [...kinds].sort(),
      redactions: sum.scrub.redactions + tr.scrub.redactions + title.findings.length + steps.reduce((n, x) => n + x.findings.length, 0),
      ...(sum.scrub.vault ? { vault: sum.scrub.vault } : tr.scrub.vault ? { vault: tr.scrub.vault } : {}),
    },
  };
}
