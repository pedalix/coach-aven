import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headline, routineLabel, failureReason, startRoutineTurn, type RoutineEngine, type RoutineSlack, type RoutineOutcome } from './routinerun.js';
import type { ProjectConfig } from './projects.js';

const project = { slug: 'owen-ops', repos: ['owner-example/owen-ops'] } as unknown as ProjectConfig;

// Fake engine modelling the real binding: a key keeps its session; restartSession drops it.
// A reply in a thread is keyed `thread:<ts>` (events.ts), so "same session" = same key → same id.
function fakes() {
  const bound = new Map<string, string>();
  let n = 0;
  const calls: string[] = [];
  const posts: { ts: string; text: string }[] = [];
  const engine: RoutineEngine = {
    restartSession: async (key) => {
      calls.push(`restart ${key}`);
      bound.delete(key);
    },
    liveTurn: async (key, threadTs, _p, _prompt, onAnswer) => {
      if (!bound.has(key)) bound.set(key, `sess-${++n}`);
      calls.push(`turn ${key} in ${threadTs} → ${bound.get(key)}`);
      await onAnswer('**Review 09.10 — 96 decided, 1 question**\nE1 …');
    },
  };
  const slack: RoutineSlack = {
    postParent: async (text) => {
      const ts = `17000000${posts.length}.0001`;
      posts.push({ ts, text });
      return ts;
    },
    updateParent: async (ts, text) => {
      const p = posts.find((x) => x.ts === ts)!;
      p.text = text;
    },
  };
  const replyFrom = (ts: string) => bound.get(`thread:${ts}`); // what a thread reply would resolve to
  return { engine, slack, calls, posts, replyFrom, bound };
}

const run = { legacyKey: 'cron:r3:owen-ops', threadKey: (ts: string) => `thread:${ts}`, label: '🛠 Review session' };

test('a routine posts one parent, runs the turn in its thread, and rewrites the parent to the headline', async () => {
  const f = fakes();
  const ts = await startRoutineTurn(f.engine, f.slack, run, project, 'prompt');
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0]!.text, '🛠 Review session — Review 09.10 — 96 decided, 1 question');
  assert.ok(f.calls.some((c) => c === `turn thread:${ts} in ${ts} → sess-1`));
  assert.ok(f.calls[0]!.startsWith('restart cron:r3:owen-ops'), 'legacy stable binding is cleared first');
});

test('a reply in the run thread resolves to the run session; the next run gets a fresh one', async () => {
  const f = fakes();
  const a = await startRoutineTurn(f.engine, f.slack, run, project, 'p');
  const b = await startRoutineTurn(f.engine, f.slack, run, project, 'p');
  assert.equal(f.replyFrom(a), 'sess-1');
  assert.equal(f.replyFrom(b), 'sess-2');
  assert.notEqual(a, b);
});

test('a failed legacy cleanup does not cost the run', async () => {
  const f = fakes();
  f.engine.restartSession = async () => {
    throw new Error('sandbox down');
  };
  const ts = await startRoutineTurn(f.engine, f.slack, run, project, 'p');
  assert.equal(f.replyFrom(ts), 'sess-1');
});

test('routineLabel and headline', () => {
  assert.equal(routineLabel('task', 'Review session: follow the section'), '🛠 Review session');
  assert.equal(routineLabel(undefined, 'Morning brief по формату'), '📋 Morning brief по формату');
  assert.equal(headline('\n## *Утро, 9 октября* — звонков 3\nmore'), 'Утро, 9 октября — звонков 3');
  assert.equal(headline(''), '');
});

// ── the settle hook (routine delivery guard) ─────────────────────────────────────────────────

// An engine whose turn ends the given way: ok → onAnswer then onSettle('ok'); error/canceled →
// onSettle alone (the real engine renders the error in the thread and resolves).
function settling(outcome: RoutineOutcome, reason?: string) {
  const f = fakes();
  const seen: { onSettle?: unknown }[] = [];
  f.engine.liveTurn = async (_k, _t, _p, _prompt, onAnswer, onSettle) => {
    seen.push({ onSettle });
    if (outcome === 'ok') await onAnswer('**Review 09.10 — 96 decided, 1 question**\nE1 …');
    await onSettle?.(outcome, reason);
  };
  return { ...f, seen };
}

test('without a settle hook the engine gets none — the historical call, parent text unchanged', async () => {
  const f = settling('ok');
  await startRoutineTurn(f.engine, f.slack, run, project, 'p');
  assert.equal(f.seen[0]!.onSettle, undefined);
  assert.equal(f.posts[0]!.text, '🛠 Review session — Review 09.10 — 96 decided, 1 question');
});

test('with the hook: a failed run rewrites the parent to the reason and reports error; a delivered one reports its headline', async () => {
  const err = settling('error', 'command failed (exit 1): gh auth login --with-token < /root/.gh-token\n--- output ---\nerror validating token: Get "https://api.github.com/": EOF');
  const got: unknown[] = [];
  await startRoutineTurn(err.engine, err.slack, run, project, 'p', { onSettle: async (o, info) => void got.push([o, info]) });
  assert.equal(err.posts[0]!.text, '⚠️ 🛠 Review session — failed: command failed (exit 1): gh auth login --with-token < /root/.gh-token');
  assert.deepEqual([...got], [['error', { headline: undefined, reason: 'command failed (exit 1): gh auth login --with-token < /root/.gh-token', key: 'thread:170000000.0001' }]]);

  const ok = settling('ok');
  got.length = 0;
  await startRoutineTurn(ok.engine, ok.slack, run, project, 'p', { onSettle: async (o, info) => void got.push([o, info]) });
  assert.equal(ok.posts[0]!.text, '🛠 Review session — Review 09.10 — 96 decided, 1 question'); // headline rewrite as before
  assert.deepEqual([...got], [['ok', { headline: 'Review 09.10 — 96 decided, 1 question', reason: undefined, key: 'thread:170000000.0001' }]]);

  const can = settling('canceled');
  got.length = 0;
  await startRoutineTurn(can.engine, can.slack, run, project, 'p', { onSettle: async (o, info) => void got.push([o, info]) });
  assert.equal(can.posts[0]!.text, '🛠 Review session — canceled');
  assert.deepEqual([...got], [['canceled', { headline: undefined, reason: undefined, key: 'thread:170000000.0001' }]]); // the run's thread: its tasks are counted by it
});

test('failureReason — one line, separators dropped, an empty head borrows the next line, bounded', () => {
  assert.equal(failureReason('ensureSandbox proj-owen-ops failed (exit 1): \n--- stderr ---\nmount /data/sources is empty while /srv/replica is not — recycling proj-owen-ops\nmount /data/sources still empty after recycle'), 'ensureSandbox proj-owen-ops failed (exit 1): mount /data/sources is empty while /srv/replica is not — recycling proj-owen-ops');
  assert.equal(failureReason('boom'), 'boom');
  assert.equal(failureReason(''), 'unknown error');
  assert.equal(failureReason(undefined), 'unknown error');
  assert.equal(failureReason('x'.repeat(300)).length, 140);
  assert.ok(failureReason('x'.repeat(300)).endsWith('…'));
});
