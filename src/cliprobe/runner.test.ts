import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ClaudeLaunch } from '../claudeSession.js';
import { VersionMismatch, type ProbeCtx, type ProcessHandlers, type Transport } from './ctx.js';
import { runScenario, type RunDirs } from './runner.js';
import type { Frame, Scenario } from './types.js';

// A fake CLI that answers every user message with init + result, reporting `version`.
function transportFactory(version = '2.1.282') {
  const disposed: string[] = [];
  const dirs: RunDirs[] = [];
  const seeded: { dir: string; files: string[] }[] = [];
  const factory = async (d: RunDirs): Promise<Transport> => {
    dirs.push(d);
    return {
      kind: 'local',
      async seed(files: Readonly<Record<string, string>>) {
        seeded.push({ dir: d.workDir, files: Object.keys(files) });
      },
      async start(_l: ClaudeLaunch, h: ProcessHandlers) {
        let alive = true;
        const emit = (f: Frame): void => void setImmediate(() => alive && h.onLine(JSON.stringify(f)));
        return {
          write: async (line: string) => {
            const w = JSON.parse(line) as Frame;
            if (w.type === 'user') {
              emit({ type: 'system', subtype: 'init', session_id: '3f2b9c1e-8d4a-4b6f-9e21-7c5d0a1b2c3d', claude_code_version: version, cwd: `${d.workDir}` });
              emit({ type: 'result', result: 'ok', is_error: false, session_id: '3f2b9c1e-8d4a-4b6f-9e21-7c5d0a1b2c3d', total_cost_usd: 0.01 });
            }
          },
          end: () => void ((alive = false), setImmediate(() => h.onExit(0, null))),
          kill: (sig?: string) => void ((alive = false), setImmediate(() => h.onExit(null, sig ?? 'SIGKILL'))),
        };
      },
      async dispose() {
        disposed.push(d.runId);
      },
    };
  };
  return { factory, disposed, dirs, seeded };
}

const opts = (factory: (d: RunDirs) => Promise<Transport>) => ({ version: '2.1.282', transport: factory, home: '/home/owen', cache: '/home/owen/.cache/cli-probe' });

test('runScenario — a holding scenario settles after its declared runs; recording and observations come out normalized', async () => {
  const { factory, disposed } = transportFactory();
  const s: Scenario<ProbeCtx> = {
    meta: { id: 'turn', hypothesis: 'h', contract: true, runs: 2 },
    async run(ctx) {
      await ctx.send('hi');
      await ctx.expect(ctx.is.result, 1_000, 'a result');
      return { sessionId: ctx.sessionId };
    },
  };
  const r = await runScenario(s, undefined, opts(factory));
  assert.equal(r.verdict, 'holds');
  assert.equal(r.runs.length, 2);
  assert.equal(disposed.length, 2);
  assert.equal(r.runs[0]!.observations.sessionId, '00000000-0000-4000-8000-000000000001');
  const text = JSON.stringify(r.recording);
  assert.ok(!text.includes('/tmp/cli-probe-') && text.includes('/probe/work'), 'the run root is scrubbed');
  assert.ok(Math.abs(r.costUsd - 0.02) < 1e-9);
});

test('runScenario — the run fails midway: the transport is disposed and the failure is in the outcome', async () => {
  const { factory, disposed } = transportFactory();
  const s: Scenario<ProbeCtx> = {
    meta: { id: 'boom', hypothesis: 'h', contract: false, runs: 1 },
    async run() {
      throw new Error('driver lost the session');
    },
  };
  const r = await runScenario(s, undefined, opts(factory));
  assert.equal(r.verdict, 'inconclusive');
  assert.equal(r.runs.length, 3, 'errors are retried within the budget');
  assert.equal(disposed.length, 3);
  assert.match(r.runs[0]!.error!, /driver lost the session/);
});

test('runScenario — a missed prediction fails; a missed precondition is retried', async () => {
  const { factory } = transportFactory();
  let n = 0;
  const s: Scenario<ProbeCtx> = {
    meta: { id: 'p', hypothesis: 'h', contract: false, runs: 1 },
    async run(ctx) {
      n++;
      if (n === 1) ctx.require(false, 'the model calls Bash');
      ctx.check(false, 'the echo comes after the tool result');
    },
  };
  const r = await runScenario(s, undefined, opts(factory));
  assert.deepEqual(r.runs.map((x) => x.verdict), ['inconclusive', 'fails']);
  assert.equal(r.verdict, 'fails');
  assert.match(r.runs[1]!.reason!, /echo comes after/);
});

test('runScenario — the wrong CLI answers: the whole probe stops, after cleanup', async () => {
  const { factory, disposed } = transportFactory('2.1.302');
  const s: Scenario<ProbeCtx> = {
    meta: { id: 'turn', hypothesis: 'h', contract: true, runs: 1 },
    async run(ctx) {
      await ctx.send('hi');
      await ctx.expect(ctx.is.result, 1_000, 'a result');
    },
  };
  await assert.rejects(runScenario(s, undefined, opts(factory)), VersionMismatch);
  assert.equal(disposed.length, 1);
});

test('runScenario — a scenario\'s `files` are seeded into the working directory before the CLI starts (agent-skills: a project skill)', async () => {
  const { factory, seeded, dirs } = transportFactory();
  const s: Scenario<ProbeCtx> = {
    meta: { id: 'seeded', hypothesis: 'h', contract: false, runs: 1, files: { '.claude/skills/probe-marker/SKILL.md': '---\nname: probe-marker\n---\n' } },
    async run(ctx) {
      await ctx.send('hi');
      await ctx.expect(ctx.is.result, 1_000, 'a result');
    },
  };
  await runScenario(s, undefined, opts(factory));
  assert.deepEqual(seeded, [{ dir: dirs[0]!.workDir, files: ['.claude/skills/probe-marker/SKILL.md'] }]);
});
