// Pure step-line rendering for the live status / "🧭 Show steps" trail: one human-readable
// line per agent tool call. Kept free of Slack/Daytona deps so it unit-tests in isolation
// (steps.test.ts); the stream plumbing that calls this lives in claudeSession.ts.

function truncate(s: unknown, n = 50): string {
  const str = typeof s === 'string' ? s : '';
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}
function shortPath(p: unknown): string {
  const s = typeof p === 'string' ? p : '';
  return s.length > 56 ? '…' + s.slice(-55) : s;
}

// The most telling string argument of an unknown/MCP tool call, for a one-line preview.
function argPreview(input: Record<string, unknown>): string {
  for (const k of ['query', 'id', 'url', 'prompt', 'pattern', 'name']) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return ` ${truncate(v, 45)}`;
  }
  const v = Object.values(input).find((x) => typeof x === 'string' && (x as string).trim());
  return v ? ` ${truncate(v as string, 45)}` : '';
}

// `subtaskSeq` numbers a Task/Agent spawn ("🤖 Subtask 2: …") so its children — prefixed
// ↳2 by the caller — stay attributable when several subagents run in parallel.
export function stepLabel(name: string, input: Record<string, unknown> = {}, subtaskSeq?: number): string {
  switch (name) {
    case 'Read':
      return `📖 Read ${shortPath(input.file_path ?? input.path)}`;
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return `✏️ Edit ${shortPath(input.file_path ?? input.notebook_path ?? input.path)}`;
    case 'Grep':
      return `🔍 Grep ${truncate(input.pattern)}`;
    case 'Glob':
      return `🔍 Glob ${truncate(input.pattern)}`;
    case 'Bash':
      return `⚙️ ${truncate(input.command, 70)}`;
    case 'Task':
    case 'Agent':
      return `🤖 Subtask${subtaskSeq ? ` ${subtaskSeq}` : ''}: ${truncate(input.description ?? input.prompt)}`;
    case 'WebFetch':
      return `🌐 Fetch ${truncate(input.url)}`;
    case 'WebSearch':
      return `🌐 Search ${truncate(input.query)}`;
    case 'TodoWrite':
      return '📝 Updating plan…';
    default: {
      // MCP tools stream as mcp__<server>__<tool> — render "🔌 server: tool <key arg>"
      // so e.g. a YouTrack search reads as a search, not as a raw identifier.
      const mcp = name.match(/^mcp__(.+?)__(.+)$/);
      if (mcp) return `🔌 ${mcp[1]}: ${mcp[2]}${argPreview(input)}`;
      return `🔧 ${name}`;
    }
  }
}

// ── Trail view: what the "🧭 Show steps" modal actually renders ──────────────
// A long turn streams thousands of these lines, and the modal used to hand Slack every one
// of them chunked into 2900-char sections. That is how the modal broke in prod on 2026-09-08:
// the block cap (95 × 2900 ≈ 267 KB) sits ABOVE Slack's ~250 KB view-payload limit, so once a
// trail crossed it, views.open failed with `internal_error` on EVERY click for the rest of
// that turn — permanently, not intermittently (turn tmtnckb0s-8: 7 clicks, 7 failures, while
// a shorter turn's trail in the same minute opened fine).
//
// So the budget here is measured in CHARACTERS, not blocks, and it is deliberately far below
// Slack's limit: a modal of 92 dense sections is unreadable anyway. Two passes get us under it:
//
//   1. fold — collapse consecutive runs of the same kind of work ("📖 Read ×23 — a.php … z.php").
//      Trails bloat from repetition, not variety, so this usually costs nothing: the shape of
//      the turn stays fully visible. Bash, narration and subtask spawns never fold — each of
//      those lines says something the next one doesn't.
//   2. elide — if it still doesn't fit, keep the head and the tail and drop the middle, saying
//      how many steps went. The head shows how the agent framed the problem, the tail what it
//      concluded (or what it was doing when it died); the middle is the grind.
//
// Step numbers stay the ORIGINAL 1-based indices throughout ("41–63." for a folded run), so a
// number in the modal always means the same thing as the step count in the header.

export const TRAIL_BUDGET = 35_000; // chars of rendered trail text — ~12 modal sections

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

// Step kinds that repeat without each repetition adding much: file reads, edits, searches,
// plan updates, MCP calls. Matched against the line AFTER its ↳N subagent lane prefix.
const FOLDABLE = ['📖 Read', '✏️ Edit', '🔍 Grep', '🔍 Glob', '🌐 Fetch', '🌐 Search', '📝 Updating plan…'];

// The prefix of a step line that identifies "the same kind of work", or undefined for lines
// that must never fold. The ↳N lane is part of the key: two subagents reading files are two
// different stories, and folding across them would imply an ordering that never happened.
function foldKind(line: string): string | undefined {
  const m = /^(↳\d*\s)?([\s\S]*)$/.exec(line);
  const lane = m?.[1] ?? '';
  const body = m?.[2] ?? '';
  for (const v of FOLDABLE) if (body.startsWith(v)) return lane + v;
  // MCP tools stream as "🔌 server: tool <arg>" — fold per (server, tool), not per server.
  const mcp = /^🔌 [^:]+: \S+/.exec(body);
  return mcp ? lane + mcp[0] : undefined;
}

// One rendered line of the modal, carrying the original step range it stands for.
interface Run {
  from: number; // 0-based, inclusive
  to: number; // 0-based, inclusive
  text: string;
}

// Pass 1 — collapse maximal runs of ≥2 consecutive same-kind steps.
export function foldSteps(steps: string[]): Run[] {
  const out: Run[] = [];
  for (let i = 0; i < steps.length; ) {
    const kind = foldKind(steps[i]);
    let j = i;
    if (kind !== undefined) while (j + 1 < steps.length && foldKind(steps[j + 1]) === kind) j++;
    if (kind === undefined || j === i) {
      out.push({ from: i, to: i, text: steps[i] });
    } else {
      // Keep the ends of the run: "📖 Read ×23 — first … last" reads as a sweep with a
      // direction, which is what a reader wants from a fold. Argument-less kinds (a plan
      // update) collapse to the bare count.
      const arg = (k: number): string => steps[k].slice(kind.length).trim();
      const [a, b] = [arg(i), arg(j)];
      const range = a && b && a !== b ? ` — ${a} … ${b}` : a ? ` — ${a}` : '';
      out.push({ from: i, to: j, text: `${kind} ×${j - i + 1}${range}` });
    }
    i = j + 1;
  }
  return out;
}

const numbered = (r: Run): string => `${r.from === r.to ? r.from + 1 : `${r.from + 1}–${r.to + 1}`}. ${r.text}`;

// Pass 2 — fold, then (only if still over budget) keep head + tail and elide the middle.
// Returns the exact lines to render; their joined length is guaranteed ≤ budget.
export function trailView(steps: string[], budget = TRAIL_BUDGET): string[] {
  const runs = foldSteps(steps);
  const lines = runs.map(numbered);
  const len = (ls: string[]): number => ls.reduce((n, l) => n + l.length + 1, 0);
  if (len(lines) <= budget) return lines;

  // The tail gets the lion's share: the end of a trail is where the answer (or the crash)
  // comes from. A placeholder note reserves room so the result cannot overshoot.
  const note = (hidden: number): string => `_… ${plural(hidden, 'step')} hidden …_`;
  const room = budget - note(steps.length).length - 1;
  const headRoom = Math.floor(room * 0.2);

  let head = 0;
  for (let n = 0; head < runs.length && n + lines[head].length + 1 <= headRoom; head++) n += lines[head].length + 1;
  let tail = runs.length;
  for (let n = 0; tail > head && n + lines[tail - 1].length + 1 <= room - headRoom; tail--) n += lines[tail - 1].length + 1;
  if (tail <= head) return [note(steps.length)]; // degenerate budget — say nothing rather than lie

  const hidden = runs[tail - 1].to - runs[head].from + 1; // original steps between the two kept ends
  return [...lines.slice(0, head), note(hidden), ...lines.slice(tail)];
}
