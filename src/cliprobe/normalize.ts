// Pure: a recording made publishable (design D4). It scrubs by shape, and every field keeps its type,
// because the type checks run on the normalized files:
//   1. identifiers the CLI or the API issued → placeholders numbered by first appearance, of the same
//      shape (a UUID stays a UUID, an id keeps its length and alphabet), replaced wherever they occur —
//      inside paths and text too — so cross-references survive;
//   2. opaque blobs (thinking signatures) → a fixed string: random base64 can match a deny-list by chance;
//   3. wall-clock fields and the whole rate-limit information → fixed values;
//   4. every string, at any depth: the run's paths, the home directory, the probe cache, /run/user/<uid>
//      and the CLI's own temp root, in their plain and their encoded (`/` → `-`) forms;
//   5. token-level stream_event deltas collapsed to one per content block (unless kept).
import type { Frame, RecordLine } from './types.js';

export interface RunPaths {
  /** The run's root (work and config directories inside it). */
  runRoot: string;
  home: string;
  cache: string;
  uid?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_IN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// API-issued ids, wherever they occur: tool use, message, request, server tool use, file ids.
const PREFIXED_IN = /\b(toolu|msg|req|srvtoolu|file)_[A-Za-z0-9]{8,}\b/g;
// Fields whose values are CLI-issued ids without a recognizable prefix (run ids encode their start time).
const ID_KEYS = /^(run_id|task_id|agent_id|parent_task_id|shell_id|bash_id|backgroundTaskId|taskId|agentId)$/;
const FIXED_TIME = '2000-01-01T00:00:00.000Z';
const FIXED_EPOCH_S = 4102444800; // 2100-01-01, in seconds like the CLI's resetsAt
const FIXED_SIGNATURE = 'probe-signature';

/** `/home/owen/x` → `-home-owen-x`: how the CLI names folders after a path. */
export const encodePath = (p: string): string => p.replace(/[^A-Za-z0-9]/g, '-');

const uuidPlaceholder = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

// Same length, same alphabet class: every [a-z0-9] → 0, the counter at the end (hex when the original
// is hex-only, base36 otherwise); separators stay where they were.
function idPlaceholder(original: string, n: number): string {
  const hexOnly = /^[0-9a-f-]+$/i.test(original);
  const counter = n.toString(hexOnly ? 16 : 36);
  const chars = original.replace(/[A-Za-z0-9]/g, '0').split('');
  let j = counter.length - 1;
  for (let i = chars.length - 1; i >= 0 && j >= 0; i--) if (chars[i] !== '-' && chars[i] !== '_') chars[i] = counter[j--]!;
  return chars.join('');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function walk(v: Json, visit: (s: string, key: string | undefined) => void, key?: string): void {
  if (typeof v === 'string') visit(v, key);
  else if (Array.isArray(v)) for (const x of v) walk(x, visit, key);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, visit, k);
}

function rewrite(v: Json, fix: (s: string) => string, field: (k: string, x: Json) => Json | undefined): Json {
  if (typeof v === 'string') return fix(v);
  if (Array.isArray(v)) return v.map((x) => rewrite(x, fix, field));
  if (v && typeof v === 'object') {
    const out: Record<string, Json> = {};
    for (const [k, x] of Object.entries(v)) {
      const fixed = field(k, x);
      out[fix(k)] = fixed !== undefined ? fixed : rewrite(x, fix, field);
    }
    return out;
  }
  return v;
}

// The rate-limit information is account state: fixed values, keys kept, types kept, enums valid.
const RATE_LIMIT_STRINGS: Record<string, string> = {
  status: 'allowed',
  rateLimitType: 'five_hour',
  overageStatus: 'rejected',
  overageDisabledReason: 'unknown',
  limitScope: 'service',
  errorCode: 'credits_required',
};
function fixRateLimit(v: Json, key?: string): Json {
  if (typeof v === 'number') return key && /resetsat$/i.test(key) ? FIXED_EPOCH_S : 0.5;
  if (typeof v === 'boolean') return false;
  if (typeof v === 'string') return (key && RATE_LIMIT_STRINGS[key]) ?? 'probe';
  if (Array.isArray(v)) return v.map((x) => fixRateLimit(x, key));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fixRateLimit(x, k)]));
  return v;
}

export function normalizeRecording(lines: readonly RecordLine[], paths: RunPaths, o: { keepPartials?: boolean } = {}): RecordLine[] {
  return makeScrubber(lines, paths).recording(lines, o);
}

/**
 * The scrubber of one run: its identifier map is built from the run's recording, so anything else
 * that came out of the run — a scenario's observations, an error message — is scrubbed with the
 * same placeholders as the recording.
 */
export function makeScrubber(lines: readonly RecordLine[], paths: RunPaths): {
  recording(lines: readonly RecordLine[], o?: { keepPartials?: boolean }): RecordLine[];
  value<T>(v: T): T;
} {
  // 1. identifiers, by first appearance
  const ids = new Map<string, string>();
  const counters = new Map<string, number>();
  const next = (kind: string): number => {
    const n = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, n);
    return n;
  };
  const see = (s: string, key?: string): void => {
    for (const m of s.match(UUID_IN) ?? []) if (!ids.has(m.toLowerCase())) ids.set(m.toLowerCase(), uuidPlaceholder(next('uuid')));
    for (const m of s.matchAll(PREFIXED_IN)) if (!ids.has(m[0])) ids.set(m[0], `${m[1]}_probe_${next(m[1]!)}`);
    if (key && ID_KEYS.test(key) && !UUID.test(s) && !ids.has(s) && s.length >= 6) ids.set(s, idPlaceholder(s, next('id')));
  };
  for (const l of lines) walk('frame' in l ? l.frame : 'argv' in l ? l.argv : [], see);

  // 4. paths, longest first (a work dir before its run root), plain and encoded
  const uid = paths.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
  const candidates: [string, string][] = [
    [`${paths.runRoot}/work`, '/probe/work'],
    [`${paths.runRoot}/config`, '/probe/config'],
    [paths.runRoot, '/probe/root'],
    [paths.cache, '/probe/cache'],
    [paths.home, '/probe/home'],
  ];
  if (uid !== undefined) candidates.push([`/run/user/${uid}`, '/probe/run'], [`/tmp/claude-${uid}`, '/probe/clitmp']);
  const pathRules = candidates.filter(([p]) => p.length > 1);
  const rules: [string, string][] = [...pathRules, ...pathRules.map(([p, r]) => [encodePath(p), encodePath(r)] as [string, string])]
    .sort((a, b) => b[0].length - a[0].length);
  const idRules = [...ids.entries()].sort((a, b) => b[0].length - a[0].length);

  const fix = (s: string): string => {
    let out = s;
    for (const [from, to] of rules) if (out.includes(from)) out = out.split(from).join(to);
    out = out.replace(UUID_IN, (m) => ids.get(m.toLowerCase()) ?? m);
    for (const [from, to] of idRules) if (out.includes(from)) out = out.split(from).join(to);
    return out;
  };
  // 2–3. fields replaced whole
  const field = (k: string, x: Json): Json | undefined => {
    if (k === 'signature' && typeof x === 'string') return FIXED_SIGNATURE;
    if (k === 'timestamp' && typeof x === 'string') return FIXED_TIME;
    if (/resetsAt$/i.test(k) && typeof x === 'number') return FIXED_EPOCH_S;
    if (k === 'rate_limit_info' && x && typeof x === 'object') return fixRateLimit(x);
    return undefined;
  };

  return {
    recording(rec, o = {}) {
      const out: RecordLine[] = rec.map((l) => {
        if ('frame' in l) return { t: l.t, dir: l.dir, frame: rewrite(l.frame, fix, field) as Frame };
        if ('argv' in l) return { t: l.t, proc: 'start', argv: l.argv.map(fix) };
        return { ...l };
      });
      return o.keepPartials ? out : collapseDeltas(out);
    },
    value: <T>(v: T): T => rewrite(v, fix, field) as T,
  };
}

// 5. One delta per content block: the first delta of a block gathers the text of the ones after it.
function collapseDeltas(lines: RecordLine[]): RecordLine[] {
  const firstOf = new Map<string, Json>();
  const out: RecordLine[] = [];
  for (const l of lines) {
    const ev = 'frame' in l && l.frame.type === 'stream_event' ? (l.frame as Json).event : undefined;
    if (ev?.type === 'message_start') firstOf.clear();
    if (ev?.type === 'content_block_delta' && ev.delta && typeof ev.delta === 'object') {
      const k = `${(l as Json).frame.parent_tool_use_id ?? ''}:${ev.index}:${ev.delta.type}`;
      const first = firstOf.get(k);
      if (first) {
        for (const f of ['text', 'partial_json', 'thinking'] as const) {
          if (typeof ev.delta[f] === 'string' && typeof first.delta[f] === 'string') first.delta[f] += ev.delta[f];
        }
        continue;
      }
      firstOf.set(k, ev);
    }
    out.push(l);
  }
  return out;
}
