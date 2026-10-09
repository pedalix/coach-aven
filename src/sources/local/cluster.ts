// Pure time helpers for local activity. Commits and transcript timestamps are POINTS, not
// intervals, so duration is inferred by clustering: points closer than `gapMin` form one
// block; a block lasts from its first to its last point plus `leadInMin` (the work that
// produced the first commit happened before it) and never less than `minMin` (a single
// commit is still work). Deterministic and documented, so a client can be told exactly how
// an hour was derived. Ported from the owen-ops incubator (src/time.ts) unchanged.
export const MIN = 60_000;

export interface Point {
  t: number;
  ref: string;
}
export interface Block {
  start: number;
  end: number;
  minutes: number;
  refs: string[];
}

export function clusterPoints(points: Point[], gapMin: number, leadInMin: number, minMin: number): Block[] {
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const blocks: Block[] = [];
  let cur: Block | null = null;
  for (const p of sorted) {
    if (cur && p.t - cur.end <= gapMin * MIN) {
      cur.end = p.t;
      cur.refs.push(p.ref);
      continue;
    }
    if (cur) blocks.push(cur);
    cur = { start: p.t, end: p.t, minutes: 0, refs: [p.ref] };
  }
  if (cur) blocks.push(cur);
  for (const b of blocks) {
    b.start -= leadInMin * MIN;
    b.minutes = Math.max(minMin, Math.round((b.end - b.start) / MIN));
    if (b.end - b.start < b.minutes * MIN) b.end = b.start + b.minutes * MIN; // keep [start,end] consistent with minutes
  }
  return blocks;
}

/** The local calendar day (YYYY-MM-DD) of an instant in `tz` — blocks never straddle two days. */
export function localDate(iso: string | number | Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Group points by local day, then cluster each day. */
export function clusterByDay(points: Point[], tz: string, gapMin: number, leadInMin: number, minMin: number): Map<string, Block[]> {
  const byDay = new Map<string, Point[]>();
  for (const p of points) {
    const d = localDate(p.t, tz);
    const arr = byDay.get(d);
    if (arr) arr.push(p);
    else byDay.set(d, [p]);
  }
  const out = new Map<string, Block[]>();
  for (const [d, ps] of byDay) out.set(d, clusterPoints(ps, gapMin, leadInMin, minMin));
  return out;
}
