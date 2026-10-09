import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headline, routineLabel, startRoutineTurn, type RoutineEngine, type RoutineSlack } from './routinerun.js';
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
