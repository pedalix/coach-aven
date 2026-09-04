// Subscription-quota signals — the "are we about to run dry?" counter beside metering.ts's
// "what did it cost?" one. All turns run on ONE Claude Max subscription (see metering.ts),
// whose 5-hour / 7-day windows are an opaque server-side counter: token counts and $ in the
// usage log say nothing about how close we are to the wall. The only in-band signal is the
// CLI's `rate_limit_event`, emitted at the start of every turn right before `system/init`:
//
//   {"type":"rate_limit_event","rate_limit_info":{"status":"allowed"|"allowed_warning"|
//     "rejected","rateLimitType":"five_hour"|"seven_day"|…,"resetsAt":<unix s>,
//     "overageStatus":…,"unifiedWindows":{"five_hour":{"utilization":0.01,"resetsAt":…},
//     "seven_day":{…}}}}
//
// Observed on CLI 2.1.183 (no `unifiedWindows` — status + reset only) and 2.1.260 (with
// them). It is UNDOCUMENTED, so parse defensively: every field optional, timestamps
// accepted in seconds or ms, unknown statuses passed through as text. The first sign of an
// exhausted quota used to be a failed user turn ("You've hit your limit…" as an error
// result); this turns the CLI's own warning into an alert-channel post and a /aven status
// line before that happens.

export type RateLimitStatus = 'allowed' | 'allowed_warning' | 'rejected';

export interface RateLimitWindow {
  utilization: number; // 0..1
  resetsAt?: number; // ms epoch
}

export interface RateLimitInfo {
  at: number; // when we observed it (ms epoch)
  status: RateLimitStatus | string;
  limitType?: string; // which window the status is about (five_hour, seven_day, …)
  resetsAt?: number; // ms epoch — when that window resets
  fiveHour?: RateLimitWindow;
  sevenDay?: RateLimitWindow;
}

// Seconds-or-ms tolerant epoch → ms. Anything before ~2001 in ms terms is really seconds.
function epochMs(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined;
  return v < 1e12 ? v * 1000 : v;
}

function windowOf(w: unknown): RateLimitWindow | undefined {
  if (!w || typeof w !== 'object') return undefined;
  const u = (w as { utilization?: unknown }).utilization;
  if (typeof u !== 'number' || !Number.isFinite(u)) return undefined;
  return {
    utilization: Math.max(0, u),
    resetsAt: epochMs((w as { resetsAt?: unknown; resets_at?: unknown }).resetsAt ?? (w as { resets_at?: unknown }).resets_at),
  };
}

// Pure: one stream-json event → RateLimitInfo, or undefined when it isn't one (or carries
// nothing usable). Never throws.
export function parseRateLimitEvent(ev: unknown, now = Date.now()): RateLimitInfo | undefined {
  if (!ev || typeof ev !== 'object') return undefined;
  const e = ev as { type?: unknown; rate_limit_info?: unknown };
  if (e.type !== 'rate_limit_event') return undefined;
  const info = (e.rate_limit_info && typeof e.rate_limit_info === 'object' ? e.rate_limit_info : ev) as Record<string, unknown>;
  const status = typeof info.status === 'string' ? info.status : undefined;
  if (!status) return undefined;
  const windows = (info.unifiedWindows ?? info.unified_windows) as Record<string, unknown> | undefined;
  return {
    at: now,
    status,
    limitType:
      typeof info.rateLimitType === 'string'
        ? info.rateLimitType
        : typeof info.rate_limit_type === 'string'
          ? info.rate_limit_type
          : undefined,
    resetsAt: epochMs(info.resetsAt ?? info.resets_at),
    fiveHour: windowOf(windows?.five_hour),
    sevenDay: windowOf(windows?.seven_day),
  };
}

const pct = (w: RateLimitWindow | undefined): string | undefined => (w ? `${Math.round(w.utilization * 100)}%` : undefined);

// "12:30" / "Mon 16:00" in the operator's zone — enough to know whether to wait or go home.
export function fmtReset(ms: number | undefined, now: number, tz: string): string | undefined {
  if (ms === undefined) return undefined;
  const sameDay = ms - now < 24 * 3_600_000 && ms > now;
  try {
    const opts: Intl.DateTimeFormatOptions = sameDay
      ? { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }
      : {
          weekday: 'short',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
          timeZone: tz,
        };
    return new Intl.DateTimeFormat('en-GB', opts).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(11, 16);
  }
}

// The window figures every rendering shares: "5h 12% · 7d 42%" (omitting what the CLI
// didn't send — old CLIs send no utilization at all).
function windowsText(info: RateLimitInfo): string[] {
  const bits: string[] = [];
  const fh = pct(info.fiveHour);
  const sd = pct(info.sevenDay);
  if (fh) bits.push(`5h ${fh}`);
  if (sd) bits.push(`7d ${sd}`);
  return bits;
}

const humanType = (t: string | undefined): string =>
  t === 'five_hour' ? '5-hour window' : t === 'seven_day' ? '7-day window' : t ? t.replace(/_/g, ' ') : 'quota';

// Pure: the `/aven status` health-line fragment.
export function rateLimitStatusLine(info: RateLimitInfo | undefined, now = Date.now(), tz = process.env.AVEN_TZ || 'UTC'): string {
  if (!info) return 'Claude quota ❔ no turn seen yet';
  const bits = windowsText(info);
  const reset = fmtReset(info.resetsAt, now, tz);
  const ageMin = Math.max(0, Math.floor((now - info.at) / 60_000));
  const age = ageMin < 1 ? 'just now' : `${ageMin}m ago`;
  let head: string;
  if (info.status === 'allowed') head = 'Claude quota ✅';
  else if (info.status === 'allowed_warning') head = `Claude quota ⚠️ warning (${humanType(info.limitType)})`;
  else if (info.status === 'rejected') head = `Claude quota ⛔ exhausted (${humanType(info.limitType)})`;
  else head = `Claude quota ❔ ${info.status}`;
  if (info.status !== 'allowed' && reset) bits.push(`resets ${reset}`);
  return [head, ...bits, `as of ${age}`].join(' · ');
}

export interface RateLimitAlert {
  level: 'warning' | 'rejected' | 'recovered';
  text: string; // alert-channel body (no emoji prefix — the sink adds its own)
}

// Stateful, but pure in its inputs: decides WHEN a fresh observation deserves an alert.
// The subscription is shared by every project, so one tracker serves the whole engine
// (the slug only says which project happened to notice). Rules:
//   • a NON-allowed status alerts once per (status, window type, reset time) — the CLI
//     repeats the same warning on every turn, and 40 turns ≠ 40 alerts; a NEW reset time
//     means a new window hit the wall again, which is worth hearing about;
//   • back to `allowed` after a warning/rejection alerts once ("recovered");
//   • plain allowed → allowed is silence.
export class RateLimitTracker {
  private last?: RateLimitInfo;
  private alerted?: string; // key of the last non-allowed alert; undefined = last state was allowed

  constructor(private readonly tz = process.env.AVEN_TZ || 'UTC') {}

  latest(): RateLimitInfo | undefined {
    return this.last;
  }

  observe(info: RateLimitInfo, slug: string): RateLimitAlert | undefined {
    this.last = info;
    const bad = info.status !== 'allowed';
    if (!bad) {
      if (!this.alerted) return undefined;
      this.alerted = undefined;
      return {
        level: 'recovered',
        text: `Claude quota back to normal (${windowsText(info).join(' · ') || 'allowed'}) — seen on *${slug}*`,
      };
    }
    const key = `${info.status}|${info.limitType ?? ''}|${info.resetsAt ?? ''}`;
    if (key === this.alerted) return undefined;
    this.alerted = key;
    const reset = fmtReset(info.resetsAt, info.at, this.tz);
    const bits = windowsText(info);
    if (reset) bits.push(`resets ${reset}`);
    const tail = bits.length ? ` · ${bits.join(' · ')}` : '';
    if (info.status === 'rejected') {
      return {
        level: 'rejected',
        text: `Claude quota EXHAUSTED — ${humanType(info.limitType)}${tail}. Turns will fail until it resets. Seen on *${slug}*.`,
      };
    }
    return {
      level: 'warning',
      text: `Claude quota warning — ${humanType(info.limitType)} nearly used up${tail}. Seen on *${slug}*.`,
    };
  }
}
