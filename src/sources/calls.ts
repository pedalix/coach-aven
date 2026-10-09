// Calls: one real conversation, however many recorders captured it.
//
// Owen often runs two or three recorders at once (Granola, Gemini in Meet, Wispr) while he
// migrates between them, so one call arrives as up to three `meetings` rows. Search, the
// `meetings` tool and anything that counts time must see ONE call; the copies stay in the
// store because comparing recorder quality is a goal in itself (`get` shows them side by side).
//
// Pure: the store feeds rows in, writes the clusters out (store.ts recomputeCalls).

export interface MeetingForCall {
  ref: string;
  source: string;
  title: string;
  start: string;
  end: string;
  /** Attendee identities (emails or names), lower-cased by the caller or not — compared case-insensitively. */
  attendees: string[];
  transcriptChars: number;
  summaryChars: number;
}

export interface Call {
  call_id: string;
  start: string;
  end: string;
  title: string;
  primary_ref: string;
  sources: { source: string; ref: string }[];
}

/** A recorder that wrote no end time (some Gemini docs) still covered some of the call. */
export const DEFAULT_DURATION_MS = 30 * 60_000;
/** "Same call" = the windows overlap by more than this share of the SHORTER recording. */
export const OVERLAP_SHARE = 0.5;

// Which copy speaks for the call when transcripts tie: the richest summaries first.
const SOURCE_PRIORITY: Record<string, number> = { granola: 0, wispr: 1, gmeet: 2 };

interface Win {
  m: MeetingForCall;
  s: number;
  e: number;
}

function windowOf(m: MeetingForCall): Win | undefined {
  const s = Date.parse(m.start);
  if (!Number.isFinite(s)) return undefined;
  const parsed = Date.parse(m.end);
  const e = Number.isFinite(parsed) && parsed > s ? parsed : s + DEFAULT_DURATION_MS;
  return { m, s, e };
}

/** Overlap of two windows as a share of the shorter one (0..1). */
export function overlapShare(a: { s: number; e: number }, b: { s: number; e: number }): number {
  const ov = Math.min(a.e, b.e) - Math.max(a.s, b.s);
  if (ov <= 0) return 0;
  return ov / Math.min(a.e - a.s, b.e - b.s);
}

/** Recorders' placeholder titles; a call keeps a real title from any copy over these. */
export const GENERIC_TITLE = /^\s*(instant meeting|untitled( meeting)?|meeting|new meeting|null|undefined|)\s*$/i;

const words = (t: string) => new Set(t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));

/** Tie-breaker between several overlapping candidates: shared attendees, then shared title words. */
export function similarity(a: MeetingForCall, b: MeetingForCall): number {
  const aa = new Set(a.attendees.map((x) => x.toLowerCase()));
  const shared = b.attendees.filter((x) => aa.has(x.toLowerCase())).length;
  const ta = words(a.title);
  const tw = [...words(b.title)].filter((w) => ta.has(w)).length;
  return shared * 10 + tw;
}

function primaryOf(ms: MeetingForCall[]): MeetingForCall {
  return [...ms].sort(
    (a, b) =>
      b.transcriptChars - a.transcriptChars ||
      b.summaryChars - a.summaryChars ||
      (SOURCE_PRIORITY[a.source] ?? 9) - (SOURCE_PRIORITY[b.source] ?? 9) ||
      a.ref.localeCompare(b.ref),
  )[0]!;
}

/**
 * Cluster meetings into calls. Greedy over start time: a recording joins the cluster it
 * overlaps by > half of the shorter window (any member counts), never one that already holds a
 * copy from the SAME recorder — two Granola notes back to back are two calls, not one. Several
 * candidates → highest similarity, then largest overlap. Rows without a parseable start are
 * calls of their own.
 */
export function clusterMeetings(meetings: readonly MeetingForCall[]): Call[] {
  const wins = meetings.map((m) => ({ m, w: windowOf(m) }));
  const timed = wins.filter((x): x is { m: MeetingForCall; w: Win } => !!x.w).map((x) => x.w).sort((a, b) => a.s - b.s || a.m.ref.localeCompare(b.m.ref));
  const clusters: Win[][] = [];
  for (const w of timed) {
    let best: { c: Win[]; sim: number; ov: number } | undefined;
    for (const c of clusters) {
      if (c.some((x) => x.m.source === w.m.source)) continue;
      const ov = Math.max(...c.map((x) => overlapShare(x, w)));
      if (ov <= OVERLAP_SHARE) continue;
      const sim = Math.max(...c.map((x) => similarity(x.m, w.m)));
      if (!best || sim > best.sim || (sim === best.sim && ov > best.ov)) best = { c, sim, ov };
    }
    if (best) best.c.push(w);
    else clusters.push([w]);
  }
  const out: Call[] = clusters.map((c) => {
    const members = c.map((x) => x.m);
    const primary = primaryOf(members);
    const s = Math.min(...c.map((x) => x.s));
    const e = Math.max(...c.map((x) => x.e));
    // Stable id: the earliest member's ref (ties by ref). A later copy joining keeps the id.
    const first = [...c].sort((a, b) => a.s - b.s || a.m.ref.localeCompare(b.m.ref))[0]!.m;
    return {
      call_id: `call:${first.ref}`,
      start: new Date(s).toISOString(),
      end: new Date(e).toISOString(),
      title: [primary, ...members].find((m) => !GENERIC_TITLE.test(m.title))?.title ?? primary.title ?? '',
      primary_ref: primary.ref,
      sources: members.map((m) => ({ source: m.source, ref: m.ref })).sort((a, b) => (SOURCE_PRIORITY[a.source] ?? 9) - (SOURCE_PRIORITY[b.source] ?? 9)),
    };
  });
  for (const x of wins) if (!x.w) out.push({ call_id: `call:${x.m.ref}`, start: x.m.start, end: x.m.end, title: x.m.title, primary_ref: x.m.ref, sources: [{ source: x.m.source, ref: x.m.ref }] });
  return out.sort((a, b) => a.start.localeCompare(b.start));
}
