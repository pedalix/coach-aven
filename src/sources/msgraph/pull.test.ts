import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GraphPage } from './client.js';
import { accountSlug, type AccountContext, type RawEvent } from './normalise.js';
import { CALENDAR_CURSOR_VERSION, pullCalendar, Store, type CalendarGraph, type Run } from './pull.js';

// Pull-level tests for the calendar branch: a fake Graph that records every URL it is asked for
// and serves one page per route, a real Store on a temp dir, so what is asserted is what lands
// in calendar.jsonl and cursor.json — the contract the store build and the next pass depend on.

const ctx: AccountContext = { tenant_id: '00000000-0000-4000-8000-000000000000', upn: 'owen.hale@example.com', user_id: 'u1' };
const PRI = 'AQMkPrimary';
const VAL = 'AQMkVincent';
const HOL = 'AQMkHolidays';
const calendars = [
  { id: HOL, name: 'United States holidays', isDefaultCalendar: false },
  { id: PRI, name: 'Calendar', isDefaultCalendar: true },
  { id: VAL, name: 'Vera Lindqvist | HCG', isDefaultCalendar: false },
];

const ev = (id: string, subject: string, lastModifiedDateTime = '2026-10-13T10:00:00Z'): RawEvent => ({
  id,
  subject,
  start: { dateTime: '2026-10-14T09:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-10-14T09:30:00.0000000', timeZone: 'UTC' },
  type: 'singleInstance',
  lastModifiedDateTime,
  // What Graph does for every item of a shared calendar too: organizer = the mailbox owner.
  organizer: { emailAddress: { name: 'Owen Hale', address: ctx.upn } },
  attendees: [],
});

interface Route {
  prefix: string;
  events: RawEvent[];
  delta?: string;
}

/** Records every URL; `pages` serves one page from the first route whose prefix matches and returns its delta link. */
function fakeGraph(routes: Route[]): { g: CalendarGraph; urls: string[] } {
  const urls: string[] = [];
  const g: CalendarGraph = {
    async *pages<T>(url: string): AsyncGenerator<GraphPage<T>, string | undefined, void> {
      urls.push(url);
      const r = routes.find((x) => url.startsWith(x.prefix));
      if (!r) throw new Error(`unexpected page request ${url}`);
      yield { value: r.events as unknown as T[] };
      return r.delta;
    },
    async all<T>(url: string): Promise<T[]> {
      urls.push(url);
      if (url.startsWith('/me/calendars?')) return calendars as unknown as T[];
      throw new Error(`unexpected list request ${url}`);
    },
  };
  return { g, urls };
}

function makeRun(out: string, allow: string[], lines: string[]): Run {
  return {
    out,
    only: new Set(['calendar']),
    since: '2026-04-01T00:00:00.000Z',
    maxText: 0,
    chatsFull: false,
    filesFromNow: false,
    calendars: allow,
    skippedLogged: new Set(),
    log: (m) => lines.push(m),
    vlog: (m) => lines.push(`v ${m}`),
    sink: { warned: { vault: false } },
  };
}

const records = (dir: string) => readFileSync(join(dir, 'calendar.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { id: string; calendar: unknown });
const cursorOf = (dir: string) => (JSON.parse(readFileSync(join(dir, 'cursor.json'), 'utf8')) as { calendar: { version?: number; primary?: { deltaLink?: string }; others: Record<string, { watermark?: string }> } }).calendar;

test('pullCalendar: a v1 cursor is reset once — the default calendar is re-read tagged, shared calendars are skipped unless opted in', async () => {
  const out = mkdtempSync(join(tmpdir(), 'msgcal-'));
  const dir = join(out, 'msgraph', accountSlug(ctx.upn));
  mkdirSync(dir, { recursive: true });
  // The pre-v2 cursor as found on the home bot: a live primary delta link and a watermark for
  // every calendar the mailbox could see (the colleague's shared one included).
  writeFileSync(
    join(dir, 'cursor.json'),
    JSON.stringify({
      version: 1,
      account: ctx.upn,
      mail: { folders: {} },
      calendar: {
        primary: { deltaLink: 'https://graph/old-delta', window_start: '2025-10-08T00:00:00.000Z', window_end: '2027-04-06T00:00:00.000Z' },
        others: { [VAL]: { name: 'Vera Lindqvist | HCG', watermark: '2026-10-13T20:18:20Z' }, [HOL]: { name: 'United States holidays', watermark: '2026-10-01T11:31:48Z' } },
      },
      chats: { per_chat: {} },
      channels: { per_channel: {} },
      files: { drives: {} },
      runs: [],
    }),
  );
  const lines: string[] = [];
  const { g, urls } = fakeGraph([
    { prefix: '/me/calendarView/delta?startDateTime=', events: [ev('own1', 'P5 weekly sync')], delta: 'https://graph/new-delta' },
    { prefix: `/me/calendars/${VAL}/calendarView`, events: [ev('val1', 'Group Management Meeting')] },
  ]);
  const run = makeRun(out, [], lines);
  const st = new Store(ctx.upn, run);
  await pullCalendar(run, g, st, ctx);
  assert.deepEqual(st.errors, []);
  // A fresh window was issued (not the stale delta link) and the shared calendars were never asked for.
  assert.ok(urls.some((u) => u.startsWith('/me/calendarView/delta?startDateTime=')), urls.join('\n'));
  assert.ok(!urls.includes('https://graph/old-delta'));
  assert.ok(!urls.some((u) => u.includes(`/me/calendars/${VAL}/`) || u.includes(`/me/calendars/${HOL}/`)), urls.join('\n'));
  assert.deepEqual(
    records(dir).map((r) => [r.id, r.calendar]),
    [['own1', { id: PRI, name: 'Calendar', is_default: true }]],
  );
  const cur = cursorOf(dir);
  assert.equal(cur.version, CALENDAR_CURSOR_VERSION);
  assert.equal(cur.primary?.deltaLink, 'https://graph/new-delta');
  assert.deepEqual(cur.others, {});
  assert.ok(lines.some((l) => /cursor v1 → v2/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /skipping 2 calendar\(s\).*"United States holidays", "Vera Lindqvist \| HCG"/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => l === `v calendar: skipped "Vera Lindqvist | HCG" id=${VAL}`), 'ids go to the verbose log');

  // Second pass, Vincent's calendar opted in: the primary continues from its delta link (no new
  // window), the opted-in calendar is read in full and tagged as not-default; the holidays stay out.
  const lines2: string[] = [];
  const second = fakeGraph([
    { prefix: 'https://graph/new-delta', events: [], delta: 'https://graph/new-delta-2' },
    { prefix: `/me/calendars/${VAL}/calendarView`, events: [ev('val1', 'Group Management Meeting')] },
  ]);
  const run2 = makeRun(out, [VAL], lines2);
  const st2 = new Store(ctx.upn, run2);
  await pullCalendar(run2, second.g, st2, ctx);
  assert.deepEqual(st2.errors, []);
  assert.ok(!second.urls.some((u) => u.startsWith('/me/calendarView/delta?startDateTime=')), 'a v2 cursor is not reset again');
  assert.ok(second.urls.some((u) => u.startsWith(`/me/calendars/${VAL}/calendarView`)), second.urls.join('\n'));
  assert.ok(!second.urls.some((u) => u.includes(`/me/calendars/${HOL}/`)));
  assert.deepEqual(records(dir).at(-1), { ...records(dir).at(-1), id: 'val1', calendar: { id: VAL, name: 'Vera Lindqvist | HCG', is_default: false } });
  const cur2 = cursorOf(dir);
  assert.equal(cur2.version, CALENDAR_CURSOR_VERSION);
  assert.equal(cur2.primary?.deltaLink, 'https://graph/new-delta-2');
  assert.equal(cur2.others[VAL]?.watermark, '2026-10-13T10:00:00Z');
  assert.ok(lines2.some((l) => /skipping 1 calendar\(s\).*"United States holidays"/.test(l)), lines2.join('\n'));
  assert.ok(!lines2.some((l) => /cursor v/.test(l)));
});

test('pullCalendar: a failing calendar list reads nothing and leaves the cursor for the next pass', async () => {
  const out = mkdtempSync(join(tmpdir(), 'msgcal-'));
  const lines: string[] = [];
  const run = makeRun(out, [], lines);
  const g: CalendarGraph = {
    // eslint-disable-next-line require-yield
    async *pages<T>(): AsyncGenerator<GraphPage<T>, string | undefined, void> {
      throw new Error('must not page when the list failed');
    },
    async all<T>(): Promise<T[]> {
      throw new Error('503 Service Unavailable');
    },
  };
  const st = new Store(ctx.upn, run);
  await pullCalendar(run, g, st, ctx);
  assert.equal(st.errors.length, 1);
  assert.match(st.errors[0]!, /^calendar list: 503/);
  assert.equal(st.cursor.calendar.primary, undefined);
  assert.equal(st.cursor.calendar.version, CALENDAR_CURSOR_VERSION, 'a fresh cursor starts at the current version');
  assert.equal(st.counts.calendar, undefined);
});
