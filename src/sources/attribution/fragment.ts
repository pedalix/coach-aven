// Fragmenter: cut the subject's days into fragments — the unit attribution is decided on. Only the
// subject's own participation is fragmented (their calls, their runs of messages, their work blocks);
// everything else stays searchable but unattributed. Deterministic: same inputs → same fragment ids,
// so a decision recorded against an id stays attached across rebuilds.
//
//   call   — one per meeting; when the summary has several topic headings (H1/H2), one sub-fragment per
//            topic with `weight` = that section's share of the summary text (decisions carry it as share).
//   thread — a run of the subject's messages in one container with gaps ≤ the configured minutes.
//   work   — a commit/session block from the store's `activity` table, routed by repo or path.
//
// Ported from the owen-ops CLI (src/review/fragment.ts) with the same ids, so its ledger attaches.
import type { Route } from './registry.js';
import { isGarbledMeeting, isLowSubstance } from './substance.js';

export interface MeetingIn {
  source: string;
  id: string;
  title: string;
  start: string;
  end: string;
  attendees: string[];
  summary: string;
  transcriptChars?: number;
  /** Resolved person ids of the attendees. */
  participants: string[];
}

export interface MsgIn {
  ref: string;
  source: string;
  container: string;
  thread_id: string;
  ts: string;
  subject: string;
  text?: string;
  /** Resolved person ids around the run's container. */
  participants: string[];
}

export interface WorkBlock {
  start: string;
  end: string;
  title: string;
  /** `activity:<source>:<id>` */
  ref: string;
  /** The repo or working directory the block ran in. */
  workKey: string | null;
  route: Route;
}

export type FragmentKind = 'call' | 'thread' | 'work';

export interface FragmentDraft {
  id: string;
  kind: FragmentKind;
  start: string;
  end: string;
  refs: string[];
  title: string;
  source: string;
  container: string | null;
  participants: string[];
  projectKeys: string[];
  repo: string | null;
  /** Share of the parent call this sub-fragment stands for (1 for whole fragments). */
  weight: number;
  /** In memory only (substance threshold, admin rung) — never written anywhere. */
  text?: string;
  route?: Route;
}

export const THREAD_GAP_MIN = 45;
const NON_TOPIC = /^(next steps?|action items?|decisions?( made)?|participants?|attendees|summary|todo|follow[- ]ups?|принятые решения|дальнейшие шаги|итоги?)\b/i;
const KEY_RE = /\b([A-Z][A-Z0-9]{1,9})-\d+\b/g;

/** FNV-1a, base 36 — the ids' hash (identical to the owen-ops CLI's, so ledger ids match). */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** Topic sections of a summary: H1/H2 headings, minus structural ones ("Next Steps", "Decisions"). */
export function topics(summary: string): { heading: string; length: number }[] {
  const out: { heading: string; length: number }[] = [];
  let cur: { heading: string; length: number } | null = null;
  for (const line of (summary ?? '').split('\n')) {
    const m = line.match(/^#{1,2}\s+(.+?)\s*#*\s*$/);
    if (m) {
      cur = { heading: m[1]!.replace(/\*+/g, '').trim(), length: 0 };
      out.push(cur);
      continue;
    }
    if (cur) cur.length += line.trim().length;
  }
  return out.filter((t) => !NON_TOPIC.test(t.heading) && t.length > 0);
}

const day = (iso: string) => iso.slice(0, 10);

export function keys(text: string): string[] {
  return [...new Set([...(text ?? '').matchAll(KEY_RE)].map((m) => m[1]!))];
}

export function meetingFragments(m: MeetingIn): FragmentDraft[] {
  // A recorder that caught nothing (garbled one-liner, empty transcript) is not a call.
  if (isGarbledMeeting(m.summary, m.transcriptChars ?? 0)) return [];
  const base = `frag-${day(m.start)}-call-${m.source}-${hash(m.id)}`;
  const refs = [`meeting:${m.source}:${m.id}`];
  const common = { kind: 'call' as const, start: m.start, end: m.end, refs, source: m.source, container: null, participants: m.participants, projectKeys: keys(`${m.title}\n${m.summary}`), repo: null, text: m.title };
  const ts = topics(m.summary);
  if (ts.length <= 1) return [{ ...common, id: base, title: m.title, weight: 1 }];
  const total = ts.reduce((a, t) => a + t.length, 0);
  // The topic sub-fragments share ONE refs array (as in the CLI): refs a greeting run attaches to the call belong to every topic.
  return ts.map((t, i) => ({ ...common, id: `${base}#${i + 1}`, title: `${m.title} — ${t.heading}`, weight: Math.round((t.length / total) * 1000) / 1000 }));
}

export function messageFragments(msgs: MsgIn[], gapMin = THREAD_GAP_MIN): FragmentDraft[] {
  const byContainer = new Map<string, MsgIn[]>();
  for (const m of msgs) byContainer.set(m.container, [...(byContainer.get(m.container) ?? []), m]);
  const out: FragmentDraft[] = [];
  for (const [container, list] of byContainer) {
    const sorted = [...list].sort((a, b) => a.ts.localeCompare(b.ts));
    let run: MsgIn[] = [];
    const flush = () => {
      if (!run.length) return;
      const first = run[0]!;
      const last = run[run.length - 1]!;
      const subjects = [...new Set(run.map((r) => r.subject).filter(Boolean))];
      out.push({
        id: `frag-${day(first.ts)}-thread-${hash(container + '|' + first.ref)}`,
        kind: 'thread',
        start: first.ts,
        end: last.ts,
        refs: run.map((r) => r.ref),
        title: `${container}${subjects.length ? ' — ' + subjects.slice(0, 2).join(' / ') : ''}`,
        source: first.source,
        container,
        participants: [...new Set(run.flatMap((r) => r.participants))],
        // Keys from the text as well as the subjects: Slack replies carry a subject, parents and DMs do not.
        projectKeys: keys([...subjects, ...run.map((r) => r.text ?? '')].join(' ')),
        repo: null,
        weight: 1,
        text: [...subjects, ...run.map((r) => r.text ?? '')].join('\n'),
      });
      run = [];
    };
    for (const m of sorted) {
      const prev = run[run.length - 1];
      if (prev && Date.parse(m.ts) - Date.parse(prev.ts) > gapMin * 60_000) flush();
      run.push(m);
    }
    flush();
  }
  return out;
}

export function workFragments(blocks: WorkBlock[]): FragmentDraft[] {
  const seen = new Set<string>();
  return blocks
    .filter((e) => !seen.has(e.ref + '@' + e.start) && !!seen.add(e.ref + '@' + e.start))
    .map((e) => ({
      id: `frag-${day(e.start)}-work-${hash(e.ref + '@' + e.start)}`,
      kind: 'work' as const,
      start: e.start,
      end: e.end,
      refs: [e.ref],
      title: e.title,
      source: 'activity',
      container: e.workKey,
      participants: [],
      projectKeys: [],
      repo: e.workKey,
      weight: 1,
      route: e.route,
    }));
}

export const ATTACH_WINDOW_MIN = 30;
export interface Settled {
  kept: FragmentDraft[];
  attached: { from: string; to: string }[];
  dropped: { id: string; reason: string }[];
}

/**
 * A run that is only greetings/logistics is not a fragment: its refs join the adjacent call with the same
 * counterpart (within ±30 min, sharing a participant — or naming them in its title when the recorder listed
 * no attendees); otherwise it is dropped. Calls and work pass through. `names`: person_id → display name.
 */
export function settleLowSubstance(drafts: FragmentDraft[], self: string, names: Map<string, string> = new Map(), windowMin = ATTACH_WINDOW_MIN): Settled {
  const calls = drafts.filter((d) => d.kind === 'call');
  const out: Settled = { kept: [], attached: [], dropped: [] };
  for (const d of drafts) {
    if (d.kind !== 'thread' || d.text === undefined || !isLowSubstance([d.text])) {
      out.kept.push(d);
      continue;
    }
    const others = d.participants.filter((p) => p !== self);
    const t0 = Date.parse(d.start);
    const t1 = Date.parse(d.end);
    const near = calls.filter((c) => Date.parse(c.start) - windowMin * 60_000 <= t1 && Date.parse(c.end) + windowMin * 60_000 >= t0);
    const host =
      near.find((c) => c.participants.some((p) => others.includes(p))) ??
      near.find((c) =>
        others.some((p) => {
          const first = (names.get(p) ?? '').split(' ')[0]?.toLowerCase();
          return !!first && first.length > 2 && c.title.toLowerCase().includes(first);
        }),
      );
    if (host) {
      const target = calls.find((c) => c.id === host.id.replace(/#\d+$/, '') || c.id.startsWith(host.id.replace(/#\d+$/, '') + '#')) ?? host;
      for (const r of d.refs) if (!target.refs.includes(r)) target.refs.push(r);
      out.attached.push({ from: d.id, to: target.id });
    } else out.dropped.push({ id: d.id, reason: 'no substance (greeting/logistics only)' });
  }
  return out;
}

/** Names encoded in DM/chat container ids: `chat:@A | Co`, `chat:group:A | Co+B | Co`, `dm:@name`. */
export function containerPeople(c: string): string[] {
  const m = c.match(/^(?:chat:(?:group:)?|dm:)@?(.+)$/i);
  if (!m) return [];
  return m[1]!
    .split('+')
    .map((x) => x.trim())
    .filter((x) => x && !/^[UBW][A-Z0-9]{8,}$/.test(x))
    .flatMap((x) => [x, `slack:${x}`]);
}

/** The same call recorded twice (two recorders): windows overlapping more than half of the shorter one. */
export function dedupeMeetings(ms: MeetingIn[]): MeetingIn[] {
  const kept: MeetingIn[] = [];
  for (const m of ms) {
    const a0 = Date.parse(m.start);
    const a1 = Date.parse(m.end);
    const dup = kept.find((k) => {
      const b0 = Date.parse(k.start);
      const b1 = Date.parse(k.end);
      const ov = Math.min(a1, b1) - Math.max(a0, b0);
      return ov > 0.5 * Math.min(a1 - a0, b1 - b0);
    });
    if (!dup) kept.push(m);
    else {
      if (!dup.summary && m.summary) Object.assign(dup, { summary: m.summary });
      dup.transcriptChars = Math.max(dup.transcriptChars ?? 0, m.transcriptChars ?? 0);
      dup.participants = [...new Set([...dup.participants, ...m.participants])];
    }
  }
  return kept;
}
