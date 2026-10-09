// Claude Code transcripts → activity blocks. Every line of ~/.claude/projects/<encoded cwd>/
// <session>.jsonl carries a timestamp, so a session is a dense stream of points: cluster them
// per working directory per local day (gap ≤60 min, no lead-in, min 10). Why sessions at all:
// much of the work is "three hours in Claude Code, one commit at the end", which commits alone
// would under-count. The first real user prompt of each session becomes the block's item, so
// the review agent can tell what the work was about. Files are streamed; only lines that look
// like a user turn are JSON-parsed. Huge files (>50 MB) are read head + tail only.
import { createReadStream, closeSync, openSync, readSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { clusterByDay, MIN } from './cluster.js';
import { blockId, shortContainer, type ActivityRecord } from './normalise.js';

export const CLAUDE_GAP_MIN = 60;
export const CLAUDE_MIN_MIN = 10;
const HEAD_TAIL_LIMIT = 50 * 1024 * 1024;
const HEAD_TAIL_BYTES = 512 * 1024;
const MAX_PARSE = 2 * 1024 * 1024;

/**
 * Claude encodes the cwd by replacing every non-alphanumeric char with `-`, which is lossy
 * (`campaign-manager` vs `campaign/manager`, `.claude` → `-claude`). Resolve greedily against
 * the real filesystem: at each step take the longest run of tokens that names an existing
 * directory. Null when nothing fits; callers then prefer the `cwd` field inside the file.
 */
export function decodeProjectDir(name: string, exists: (p: string) => boolean): string | null {
  const tokens = name.replace(/^-/, '').split('-');
  const walk = (base: string, i: number): string | null => {
    if (i >= tokens.length) return base;
    for (let k = tokens.length - i; k >= 1; k--) {
      const slice = tokens.slice(i, i + k);
      const seg = slice[0] === '' ? '.' + slice.slice(1).join('-') : slice.join('-');
      if (!seg || seg === '.') continue;
      const p = base + '/' + seg;
      if (exists(p)) {
        const r = walk(p, i + k);
        if (r) return r;
      }
    }
    return null;
  };
  return walk('', 0);
}

/** First human prompt of a user line, or undefined for tool results / commands / reminders. */
export function promptOf(line: string): string | undefined {
  if (line.length > MAX_PARSE || !line.includes('"type":"user"') || line.includes('"isMeta":true')) return undefined;
  let j: unknown;
  try {
    j = JSON.parse(line);
  } catch {
    return undefined;
  }
  const msg = (j as { message?: { role?: string; content?: unknown } }).message;
  if (!msg || msg.role !== 'user') return undefined;
  const texts: string[] = typeof msg.content === 'string' ? [msg.content] : Array.isArray(msg.content) ? msg.content.filter((c) => c && typeof c === 'object' && (c as { type?: string }).type === 'text').map((c) => String((c as { text?: unknown }).text ?? '')) : [];
  for (const t of texts) {
    const s = t.trim();
    if (!s || s.startsWith('<') || s.startsWith('Caveat:') || s.startsWith('[Request interrupted')) continue;
    return s.replace(/\s+/g, ' ').slice(0, 200);
  }
  return undefined;
}

export interface SessionScan {
  cwd: string | null;
  /** Unique epoch minutes with activity (minute resolution keeps the cache small). */
  minutes: number[];
  prompt?: string;
}

function scanLine(line: string, acc: { cwd: string | null; mins: Set<number>; prompt?: string }): void {
  if (!acc.cwd) {
    const m = /"cwd":"([^"]+)"/.exec(line);
    if (m) acc.cwd = m[1]!;
  }
  const m = /"timestamp":"(\d{4}-\d{2}-\d{2}T[^"]+)"/.exec(line);
  if (m) {
    const t = Date.parse(m[1]!);
    if (!Number.isNaN(t)) acc.mins.add(Math.floor(t / MIN));
  }
  if (acc.prompt === undefined) {
    const p = promptOf(line);
    if (p) acc.prompt = p;
  }
}

export async function scanSession(file: string): Promise<SessionScan> {
  const size = statSync(file).size;
  const acc: { cwd: string | null; mins: Set<number>; prompt?: string } = { cwd: null, mins: new Set() };
  if (size > HEAD_TAIL_LIMIT) {
    const fd = openSync(file, 'r');
    try {
      for (const pos of [0, Math.max(0, size - HEAD_TAIL_BYTES)]) {
        const buf = Buffer.alloc(Math.min(HEAD_TAIL_BYTES, size));
        const n = readSync(fd, buf, 0, buf.length, pos);
        const lines = buf.subarray(0, n).toString('utf8').split('\n');
        // first/last lines of a window are partial — skip them
        for (const l of lines.slice(pos === 0 ? 0 : 1, -1)) scanLine(l, acc);
      }
    } finally {
      closeSync(fd);
    }
  } else {
    const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) scanLine(line, acc);
  }
  return { cwd: acc.cwd, minutes: [...acc.mins].sort((a, b) => a - b), ...(acc.prompt ? { prompt: acc.prompt } : {}) };
}

export interface CachedSession {
  file: string;
  minutes: number[];
  prompt?: string;
}

/** Pure: one container's sessions → activity blocks keyed by local day. */
export function sessionBlocks(container: string, sessions: CachedSession[], tz: string, host: string): Map<string, ActivityRecord[]> {
  const points = sessions.flatMap((s) => s.minutes.map((m) => ({ t: m * MIN, ref: s.file })));
  const byFile = new Map(sessions.map((s) => [s.file, s]));
  const out = new Map<string, ActivityRecord[]>();
  const short = shortContainer(container);
  for (const [day, blocks] of clusterByDay(points, tz, CLAUDE_GAP_MIN, 0, CLAUDE_MIN_MIN)) {
    out.set(
      day,
      blocks.map((b) => {
        const files = [...new Set(b.refs)];
        const items = files
          .map((f) => {
            const s = byFile.get(f)!;
            const first = s.minutes.find((m) => m * MIN >= b.start) ?? s.minutes[0]!;
            return { ts: new Date(first * MIN).toISOString(), text: s.prompt ?? '(no prompt)' };
          })
          .sort((a, z) => a.ts.localeCompare(z.ts));
        const start = new Date(b.start).toISOString();
        const lead = items.find((i) => i.text !== '(no prompt)')?.text ?? '';
        return {
          source: 'claude',
          account: host,
          id: blockId('claude', container, start),
          container,
          start,
          end: new Date(b.end).toISOString(),
          minutes: b.minutes,
          title: `claude in ${short} (${files.length} session${files.length > 1 ? 's' : ''})${lead ? `: ${lead.slice(0, 80)}` : ''}`,
          items,
        } satisfies ActivityRecord;
      }),
    );
  }
  return out;
}
