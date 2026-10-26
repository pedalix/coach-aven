// Golden fragments for every view kind (web-chat-driver 2.4): re-snapshot on purpose with UPDATE_SNAPSHOTS=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { DialogView, HomeView, MessageView, PrivateView } from '../views.js';
import { renderDialogView, renderHomeView, renderMessageView, renderPrivateView } from './webviews.js';

const SNAP = new URL('../../fixtures/chat/web/views.json', import.meta.url).pathname;
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';

const ticket = { id: 'ACME-42', summary: 'Checkout fails on Safari', description: 'Steps:\n\n1. Open **cart**\n2. Pay', projectShortName: 'ACME', tags: ['AI auto review'], createdAt: '2026-10-20T09:00:00Z', reporter: 'Ann', fields: [{ name: 'Priority', value: 'Major' }], links: [{ type: 'relates to', id: 'ACME-40', summary: 'Safari cookies', resolved: true }] } as never;
const messages: Record<string, MessageView> = {
  status: { kind: 'status', line: '🔎 *Working* — 0:12\n• 📖 Read src/a.ts', turnId: 't1', notify: 'Working…' },
  statusQueued: { kind: 'status', line: '⏳ In queue — waiting for the previous message…', turnId: 't2', notify: 'In queue…', queued: true },
  text: { kind: 'text', text: ':information_source: Ask me something — `/aven <task>`. <@u1> knows.' },
  line: { kind: 'line', text: '*Daily digest* — running' },
  background: { kind: 'background', turnId: 't1', elapsedMs: 930_000 },
  backgroundDone: { kind: 'backgroundDone', label: '🌙 *Finished in the background*', steps: 12, elapsedMs: 1_000_000 },
  answer: { kind: 'answer', markdown: 'Fixed it in https://github.com/Org/alpha/pull/7 — **done**.\n\n```ts\nconst x = "<b>";\n```', opts: { followUp: { key: 'web:thread:m1', channel: 'room:alpha', threadTs: 'm1' }, trail: { turnId: 't1', steps: 3, elapsedMs: 5000 }, rate: { turnId: 't1', slug: 'alpha', key: 'web:thread:m1' } } },
  answerHostile: { kind: 'answer', markdown: '<script>alert(1)</script> [x](javascript:alert(1)) <img src=x onerror=alert(1)>', notice: '⚠️ Auto-post failed: *boom* — review and send manually.', opts: { ytDraft: { ticket: 'ACME-42', draftId: 't9' } } },
  answerReport: { kind: 'answer', markdown: 'Investigated.', opts: { followUp: { key: 'web:thread:m1', channel: 'room:alpha', threadTs: 'm1' }, ytReport: 'ACME-42', trail: { turnId: 't1', steps: 0, elapsedMs: 10 } } },
  reported: { kind: 'reported', markdown: 'Root cause: cookies.', ticket: 'ACME-42', url: 'https://yt.example/issue/ACME-42', group: 'Dev team' },
  projectPicker: { kind: 'projectPicker', pid: 'dp1', projects: [{ slug: 'alpha', repos: ['Org/alpha'] }, { slug: 'beta', repos: ['Org/beta'] }] as never },
  heldPending: { kind: 'heldAsk', held: { id: 'h1', kind: 'task', target: 'bluefin/shop', text: 'Please check the <b>order</b> export', why: 'this thread holds another client\'s data' }, state: 'pending' },
  heldSent: { kind: 'heldAsk', held: { id: 'h1', kind: 'reply', target: 'bluefin/shop', text: 'ok', why: 'x' }, state: 'sent', by: 'Ann', note: 'sent at 10:00' },
  autofixNotice: { kind: 'autofixNotice', watch: { repo: 'Org/alpha', number: 7, slug: 'alpha', channel: 'room:alpha' } as never, notes: ['CI failed: lint', 'review requested changes'] },
  ticketHeader: { kind: 'ticketHeader', ticket, url: 'https://yt.example/issue/ACME-42', extras: 'Major · Ann' },
  ticketCard: { kind: 'ticketCard', ticket, url: 'https://yt.example/issue/ACME-42', attachmentNames: ['shot.png'], flaggedBy: 'Bo' },
  question: { kind: 'question', questions: [{ question: 'Which database?', header: 'Storage', options: [{ label: 'Postgres', description: 'the default' }, { label: 'SQLite' }] }], picks: new Map([[0, new Set([1])]]), multi: false, qid: 'q1', done: false },
  questionMulti: { kind: 'question', questions: [{ question: 'Which parts?', multiSelect: true, options: [{ label: 'API' }, { label: 'UI' }] }], picks: new Map(), multi: true, qid: 'q2', done: false },
  questionDone: { kind: 'question', questions: [], picks: new Map(), multi: false, qid: 'q1', done: true },
};
const routines = [
  { id: 'r1', slug: 'alpha', channel: 'room:alpha', cron: '0 9 * * 1-5', tz: 'Europe/Zurich', spec: 'weekdays 9:00', prompt: 'one-line status on open PRs', enabled: true, createdBy: 'u1', createdAt: '2026-10-01T00:00:00Z', lastRunAt: '2026-10-26T07:00:00Z', lastOutcome: 'skipped' },
  { id: 'r2', slug: 'alpha', channel: 'room:alpha', cron: '0 2 * * *', tz: 'UTC', spec: 'daily 2:00', prompt: '', enabled: false, createdBy: 'u1', createdAt: '2026-10-01T00:00:00Z', kind: 'dream', lastSummary: 'consolidated 3 topics' },
] as never[];
const privates: Record<string, PrivateView> = {
  text: { kind: 'text', text: ':white_check_mark: Session restarted — the next message starts fresh.' },
  markdown: { kind: 'markdown', markdown: '# Prompt\n\nYou are *Aven*.', title: 'System prompt — alpha', note: '_truncated_' },
  statusReport: { kind: 'statusReport', report: { projects: [{ slug: 'alpha', repos: 2, state: 'started', sessions: 3, active: 1, openPRs: 2, jobs: 1, dreams: 1, hk: 0, sources: '12 items, fresh' }], turnsInFlight: 1, daytonaOk: true, githubOk: false, claudeQuota: '*Claude quota:* 40% used' } },
  access: { kind: 'access', project: { slug: 'alpha', repos: ['Org/alpha', 'Org/alpha-infra'], mcp: [{ name: 'grafana' }] } as never },
  routines: { kind: 'routines', routines: routines as never },
  routinesEmpty: { kind: 'routines', routines: [] },
  allRoutines: { kind: 'allRoutines', groups: [{ slug: 'alpha', routines: routines as never }, { slug: 'beta', routines: [] }] },
  memoryIndex: { kind: 'memoryIndex', slug: 'alpha', markdown: '- [Deploys](deploys.md)\n- [Testing](testing.md)', note: '_Snapshot from 2026-10-25._', topics: [{ title: 'Deploys', file: 'deploys.md' }, { title: '', file: 'testing.md' }] },
  sessionPanel: { kind: 'sessionPanel', info: { slug: 'alpha', repos: ['Org/alpha'], mcp: ['grafana'], hasSession: true, sessionSince: '2026-10-26T09:30:00Z', turnInFlight: false, prCreated: true }, value: '{"key":"web:thread:m1","channel":"room:alpha","threadTs":"m1"}' },
  sessionPanelFresh: { kind: 'sessionPanel', info: { slug: 'alpha', repos: ['Org/alpha'], hasSession: false, turnInFlight: false, prCreated: false }, value: '{}' },
};
const dialogs: Record<string, DialogView> = {
  trail: { kind: 'trail', trail: { steps: ['📖 Read src/a.ts', '✏️ Edit src/a.ts', '🧪 `npm test`'], elapsedMs: 12_000, done: false } },
  trailDone: { kind: 'trail', trail: { steps: ['📖 Read'], elapsedMs: 1000, done: true } },
  trailEmpty: { kind: 'trail', trail: { steps: [], elapsedMs: 0, done: false } },
  trailGone: { kind: 'trail', trail: undefined },
  feedback: { kind: 'feedback', meta: { turnId: 't1', slug: 'alpha', key: 'web:thread:m1', channel: 'room:alpha', ts: 'm2' } },
  ticketLoading: { kind: 'ticketLoading', id: 'ACME-42' },
  ticket: { kind: 'ticket', issue: ticket, url: 'https://yt.example/issue/ACME-42', comments: [{ author: 'Ann', createdAt: '2026-10-21T10:00:00Z', text: 'Reproduced on **Safari 18**.' }] as never, attachmentNames: ['shot.png'] },
  ticketUnavailable: { kind: 'ticketUnavailable', id: 'ACME-42', url: 'https://yt.example/issue/ACME-42' },
  reportPrompt: { kind: 'reportPrompt', ticket: 'ACME-42', prompt: 'Summarize the <root cause> for support', contract: 'Output ONLY the comment text.', meta: { key: 'web:thread:m1', channel: 'room:alpha', threadTs: 'm1' } },
  report: { kind: 'report', ticket: 'ACME-42', draft: 'Root cause: cookies & "quotes".', meta: { channel: 'room:alpha', ts: 'm9', threadTs: 'm1' } },
  reportExpired: { kind: 'reportExpired', ticket: 'ACME-42' },
};
const homes: Record<string, HomeView> = {
  home: { kind: 'home', projects: [{ slug: 'alpha', repos: ['Org/alpha'] }, { slug: 'beta', repos: ['Org/beta', 'Org/beta-infra'] }] as never, prefix: 'aven-', messaging: true },
  onboarding: { kind: 'onboarding' },
};

test('every view kind renders to its golden fragment', () => {
  const nameOf = (id: string) => (id === 'u1' ? 'Ann Lee' : undefined);
  const got = {
    messages: Object.fromEntries(Object.entries(messages).map(([k, v]) => [k, (({ html, text }) => ({ html: html.html, text }))(renderMessageView(v, { nameOf, tally: k === 'answer' ? { good: 2, bad: 1 } : undefined }))])),
    privates: Object.fromEntries(Object.entries(privates).map(([k, v]) => [k, (({ html, text }) => ({ html: html.html, text }))(renderPrivateView(v, { nameOf }))])),
    dialogs: Object.fromEntries(Object.entries(dialogs).map(([k, v]) => [k, (({ title, html }) => ({ title, html: html.html }))(renderDialogView(v))])),
    homes: Object.fromEntries(Object.entries(homes).map(([k, v]) => [k, renderHomeView(v, (slug) => (slug === 'alpha' ? '/r/alpha' : undefined)).html])),
  };
  if (UPDATE || !existsSync(SNAP)) writeFileSync(SNAP, JSON.stringify(got, null, 2) + '\n');
  assert.deepEqual(got, JSON.parse(readFileSync(SNAP, 'utf8')));
});

test('hostile answer content never yields a script, an inline handler or a javascript: link', () => {
  const html = renderMessageView(messages.answerHostile).html.html;
  assert.ok(!/<script|<img|href="javascript/.test(html), html); // the onerror= survives only as escaped text inside &lt;img …&gt;
  assert.match(html, /&lt;script&gt;/);
});

test('controls carry the core’s action families and values', () => {
  const html = renderMessageView(messages.answer, { tally: { good: 2, bad: 1 } }).html.html;
  assert.match(html, /data-action="show_trail" data-value="t1"/);
  assert.match(html, /data-action="session_panel" data-value="\{&quot;key&quot;:&quot;web:thread:m1&quot;/);
  assert.match(html, /data-action="fb_good"[^>]*>👍 Helped · 2</);
  assert.match(html, /data-action="fb_bad"[^>]*>👎 Missed · 1</);
  assert.match(html, /<a class="btn" href="https:\/\/github\.com\/Org\/alpha\/pull\/7"[^>]*>🔗 View PR<\/a>/);
  const q = renderMessageView(messages.question).html.html;
  assert.match(q, /data-action="answer_q" data-value="\{&quot;qid&quot;:&quot;q1&quot;,&quot;qi&quot;:0,&quot;oi&quot;:1\}"/);
  const d = renderDialogView(dialogs.feedback).html.html;
  assert.match(d, /<form class="dialog-form" data-dialog="feedback" data-meta="\{&quot;t&quot;:&quot;t1&quot;/);
  assert.match(d, /name="reason" value="wrong"/);
  assert.match(renderDialogView(dialogs.reportPrompt).html.html, /data-multi="now"/);
});
