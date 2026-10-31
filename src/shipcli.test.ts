// shipcli's effects with a stubbed runner (OpenSpec ship-dispatcher, tasks 3.3–3.4): the step order, tagging and the
// release wait, stop-at-first-failure with the journal, and `where` over overlays in a temp checkout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { executeSteps, runWhere, type Deps, type RunResult, type Runner } from './shipcli.js';
import type { Step } from './ship.js';

const C = (n: number) => n.toString(16).padStart(2, '0').repeat(20);
const res = (stdout = '', status = 0, stderr = ''): RunResult => ({ status, stdout, stderr });

function stub(handler: (cmd: string, args: string[]) => RunResult): { runner: Runner; calls: string[] } {
  const calls: string[] = [];
  const run = (cmd: string, args: string[]) => (calls.push(`${cmd} ${args.join(' ')}`), handler(cmd, args));
  return { calls, runner: { run, runAsync: async (cmd, args) => run(cmd, args) } };
}

function deps(runner: Runner, root: string): Deps & { outs: string[]; errs: string[] } {
  const outs: string[] = [], errs: string[] = [];
  return { root, runner, out: (l) => outs.push(l), err: (l) => errs.push(l), now: () => new Date('2026-10-31T12:00:00Z'), sleep: () => {}, outs, errs };
}

function checkout(overlays: Record<string, string>): string {
  const root = mkdtempSync(`${tmpdir()}/shipcli-`);
  for (const [slug, env] of Object.entries(overlays)) {
    mkdirSync(`${root}/infra/${slug}`, { recursive: true });
    writeFileSync(`${root}/infra/${slug}/deploy.env`, env);
  }
  return root;
}

const STEPS: Step[] = [
  { slug: 'home', stage: 1, canary: true, commit: C(6), version: `sha-${C(6)}`, createTag: false, from: { version: `sha-${C(5)}`, commit: C(5) }, prs: [] },
  { slug: 'pilot', stage: 2, canary: true, commit: C(6), version: `sha-${C(6)}`, createTag: false, from: { version: `sha-${C(3)}`, commit: C(3) }, prs: [] },
  { slug: 'prod', stage: 3, canary: false, commit: C(6), version: 'v0.49.0', createTag: true, from: { version: 'v0.48.0', commit: C(2) }, prs: [] },
];

test('a three-stage ship: deploys in order, tags once, waits for the release, journals three ok lines', () => {
  const root = checkout({});
  const s = stub((cmd, args) => {
    if (cmd === 'gh' && args[1] === 'list') return res(JSON.stringify([{ databaseId: 7, headBranch: 'v0.49.0', url: 'https://ci.example/7' }]));
    if (cmd === 'gh' && args[1] === 'view') return res('{"conclusion":"success"}');
    return res();
  });
  const d = deps(s.runner, root);
  assert.equal(executeSteps(d, STEPS), 0);
  const deploysAndTags = s.calls.filter((c) => / deploy |^git (tag|push)/.test(c)).map((c) => c.replace(root, '<root>'));
  assert.deepEqual(deploysAndTags, [
    `bash <root>/infra/deploy/deploy.sh home deploy sha-${C(6)}`,
    `bash <root>/infra/deploy/deploy.sh pilot deploy sha-${C(6)}`,
    `git tag v0.49.0 ${C(6)}`,
    'git push origin v0.49.0',
    'bash <root>/infra/deploy/deploy.sh prod deploy v0.49.0',
  ]);
  assert.ok(s.calls.indexOf('gh run watch 7 --exit-status --interval 15') < s.calls.findIndex((c) => c.includes('prod deploy')), 'prod waits for the release');
  const journal = readFileSync(`${root}/infra/ships.log`, 'utf8').trim().split('\n');
  assert.deepEqual(journal.map((l) => l.split(' ').slice(1, 3).concat(l.split(' ')[4])), [
    ['home', `sha-${C(6)}`, 'ok'], ['pilot', `sha-${C(6)}`, 'ok'], ['prod', 'v0.49.0', 'ok'],
  ]);
});

test('Staging does not come up: prod is not touched, the journal says failed, the message names the slug and the earlier version', () => {
  const root = checkout({});
  const s = stub((cmd, args) => (cmd === 'bash' && args[1] === 'pilot' ? res('', 1) : res()));
  const d = deps(s.runner, root);
  assert.equal(executeSteps(d, STEPS), 1);
  assert.equal(s.calls.some((c) => c.includes('prod') || c.startsWith('git tag')), false);
  assert.match(readFileSync(`${root}/infra/ships.log`, 'utf8'), /home \S+ \S+ ok\n.* pilot \S+ \S+ failed\n$/);
  assert.match(d.errs.join('\n'), /pilot: deploy of sha-\S+ failed — it still runs sha-0303.*npm run ship -- pilot --version sha-0303/);
});

test('The release workflow fails: nothing is deployed after the tag, and the run is linked', () => {
  const root = checkout({});
  const s = stub((cmd, args) => {
    if (cmd === 'gh' && args[1] === 'list') return res(JSON.stringify([{ databaseId: 9, headBranch: 'v0.49.0', url: 'https://ci.example/9' }]));
    if (cmd === 'gh' && args[1] === 'view') return res('{"conclusion":"failure"}');
    return res();
  });
  const d = deps(s.runner, root);
  assert.equal(executeSteps(d, [STEPS[2]]), 1);
  assert.equal(s.calls.some((c) => c.includes('prod deploy')), false);
  assert.match(d.errs.join('\n'), /release workflow for v0\.49\.0 did not succeed: https:\/\/ci\.example\/9/);
});

const OVERLAYS = {
  home: 'DEPLOY_HOST=localhost\nCANARY=1\nSTAGE=1\n',
  pilot: 'DEPLOY_HOST=pilot.example\nCANARY=1\nSTAGE=2\n',
  prod: 'DEPLOY_HOST=prod.example\nSTAGE=3\n',
  lab: 'DEPLOY_HOST=lab.example\n', // no STAGE: not part of the report
};

function whereStub(unreachable = false) {
  const order = [1, 2, 3, 4, 5, 6].map(C);
  return stub((cmd, args) => {
    if (cmd === 'bash' && args[2] === 'pinned') {
      if (args[1] === 'home') return res(`sha-${C(5)}\n`);
      if (args[1] === 'pilot') return unreachable ? res('', 255, '✗ ssh: connect to host pilot.example: timed out') : res(`sha-${C(3)}\n`);
      if (args[1] === 'prod') return res('v0.48.0\n');
    }
    if (cmd === 'git' && args[0] === 'rev-list' && args[2] === 'refs/tags/v0.48.0') return res(C(2));
    if (cmd === 'git' && args[0] === 'merge-base') return res('', order.indexOf(args[2]) <= order.indexOf(args[3]) ? 0 : 1);
    if (cmd === 'git' && args[0] === 'rev-list' && args[1] === '--count') return res(String(5 - order.indexOf(args[2].split('..')[0])));
    if (cmd === 'gh' && args[0] === 'pr') return res(JSON.stringify({ state: 'MERGED', mergeCommit: { oid: C(4) } }));
    return res();
  });
}

test('where 142: ✓ where the merge commit is contained, ✗ where not', async () => {
  const root = checkout(OVERLAYS);
  writeFileSync(`${root}/infra/ships.log`, `2026-10-31T09:00:00Z home sha-${C(5)} ${C(5).slice(0, 12)} ok\n`);
  const d = deps(whereStub().runner, root);
  assert.equal(await runWhere(d, '142'), 0);
  assert.equal(d.outs.join('\n'), ['#142 (0404040):', '  home ✓ sha-0505050, since 2026-10-31T09:00:00Z', '  pilot ✗ sha-0303030', '  prod ✗ v0.48.0 (0202020)'].join('\n'));
});

test('where with no argument: version and lag per staged installation; an unreachable box is named and fails', async () => {
  const root = checkout(OVERLAYS);
  const d = deps(whereStub(true).runner, root);
  assert.equal(await runWhere(d), 1);
  assert.equal(d.outs.join('\n'), [
    '  home (stage 1): sha-0505050 — 1 commit behind main',
    '  pilot: unreachable (ssh: connect to host pilot.example: timed out)',
    '  prod (stage 3): v0.48.0 (0202020) — 4 commits behind main',
  ].join('\n'));
});

test('where for an unmerged PR says it runs nowhere', async () => {
  const root = checkout(OVERLAYS);
  const s = stub((cmd) => (cmd === 'gh' ? res(JSON.stringify({ state: 'OPEN', mergeCommit: null })) : res()));
  const d = deps(s.runner, root);
  assert.equal(await runWhere(d, '#150'), 1);
  assert.match(d.errs.join('\n'), /PR #150 is open, not merged/);
});
