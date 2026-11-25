// The nightly tidy's rules (OpenSpec company-brain, design D9): which findings are due, the three-run stop,
// the CLAUDE.md baseline, the hour, and a prompt that stays memory-only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrainIndex } from './index.js';
import { lint, TIDY_FINDINGS, type Finding } from './lint.js';
import { dueFindings, emptyTidyState, endTidy, findingKey, instructionsChanged, startTidy, tidyDay, tidyDigest, tidyPrompt, TIDY_RUNS, type TidyState } from './tidy.js';

const NOW = new Date('2026-05-10T03:00:00.000Z');
const index = (records: Record<string, string>): BrainIndex => ({
  builtAt: NOW.toISOString(),
  records: Object.entries(records).map(([name, hash]) => ({ name, hash, firstSeen: '2026-05-01T00:00:00.000Z', lastChange: '2026-05-01T00:00:00.000Z' })),
  linked: Object.keys(records),
});
const findings = (i: BrainIndex, changed: string[] = []): Finding[] => lint(i, { now: NOW, instructionsChanged: changed });

// One night: start, the "model" leaves the index as given, end.
function night(state: TidyState, before: BrainIndex, after: BrainIndex, day: string, instructions?: Record<string, string>, changed: string[] = []): { state: TidyState; given: string[] } {
  const run = startTidy(findings(before, changed), before, state);
  const next = endTidy(state, run, { index: after, findings: findings(after), instructions }, day);
  return { state: next, given: run.share.map(findingKey) };
}

test('an empty lint gives nothing to do', () => {
  assert.deepEqual(startTidy([], index({}), emptyTidyState()).share, []);
});

test('a finding the tidy resolves is forgotten; one it cannot resolve stops starting tidies after three runs', () => {
  const i = index({ 'lifts.md': 'h1', 'refunds.md': 'h2' }); // both without a kind
  let s = emptyTidyState();
  // Night 1: the tidy types lifts.md (it leaves the lint); refunds.md stays as it was.
  const typed: BrainIndex = { ...i, records: i.records.map((r) => (r.name === 'lifts.md' ? { ...r, kind: 'domain' as const, hash: 'h1b' } : r)) };
  let n = night(s, i, typed, '05-10');
  assert.deepEqual(n.given, ['no-kind:lifts.md', 'no-kind:refunds.md']);
  s = n.state;
  assert.deepEqual(s.given, { 'no-kind:refunds.md': { n: 1, hash: s.given['no-kind:refunds.md']!.hash } });
  // Nights 2 and 3: still there.
  for (const day of ['05-11', '05-12']) s = night(s, typed, typed, day).state;
  assert.equal(s.given['no-kind:refunds.md']!.n, TIDY_RUNS);
  assert.deepEqual(dueFindings(findings(typed), typed, s), [], 'given three times: no longer due');
  assert.equal(findings(typed).length, 1, 'and still listed for people');
});

test('the tidy\'s own edit does not make a finding due again; another turn\'s change does', () => {
  const before = index({ 'refunds.md': 'h1' });
  const edited = index({ 'refunds.md': 'h2' }); // the tidy rewrote it, still no kind
  let s = emptyTidyState();
  s = night(s, before, edited, '05-10').state;
  s = night(s, edited, edited, '05-11').state;
  s = night(s, edited, edited, '05-12').state;
  assert.deepEqual(dueFindings(findings(edited), edited, s), []);
  const later = index({ 'refunds.md': 'h3' }); // a person's turn changed the record
  assert.equal(dueFindings(findings(later), later, s).length, 1);
  assert.equal(startTidy(findings(later), later, s).prior['no-kind:refunds.md'], 0, 'and its count starts over');
});

test('a night\'s share is at most 15, and the rest waits', () => {
  const i = index(Object.fromEntries(Array.from({ length: 40 }, (_, k) => [`r${String(k).padStart(2, '0')}.md`, `h${k}`])));
  assert.equal(startTidy(findings(i), i, emptyTidyState()).share.length, TIDY_FINDINGS);
});

test('CLAUDE.md: the first digest is a baseline; a change is one finding, cleared by the tidy that was given it', () => {
  let s = emptyTidyState();
  let noted = instructionsChanged(s, { 'shop/CLAUDE.md': 'd1' });
  assert.deepEqual(noted.changed, []);
  s = noted.state;
  assert.deepEqual(s.instructions, { 'shop/CLAUDE.md': 'd1' });
  assert.deepEqual(instructionsChanged(s, { 'shop/CLAUDE.md': 'd1' }).changed, [], 'unchanged: nothing');

  noted = instructionsChanged(s, { 'shop/CLAUDE.md': 'd2', 'api/CLAUDE.md': 'e1' });
  assert.deepEqual(noted.changed, ['shop/CLAUDE.md'], 'a second repository starts with its own baseline');
  s = noted.state;
  assert.equal(s.instructions['shop/CLAUDE.md'], 'd1', 'what the last tidy saw stays until a tidy sees the new one');

  const typed: BrainIndex = { ...index({ 'lifts.md': 'h1' }), records: [{ name: 'lifts.md', hash: 'h1', kind: 'domain', firstSeen: NOW.toISOString(), lastChange: NOW.toISOString() }] };
  const n = night(s, typed, typed, '05-10', { 'shop/CLAUDE.md': 'd2', 'api/CLAUDE.md': 'e1' }, noted.changed);
  assert.deepEqual(n.given, ['instructions-changed:'], 'it alone starts a tidy');
  assert.deepEqual(n.state.instructions, { 'shop/CLAUDE.md': 'd2', 'api/CLAUDE.md': 'e1' });
  assert.deepEqual(n.state.given, {}, 'never counted towards the three runs');
  assert.deepEqual(instructionsChanged(n.state, { 'shop/CLAUDE.md': 'd2', 'api/CLAUDE.md': 'e1' }).changed, []);
});

test('a tidy that was not given the CLAUDE.md finding leaves the digests alone', () => {
  const i = index({ 'refunds.md': 'h1' });
  const s: TidyState = { given: {}, instructions: { 'shop/CLAUDE.md': 'd1' } };
  assert.deepEqual(night(s, i, i, '05-10', { 'shop/CLAUDE.md': 'd9' }).state.instructions, { 'shop/CLAUDE.md': 'd1' });
});

test('tidyDay — only during the tidy hour, one key per local day', () => {
  assert.equal(tidyDay({ ho: 3, dom: 9, mon: 5 }), '05-09');
  assert.equal(tidyDay({ ho: 2, dom: 9, mon: 5 }), undefined);
  assert.equal(tidyDay({ ho: 4, dom: 9, mon: 5 }), undefined);
});

test('tidyPrompt — memory only: no code, no CLAUDE.md edits, no transcripts; it lists exactly the share', () => {
  const i = index({ 'refunds.md': 'h1' });
  const p = tidyPrompt('/root/.claude/projects/-work-shop/memory', findings(i));
  assert.match(p, /MEMORY-ONLY/);
  assert.match(p, /do NOT modify code, run builds, install anything, create branches, commit, or open PRs, and do NOT edit any CLAUDE\.md/);
  assert.match(p, /Do not read session transcripts/);
  assert.match(p, /- \[no-kind\] refunds\.md: no `kind`/);
  assert.match(p, /touch no other record/);
  assert.match(p, /git show origin\/HEAD:CLAUDE\.md/);
  assert.match(p, /never pull, check out or switch a branch/);
  assert.doesNotMatch(p, /\.jsonl/);
});

test('tidyDigest — one stripped line, capped', () => {
  assert.equal(tidyDigest('\n**Typed** `refunds.md` as domain.\nMore.'), 'Typed refunds.md as domain.');
  assert.equal(tidyDigest(''), 'no changes');
  assert.equal(tidyDigest('x'.repeat(300)).length, 200);
});

test('a tidy whose own mirror failed still settles the CLAUDE.md finding, and a stale lint does not make it due again', () => {
  const i = index({ 'lifts.md': 'h1' });
  let s = instructionsChanged(emptyTidyState(), { 'shop/CLAUDE.md': 'd1' }).state;
  s = instructionsChanged(s, { 'shop/CLAUDE.md': 'd2' }).state;
  const stale = findings(i, ['shop/CLAUDE.md']); // what lint.json keeps listing while the mirror fails
  const run = startTidy(stale, i, s);
  assert.ok(run.share.some((f) => f.code === 'instructions-changed'));
  s = endTidy(s, run, { index: i, findings: stale }, '05-10'); // no digests: the tidy's mirror failed
  assert.deepEqual(s.instructions, { 'shop/CLAUDE.md': 'd2' }, 'the last digests a mirror noted become the baseline');
  assert.ok(!dueFindings(stale, i, s).some((f) => f.code === 'instructions-changed'), 'not due again, although the stale lint lists it');
});

test('a baseline of another shape (the file hash of an earlier version) is replaced, never reported as a change', () => {
  const old: TidyState = { given: {}, instructions: { 'shop/CLAUDE.md': 'a'.repeat(64) } };
  const noted = instructionsChanged(old, { 'shop/CLAUDE.md': 'b'.repeat(40) });
  assert.deepEqual(noted.changed, []);
  assert.deepEqual(noted.state.instructions, { 'shop/CLAUDE.md': 'b'.repeat(40) });
  assert.deepEqual(instructionsChanged(noted.state, { 'shop/CLAUDE.md': 'c'.repeat(40) }).changed, ['shop/CLAUDE.md']);
});

test('a change another turn noted while the tidy ran is not swallowed when the tidy\'s mirror fails', () => {
  const i = index({ 'lifts.md': 'h1' });
  let s = instructionsChanged(emptyTidyState(), { 'shop/CLAUDE.md': 'd1' }).state;
  s = instructionsChanged(s, { 'shop/CLAUDE.md': 'd2' }).state;
  const run = startTidy(findings(i, ['shop/CLAUDE.md']), i, s);
  s = instructionsChanged(s, { 'shop/CLAUDE.md': 'd3' }).state; // another conversation's mirror, mid-tidy
  s = endTidy(s, run, { index: i, findings: findings(i, ['shop/CLAUDE.md']) }, '05-10');
  assert.equal(s.instructions['shop/CLAUDE.md'], 'd2', 'the baseline is what this tidy was given');
  assert.equal(dueFindings(findings(i, ['shop/CLAUDE.md']), i, s).some((f) => f.code === 'instructions-changed'), true, 'd3 is still due');
});
