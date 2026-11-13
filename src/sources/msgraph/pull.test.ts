import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphError, TokenError, type GraphPage } from './client.js';
import { accountSlug, type AccountContext, type RawEvent } from './normalise.js';
import { CALENDAR_CURSOR_VERSION, pullCalendar, pullKinds, pullMail, Store, type CalendarGraph, type MailGraph, type Run } from './pull.js';

// Pull-level tests for the calendar branch: a fake Graph that records every URL it is asked for
// and serves one page per route, a real Store on a temp dir, so what is asserted is what lands
// in calendar.jsonl and cursor.json — the contract the store build and the next pass depend on.

const ctx: AccountContext = { tenant_id: '00000000-0000-4000-8000-000000000000', upn: 'owen.hale@partner.example', user_id: 'u1' };
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

// ── one kind's outage, the others go on ────────────────────────────────────

const bad502 = (path: string) => new GraphError(502, 'UnknownError', '', `https://graph.microsoft.com/v1.0${path}`);

function runFor(only: Run['only'], lines: string[]): Run {
  return { ...makeRun(mkdtempSync(join(tmpdir(), 'msgkinds-')), [], lines), only };
}

test('pullKinds: a mail outage is recorded and the later kinds still run', async () => {
  const lines: string[] = [];
  const run = runFor(new Set(['mail', 'chats', 'files']), lines);
  const st = new Store(ctx.upn, run);
  st.cursor.needs_reauth = { at: '2026-11-01T00:00:00Z', error: 'invalid_grant' };
  const ran: string[] = [];
  const reauth = await pullKinds(run, st, [
    ['mail', async () => { ran.push('mail'); throw bad502('/me/mailFolders'); }],
    ['calendar', async () => { ran.push('calendar'); }],
    ['chats', async () => { ran.push('chats'); }],
    ['files', async () => { ran.push('files'); }],
  ]);
  assert.equal(reauth, false);
  assert.deepEqual(ran, ['mail', 'chats', 'files'], 'calendar is not selected; chats and files run past the mail failure');
  assert.deepEqual(st.errors, ['mail: Graph 502 UnknownError:  (https://graph.microsoft.com/v1.0/me/mailFolders)']);
  assert.ok(st.cursor.needs_reauth, 'a run where something threw does not clear needs_reauth (as before)');
});

test('pullKinds: a dead grant is recorded once and stops the run; a clean run clears it', async () => {
  const run = runFor(new Set(['mail', 'chats']), []);
  const st = new Store(ctx.upn, run);
  const ran: string[] = [];
  const dead = new TokenError('invalid_grant', 'AADSTS50078: MFA expired', [50078], 400);
  assert.equal(await pullKinds(run, st, [
    ['mail', async () => { ran.push('mail'); throw dead; }],
    ['chats', async () => { ran.push('chats'); }],
  ]), true);
  assert.deepEqual(ran, ['mail'], 'the same token would fail chats too');
  assert.equal(st.errors.length, 1);
  assert.match(st.errors[0]!, /^NEEDS RE-BOOTSTRAP/);
  assert.match(st.cursor.needs_reauth?.error ?? '', /^invalid_grant 50078: AADSTS50078/);

  assert.equal(await pullKinds(run, st, [['mail', async () => undefined], ['chats', async () => undefined]]), false);
  assert.equal(st.cursor.needs_reauth, undefined);
});

// ── the weekly well-known folder refresh ───────────────────────────────────

/** Well-known folder lookups answer `wellKnown`; the folder list is one empty Inbox, so nothing is paged. */
function mailGraph(wellKnown: (name: string) => Promise<{ id: string }>): { g: MailGraph; urls: string[] } {
  const urls: string[] = [];
  const g: MailGraph = {
    async get<T>(path: string) {
      urls.push(path);
      const name = /^\/me\/mailFolders\/([a-z]+)\?/.exec(path)?.[1];
      if (!name) throw new Error(`unexpected get ${path}`);
      return { body: (await wellKnown(name)) as T, headers: new Headers() };
    },
    // eslint-disable-next-line require-yield
    async *pages<T>(url: string): AsyncGenerator<GraphPage<T>, string | undefined, void> {
      throw new Error(`must not page an empty folder: ${url}`);
    },
    async all<T>(url: string): Promise<T[]> {
      urls.push(url);
      if (url.startsWith('/me/mailFolders?')) return [{ id: 'AQMkInbox', displayName: 'Inbox', totalItemCount: 0, childFolderCount: 0 }] as T[];
      throw new Error(`unexpected list ${url}`);
    },
  };
  return { g, urls };
}

test('pullMail: a Graph error on the weekly refresh keeps the cached skip ids and the mail sync goes on', async () => {
  const lines: string[] = [];
  const run = runFor(new Set(['mail']), lines);
  const st = new Store(ctx.upn, run);
  st.cursor.mail.skip_ids = ['AQMkJunk', 'AQMkDeleted'];
  st.cursor.mail.skip_resolved_at = '2026-11-01T00:00:00.000Z'; // older than a week
  const { g, urls } = mailGraph(async (name) => {
    if (name === 'junkemail') throw bad502(`/me/mailFolders/${name}`);
    return { id: `id-${name}` };
  });
  await pullMail(run, g, st, ctx);
  assert.deepEqual(st.cursor.mail.skip_ids, ['AQMkJunk', 'AQMkDeleted']);
  assert.equal(st.cursor.mail.skip_resolved_at, '2026-11-01T00:00:00.000Z', 'not marked fresh: the next pass tries again');
  assert.ok(urls.some((u) => u.startsWith('/me/mailFolders?')), 'the folders were still listed');
  assert.deepEqual(st.errors, []);
  assert.ok(lines.some((l) => /not re-resolved \(Graph 502.*keeping the 2 cached id\(s\)/.test(l)), lines.join('\n'));
});

test('pullMail: without cached skip ids a failed resolution still fails the mail pass', async () => {
  const run = runFor(new Set(['mail']), []);
  const st = new Store(ctx.upn, run);
  const { g, urls } = mailGraph(async (name) => {
    throw bad502(`/me/mailFolders/${name}`);
  });
  await assert.rejects(pullMail(run, g, st, ctx), /Graph 502/);
  assert.equal(st.cursor.mail.skip_ids, undefined);
  assert.ok(!urls.some((u) => u.startsWith('/me/mailFolders?')), 'nothing is synced without knowing what to skip');
});

test('pullMail: a 404 on a well-known folder is a mailbox without it, not a failure', async () => {
  const run = runFor(new Set(['mail']), []);
  const st = new Store(ctx.upn, run);
  const { g } = mailGraph(async (name) => {
    if (name !== 'junkemail') throw new GraphError(404, 'ErrorFolderNotFound', '', `https://graph.microsoft.com/v1.0/me/mailFolders/${name}`);
    return { id: 'AQMkJunk' };
  });
  await pullMail(run, g, st, ctx);
  assert.deepEqual(st.cursor.mail.skip_ids, ['AQMkJunk']);
  assert.ok(st.cursor.mail.skip_resolved_at);
});
