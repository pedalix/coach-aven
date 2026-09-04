import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRateLimitEvent, rateLimitStatusLine, RateLimitTracker, fmtReset, type RateLimitInfo } from './ratelimit.js';

const NOW = Date.UTC(2026, 8, 4, 8, 0); // 2026-09-04 08:00Z
const RESET_S = Math.floor(NOW / 1000) + 2 * 3600 + 30 * 60; // 10:30Z, in SECONDS (as the CLI sends)

// Verbatim shapes captured on 2026-09-04: CLI 2.1.260 (with unifiedWindows) and 2.1.183
// (the prod sandbox image — status + reset only).
const ev260 = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed',
    resetsAt: RESET_S,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    overageDisabledReason: 'org_level_disabled',
    isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: 0.01, resetsAt: RESET_S },
      seven_day: { utilization: 0.42, resetsAt: RESET_S + 6 * 86400 },
    },
  },
  uuid: 'u',
  session_id: 's',
};
const ev183 = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed_warning',
    resetsAt: RESET_S,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
  },
};

test('parseRateLimitEvent — 2.1.260 shape: status, window type, seconds→ms reset, utilization windows', () => {
  const i = parseRateLimitEvent(ev260, NOW)!;
  assert.equal(i.status, 'allowed');
  assert.equal(i.limitType, 'five_hour');
  assert.equal(i.resetsAt, RESET_S * 1000);
  assert.equal(i.at, NOW);
  assert.deepEqual(i.fiveHour, { utilization: 0.01, resetsAt: RESET_S * 1000 });
  assert.equal(i.sevenDay?.utilization, 0.42);
});

test('parseRateLimitEvent — 2.1.183 shape has no windows but still parses', () => {
  const i = parseRateLimitEvent(ev183, NOW)!;
  assert.equal(i.status, 'allowed_warning');
  assert.equal(i.fiveHour, undefined);
  assert.equal(i.sevenDay, undefined);
  assert.equal(i.resetsAt, RESET_S * 1000);
});

test('parseRateLimitEvent — ignores other events and junk, tolerates ms timestamps', () => {
  assert.equal(parseRateLimitEvent({ type: 'result' }), undefined);
  assert.equal(parseRateLimitEvent(null), undefined);
  assert.equal(parseRateLimitEvent('x'), undefined);
  assert.equal(parseRateLimitEvent({ type: 'rate_limit_event', rate_limit_info: {} }), undefined); // no status → nothing usable
  const ms = parseRateLimitEvent(
    {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: RESET_S * 1000 },
    },
    NOW,
  )!;
  assert.equal(ms.resetsAt, RESET_S * 1000);
});

test('fmtReset — same-day → HH:MM, later → weekday HH:MM, in the given zone', () => {
  assert.equal(fmtReset(RESET_S * 1000, NOW, 'Europe/Zurich'), '12:30'); // 10:30Z = 12:30 CEST
  assert.equal(fmtReset(RESET_S * 1000, NOW, 'UTC'), '10:30');
  assert.match(fmtReset((RESET_S + 3 * 86400) * 1000, NOW, 'UTC')!, /^Mon,? 10:30$/);
  assert.equal(fmtReset(undefined, NOW, 'UTC'), undefined);
});

test('rateLimitStatusLine — nothing seen / allowed with windows / warning / exhausted', () => {
  assert.equal(rateLimitStatusLine(undefined), 'Claude quota ❔ no turn seen yet');
  const ok = parseRateLimitEvent(ev260, NOW)!;
  assert.equal(rateLimitStatusLine(ok, NOW + 30_000, 'UTC'), 'Claude quota ✅ · 5h 1% · 7d 42% · as of just now');
  const warn = parseRateLimitEvent(ev183, NOW)!;
  assert.equal(rateLimitStatusLine(warn, NOW + 5 * 60_000, 'UTC'), 'Claude quota ⚠️ warning (5-hour window) · resets 10:30 · as of 5m ago');
  const bad: RateLimitInfo = {
    ...ok,
    status: 'rejected',
    limitType: 'seven_day',
    resetsAt: (RESET_S + 6 * 86400) * 1000,
  };
  assert.match(
    rateLimitStatusLine(bad, NOW, 'UTC'),
    /^Claude quota ⛔ exhausted \(7-day window\) · 5h 1% · 7d 42% · resets \w+,? 10:30 · as of just now$/,
  );
});

test('RateLimitTracker — alerts once per warning window, on escalation, and on recovery; silent otherwise', () => {
  const t = new RateLimitTracker('UTC');
  const ok = parseRateLimitEvent(ev260, NOW)!;
  assert.equal(t.observe(ok, 'caldora'), undefined); // allowed from the start → nothing
  assert.equal(t.observe(ok, 'lumora'), undefined);
  assert.equal(t.latest(), ok);

  const warn = parseRateLimitEvent(ev183, NOW)!;
  const a1 = t.observe(warn, 'caldora')!;
  assert.equal(a1.level, 'warning');
  assert.match(a1.text, /warning — 5-hour window nearly used up · resets 10:30\. Seen on \*caldora\*/);
  assert.equal(t.observe(warn, 'lumora'), undefined); // same warning, same window → one alert only

  const rejected: RateLimitInfo = { ...warn, status: 'rejected' };
  const a2 = t.observe(rejected, 'sanity')!;
  assert.equal(a2.level, 'rejected');
  assert.match(a2.text, /EXHAUSTED — 5-hour window/);
  assert.equal(t.observe(rejected, 'sanity'), undefined);

  // A NEW reset time = the next window hit the wall again → alert again.
  const again: RateLimitInfo = {
    ...rejected,
    resetsAt: rejected.resetsAt! + 5 * 3_600_000,
  };
  assert.equal(t.observe(again, 'caldora')?.level, 'rejected');

  const back = t.observe(ok, 'caldora')!;
  assert.equal(back.level, 'recovered');
  assert.match(back.text, /back to normal \(5h 1% · 7d 42%\)/);
  assert.equal(t.observe(ok, 'caldora'), undefined); // recovered once, then quiet
});
