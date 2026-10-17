// Golden renders of every view kind the Teams driver can show. Re-snapshot on purpose with
// UPDATE_SNAPSHOTS=1, then review the diff like any golden file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { ProjectConfig } from '../../projects.js';
import type { DialogView, HomeView, MessageView, PrivateView } from '../views.js';
import { renderDialogView, renderHomeView, renderMessageView, renderPrivateView } from './cards.js';

const SNAP = new URL('../../fixtures/chat/teams/cards.json', import.meta.url).pathname;
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';

const alpha = { slug: 'alpha', repos: ['Org/alpha'], teamsChannel: '19:CHANNEL1@thread.tacv2' } as ProjectConfig;
const beta = { slug: 'beta', repos: ['Org/beta', 'Org/beta-web'] } as ProjectConfig;
const followUp = { key: 'thread:100', channel: '19:CHANNEL1@thread.tacv2', threadTs: '100' };

const messages: Record<string, MessageView> = {
  status: { kind: 'status', line: '*Working* — 0:12\n• reading src/a.ts', turnId: 't1', notify: 'Working…' },
  text: { kind: 'text', text: ':information_source: Ask me something — `@CoachAven <task>`.' },
  line: { kind: 'line', text: 'Daily digest — 3 PRs merged' },
  background: { kind: 'background', turnId: 't1', elapsedMs: 16 * 60_000 },
  backgroundDone: { kind: 'backgroundDone', label: '🌙 Answered below', steps: 42, elapsedMs: 20 * 60_000 },
  answerPlain: { kind: 'answer', markdown: 'Done.\n\n| a | b |\n|---|---|\n| 1 | 2 |' },
  answerDecorated: {
    kind: 'answer',
    markdown: 'Opened https://github.com/Org/alpha/pull/7 for review.',
    opts: { followUp, trail: { turnId: 't1', steps: 9, elapsedMs: 65_000 }, ytReport: 'SUP-1' },
    notice: ':warning: auto-post failed',
  },
  answerDraft: { kind: 'answer', markdown: 'Draft comment', opts: { followUp, ytDraft: { ticket: 'SUP-1', draftId: 'd1' } } },
  reported: { kind: 'reported', markdown: 'Posted this.', ticket: 'SUP-1', url: 'https://yt/SUP-1', group: 'Support' },
  picker: { kind: 'projectPicker', pid: 'p1', projects: [alpha, beta] },
  question: {
    kind: 'question',
    questions: [{ question: 'Which database?', header: 'Storage', options: [{ label: 'Postgres', description: 'managed' }, { label: 'SQLite' }] }] as never,
    picks: new Map([[0, new Set([1])]]),
    multi: true,
    qid: 'q1',
    done: false,
  },
  questionDone: { kind: 'question', questions: [] as never, picks: new Map(), multi: false, qid: 'q1', done: true },
  heldAsk: { kind: 'heldAsk', held: { id: 'a'.repeat(24), kind: 'task', target: 'northwind/ledger', text: 'Which orders failed today?', why: 'this conversation holds data from bluefin, and northwind does not have it' }, state: 'pending' },
  heldAskSent: { kind: 'heldAsk', held: { id: 'a'.repeat(24), kind: 'reply', target: 'northwind/ledger', text: 'B2C.', why: 'w' }, state: 'sent', by: 'U_HUMAN' },
  relayed: { kind: 'relayed', text: 'Heads-up from alpha', from: 'alpha', by: 'approved by Pat' },
  autofix: { kind: 'autofixNotice', watch: { repo: 'Org/alpha', number: 7 } as never, notes: ['CI failed', 'review requested changes'] },
  ticketHeader: { kind: 'ticketHeader', ticket: { id: 'SUP-1', summary: 'Checkout fails' } as never, url: 'https://yt/SUP-1', extras: 'P1' },
  ticketCard: { kind: 'ticketCard', ticket: { id: 'SUP-1', summary: 'Checkout fails' } as never, url: 'https://yt/SUP-1', attachmentNames: [], flaggedBy: 'Sam' },
};

const privates: Record<string, PrivateView> = {
  text: { kind: 'text', text: ':x: nope' },
  markdown: { kind: 'markdown', markdown: '# Prompt\n\ntext', title: 'System prompt', note: '\n_(truncated)_' },
  statusReport: {
    kind: 'statusReport',
    report: {
      projects: [{ slug: 'alpha', repos: 1, state: 'started', sessions: 2, active: 1, openPRs: 3, jobs: 1, dreams: 0, hk: 1 }],
      turnsInFlight: 1,
      daytonaOk: true,
      githubOk: false,
      claudeQuota: 'Claude quota ✅ · 5h 12%',
    },
  },
  access: { kind: 'access', project: { ...alpha, mcp: [{ name: 'gw' }] } as never },
  routines: { kind: 'routines', routines: [{ id: 'r1', kind: 'report', spec: 'weekdays 9:00', enabled: true, prompt: 'brief me' }] as never },
  allRoutines: { kind: 'allRoutines', groups: [{ slug: 'alpha', routines: [{ id: 'r1', kind: 'report', spec: 'weekdays 9:00', enabled: false, prompt: 'x' }] as never }] },
  memoryIndex: { kind: 'memoryIndex', slug: 'alpha', markdown: '- [Build](build.md)', note: '\n_(snapshot)_', topics: [{ title: 'Build', file: 'build.md' }] },
  sessionPanel: {
    kind: 'sessionPanel',
    info: { slug: 'alpha', repos: ['Org/alpha'], mcp: ['gw'], hasSession: true, sessionSince: '2026-10-16T10:00:00Z', turnInFlight: false, prCreated: true },
    value: '{"key":"thread:100"}',
  },
};

const dialogs: Record<string, DialogView> = {
  trail: { kind: 'trail', trail: { steps: ['read a.ts', 'edit a.ts'], elapsedMs: 4000, done: false } },
  trailGone: { kind: 'trail', trail: undefined },
  trailEmpty: { kind: 'trail', trail: { steps: [], elapsedMs: 0, done: false } },
  feedback: { kind: 'feedback', meta: { turnId: 't1', slug: 'alpha', key: 'thread:100' } },
  ticketLoading: { kind: 'ticketLoading', id: 'SUP-1' },
  ticket: { kind: 'ticket', issue: { id: 'SUP-1', summary: 'Checkout fails', description: 'Steps…' } as never, url: 'https://yt/SUP-1', comments: [], attachmentNames: [] },
  ticketUnavailable: { kind: 'ticketUnavailable', id: 'SUP-1', url: 'https://yt/SUP-1' },
  reportPrompt: { kind: 'reportPrompt', ticket: 'SUP-1', prompt: 'p', contract: 'c', meta: { key: 'k', channel: 'c' } },
  report: { kind: 'report', ticket: 'SUP-1', draft: 'draft', meta: { channel: 'c', ts: '1' } },
  reportExpired: { kind: 'reportExpired', ticket: 'SUP-1' },
};

const homes: Record<string, HomeView> = {
  home: { kind: 'home', projects: [alpha, beta], prefix: 'aven-' },
  onboarding: { kind: 'onboarding' },
};

test('every view kind renders as pinned', () => {
  const got = {
    messages: Object.fromEntries(Object.entries(messages).map(([k, v]) => [k, renderMessageView(v)])),
    privates: Object.fromEntries(Object.entries(privates).map(([k, v]) => [k, renderPrivateView(v)])),
    dialogs: Object.fromEntries(Object.entries(dialogs).map(([k, v]) => [k, renderDialogView(v)])),
    homes: Object.fromEntries(Object.entries(homes).map(([k, v]) => [k, renderHomeView(v)])),
  };
  if (UPDATE || !existsSync(SNAP)) writeFileSync(SNAP, JSON.stringify(got, null, 2) + '\n');
  assert.deepEqual(got, JSON.parse(readFileSync(SNAP, 'utf8')));
});

test('the status card carries the live controls with the turn id', () => {
  const r = renderMessageView(messages.status);
  assert.deepEqual(
    r.card?.actions?.map((a: { data: { action: string; value: string; msteams?: unknown } }) => [a.data.action, a.data.value, !!a.data.msteams]),
    [
      ['show_trail', 't1', true],
      ['cancel_turn', 't1', false],
    ],
  );
});

test('a question card offers one button per option in the answer_q family, plus Submit when multi', () => {
  const r = renderMessageView(messages.question);
  const set = r.card?.body.find((b: { type: string }) => b.type === 'ActionSet') as { actions: { data: { action: string; value: string } }[] };
  assert.deepEqual(set.actions.map((a) => a.data), [
    { action: 'answer_q', value: '{"qid":"q1","qi":0,"oi":0}' },
    { action: 'answer_q', value: '{"qid":"q1","qi":0,"oi":1}' },
  ]);
  assert.deepEqual(r.card?.actions?.map((a: { data: unknown }) => a.data), [{ action: 'submit_q', value: 'q1' }]);
});
