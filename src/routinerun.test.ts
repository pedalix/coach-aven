import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRoutineTurn, type RoutineEngine } from './routinerun.js';
import type { ProjectConfig } from './projects.js';

const project = { slug: 'owen-ops', repos: ['owner-example/owen-ops'] } as unknown as ProjectConfig;

// A fake engine that models the real binding: liveTurn reuses the key's session if one is
// bound, otherwise opens a new one; restartSession drops the binding.
function fakeEngine() {
  const bound = new Map<string, string>();
  const calls: string[] = [];
  let n = 0;
  const sessionsUsed: string[] = [];
  const engine: RoutineEngine = {
    restartSession: async (key) => {
      calls.push(`restart:${key}`);
      bound.delete(key);
    },
    liveTurn: async (key) => {
      calls.push(`turn:${key}`);
      if (!bound.has(key)) bound.set(key, `sess-${++n}`);
      sessionsUsed.push(bound.get(key)!);
    },
  };
  return { engine, calls, sessionsUsed, bound };
}

test('every routine fire drops the previous session before the turn', async () => {
  const f = fakeEngine();
  await startRoutineTurn(f.engine, 'cron:r3:owen-ops', project, 'p');
  await startRoutineTurn(f.engine, 'cron:r3:owen-ops', project, 'p');
  assert.deepEqual(f.calls, ['restart:cron:r3:owen-ops', 'turn:cron:r3:owen-ops', 'restart:cron:r3:owen-ops', 'turn:cron:r3:owen-ops']);
  assert.equal(new Set(f.sessionsUsed).size, 2, 'two consecutive fires must run in two different sessions');
  assert.equal(f.bound.size, 1, 'one binding per routine, not one per run');
});

test('a failing cleanup still runs the turn', async () => {
  const f = fakeEngine();
  f.engine.restartSession = async () => {
    throw new Error('sandbox gone');
  };
  await startRoutineTurn(f.engine, 'cron:r1:owen-ops', project, 'p');
  assert.deepEqual(f.calls, ['turn:cron:r1:owen-ops']);
});

test('other keys (threads) are untouched', async () => {
  const f = fakeEngine();
  f.bound.set('thread:1791467846.693019', 'sess-user');
  await startRoutineTurn(f.engine, 'cron:r2:owen-ops', project, 'p');
  assert.equal(f.bound.get('thread:1791467846.693019'), 'sess-user');
});
