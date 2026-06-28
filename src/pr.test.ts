import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePr, prsToReview, autofixEvents, type OpenPr, type WatchCursor, type ReviewState } from './pr.js';

const PROJECTS = [
  { slug: 'caldora', repos: ['BluefinOrg/caldora-admin', 'BluefinOrg/caldora-frontend'] },
  { slug: 'bluefin-infra', repos: ['BluefinOrg/bluefin-infra'] },
];

test('resolvePr — URL identifies project + canonical repo', () => {
  assert.deepEqual(resolvePr('https://github.com/BluefinOrg/caldora-frontend/pull/23', PROJECTS), {
    slug: 'caldora',
    repo: 'BluefinOrg/caldora-frontend',
    number: 23,
  });
  // URL wins even with words around it.
  assert.deepEqual(resolvePr('pls review https://github.com/BluefinOrg/bluefin-infra/pull/7 thx', PROJECTS), {
    slug: 'bluefin-infra',
    repo: 'BluefinOrg/bluefin-infra',
    number: 7,
  });
});

test('resolvePr — URL for an unowned repo errors', () => {
  assert.ok('error' in resolvePr('https://github.com/Other/repo/pull/1', PROJECTS));
});

test('resolvePr — "<repo> #n" finds the owning project, no channel needed (works in DM)', () => {
  assert.deepEqual(resolvePr('caldora-admin 15', PROJECTS), { slug: 'caldora', repo: 'BluefinOrg/caldora-admin', number: 15 });
  assert.deepEqual(resolvePr('caldora-admin #15', PROJECTS), { slug: 'caldora', repo: 'BluefinOrg/caldora-admin', number: 15 });
  assert.deepEqual(resolvePr('BluefinOrg/caldora-frontend 23', PROJECTS), {
    slug: 'caldora',
    repo: 'BluefinOrg/caldora-frontend',
    number: 23,
  });
});

test('resolvePr — bare number uses the channel project when single-repo', () => {
  assert.deepEqual(resolvePr('#7', PROJECTS, 'bluefin-infra'), { slug: 'bluefin-infra', repo: 'BluefinOrg/bluefin-infra', number: 7 });
});

test('resolvePr — bare number is ambiguous in a multi-repo channel', () => {
  assert.ok('error' in resolvePr('#15', PROJECTS, 'caldora'));
});

test('resolvePr — bare number with no channel (DM) asks for a repo', () => {
  assert.ok('error' in resolvePr('#15', PROJECTS));
});

test('resolvePr — unknown repo and garbage error out', () => {
  assert.ok('error' in resolvePr('nope 15', PROJECTS));
  assert.ok('error' in resolvePr('garbage', PROJECTS));
  assert.ok('error' in resolvePr('', PROJECTS));
});

const pr = (over: Partial<OpenPr> = {}): OpenPr => ({
  repo: 'o/r',
  number: 1,
  author: 'alice',
  createdAt: '2026-06-28T10:00:00Z',
  draft: false,
  ...over,
});

test('prsToReview — reviews a fresh human PR', () => {
  const out = prsToReview([pr()], { botLogin: 'coach-aven[bot]', reviewed: new Set() });
  assert.deepEqual(out.map((p) => p.number), [1]);
});

test('prsToReview — skips drafts, the bot, already-reviewed, and pre-enable PRs', () => {
  const prs = [
    pr({ number: 1 }), // ok
    pr({ number: 2, draft: true }), // draft → skip
    pr({ number: 3, author: 'coach-aven[bot]' }), // bot → skip
    pr({ number: 4 }), // already reviewed → skip
    pr({ number: 5, createdAt: '2026-06-27T00:00:00Z' }), // before `since` → skip
  ];
  const out = prsToReview(prs, {
    since: '2026-06-28T00:00:00Z',
    botLogin: 'coach-aven[bot]',
    reviewed: new Set(['o/r#4']),
  });
  assert.deepEqual(out.map((p) => p.number), [1]);
});

test('prsToReview — no `since` reviews regardless of age (still deduped)', () => {
  const prs = [pr({ number: 9, createdAt: '2020-01-01T00:00:00Z' })];
  assert.equal(prsToReview(prs, { botLogin: 'bot', reviewed: new Set() }).length, 1);
});

const BOT = 'coach-aven[bot]';
const review = (over: Partial<ReviewState> = {}): ReviewState => ({ id: 1, state: 'COMMENTED', author: 'alice', ...over });

test('autofixEvents — CI failure notifies once per head sha', () => {
  const a = autofixEvents({}, { sha: 's1', conclusion: 'failure' }, [], BOT);
  assert.deepEqual(a.notes, ['CI failed']);
  // Same sha already-failed cursor → no repeat.
  const b = autofixEvents(a.next, { sha: 's1', conclusion: 'failure' }, [], BOT);
  assert.deepEqual(b.notes, []);
  // New sha fails → notify again.
  const c = autofixEvents(b.next, { sha: 's2', conclusion: 'failure' }, [], BOT);
  assert.deepEqual(c.notes, ['CI failed']);
});

test('autofixEvents — success/pending/none never notify', () => {
  for (const conclusion of ['success', 'pending', 'none'] as const) {
    assert.deepEqual(autofixEvents({}, { sha: 's', conclusion }, [], BOT).notes, []);
  }
});

test('autofixEvents — new non-bot reviews notify (not approvals/bot/old)', () => {
  const prev: WatchCursor = { lastReviewId: 10, lastCiSha: 's', lastCiConclusion: 'success' };
  const ci = { sha: 's', conclusion: 'success' as const };
  const reviews = [
    review({ id: 10, state: 'COMMENTED' }), // old (<= cursor) → skip
    review({ id: 11, state: 'APPROVED', author: 'bob' }), // approval → skip
    review({ id: 12, state: 'CHANGES_REQUESTED', author: 'carol' }), // notify
    review({ id: 13, state: 'COMMENTED', author: BOT }), // bot → skip
  ];
  const { notes, next } = autofixEvents(prev, ci, reviews, BOT);
  assert.deepEqual(notes, ['carol requested changes']);
  assert.equal(next.lastReviewId, 13); // cursor advances past all seen ids
});
