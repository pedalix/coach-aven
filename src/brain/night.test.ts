// One project's night (OpenSpec company-brain, design D9): what starts a tidy, what it leaves behind, and when it
// stops — over the real mirror, index and lint in a temp installation directory, with a fake sandbox and engine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryRepoDir, mirrorMemory, type MirrorExec } from '../memjournal.js';
import { brainAfterTurn, brainProjectDir, readLint, readTidy, readUses } from './store.js';
import { nightlyTidy, type NightDeps } from './night.js';

const DIR = mkdtempSync(join(tmpdir(), 'aven-night-'));
const prev = process.env.AVEN_DIR;
before(() => void (process.env.AVEN_DIR = DIR));
after(() => {
  if (prev === undefined) delete process.env.AVEN_DIR;
  else process.env.AVEN_DIR = prev;
  rmSync(DIR, { recursive: true, force: true });
});

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
// A sandbox as the mirror sees it: memory files, and one repository's CLAUDE.md.
function sandbox(slug: string, files: Record<string, string>, box: { claudeMd?: string } = {}) {
  const exec: MirrorExec = async (command) => {
    if (command.includes('base64 -w0')) {
      const names = [.../'([^']+)'/g[Symbol.matchAll](/for f in (.*?); do/.exec(command)![1])].map((m) => m[1]);
      return { exitCode: 0, result: names.filter((n) => n in files).map((n) => `${n} ${Buffer.from(files[n]).toString('base64')}\n`).join('') };
    }
    const listing = Object.entries(files).map(([n, c]) => `${sha(c)}  ${n}`);
    if (box.claudeMd !== undefined) listing.push(`instructions ${sha(box.claudeMd)}  /work/shop/CLAUDE.md`);
    return { exitCode: 0, result: listing.join('\n') };
  };
  return {
    mirrorMemory: (message: string) => mirrorMemory(exec, memoryRepoDir(slug), '/mem', message, { 'shop/CLAUDE.md': '/work/shop/CLAUDE.md' }),
    memoryReads: () => Object.keys(files),
  };
}
const turn = { turnId: 't1', key: 'thread:1', by: 'person' as const, question: 'q', answer: 'a', logAnswer: true };

// The engine: `model` is what the tidy turn does to the files.
function deps(slug: string, files: Record<string, string>, box: { claudeMd?: string }, model: (prompt: string) => void, busy = false) {
  const prompts: string[] = [];
  const order: string[] = [];
  const d: NightDeps = {
    projectBusy: () => busy,
    fresh: async () => void order.push('fresh'),
    runAsk: async (_key, prompt, afterAsk) => {
      order.push('ask');
      prompts.push(prompt);
      model(prompt);
      await afterAsk(sandbox(slug, files, box));
      return 'Typed one record.';
    },
    key: `cron:tidy:${slug}`,
    memoryDir: '/mem',
    tidying: new Set(),
  };
  return { d, prompts, order };
}

test('a project that never wrote a record: nothing starts and no brain directory appears', async () => {
  const { d, prompts } = deps('empty', {}, {}, () => {});
  assert.equal(await nightlyTidy(d, 'empty', '05-10'), 'no-brain');
  assert.equal(existsSync(brainProjectDir('empty')), false);
  assert.deepEqual(prompts, []);
});

test('an empty lint starts no turn; findings start one, once a night, and the resolved finding is gone', async () => {
  const typed = '---\nname: Lift passes\nkind: domain\n---\nPriced per day.\n';
  const files: Record<string, string> = { 'MEMORY.md': '- [Lifts](lifts.md)\n', 'lifts.md': typed };
  await brainAfterTurn(sandbox('shop', files), 'shop', turn);
  const quiet = deps('shop', files, {}, () => {});
  assert.equal(await nightlyTidy(quiet.d, 'shop', '05-10'), 'nothing-due');
  assert.deepEqual(quiet.prompts, [], 'no turn, so a stopped sandbox stays stopped');
  assert.equal(await nightlyTidy(quiet.d, 'shop', '05-10'), 'done-today');

  files['refunds.md'] = '---\nname: Refunds\n---\nWithin 21 days.\n'; // a later turn writes an untyped, unlinked record
  await brainAfterTurn(sandbox('shop', files), 'shop', { ...turn, turnId: 't2' });
  const night = deps('shop', files, {}, () => {
    files['refunds.md'] = '---\nname: Refunds\nkind: domain\n---\nWithin 21 days.\n';
    files['MEMORY.md'] = '- [Lifts](lifts.md)\n- [Refunds](refunds.md)\n';
  });
  assert.equal(await nightlyTidy(night.d, 'shop', '05-11'), 'tidied');
  assert.equal(night.prompts.length, 1);
  assert.deepEqual(night.order, ['fresh', 'ask'], 'each night starts a fresh session, never resumes last night\'s');
  assert.match(night.prompts[0], /\[no-kind\] refunds\.md/);
  assert.match(night.prompts[0], /\[not-linked\] refunds\.md/);
  assert.deepEqual(await readLint('shop'), [], 'the mirror ran after the tidy');
  assert.deepEqual((await readTidy('shop')).given, {});
  assert.equal((await readUses('shop')).at(-1)?.by, 'routine', 'the tidy is a routine\'s turn in the use log');
  assert.equal(await nightlyTidy(night.d, 'shop', '05-11'), 'done-today');
});

test('a finding the tidy cannot resolve buys three turns, not one every night', async () => {
  const files: Record<string, string> = { 'MEMORY.md': '- [Desk](desk.md)\n', 'desk.md': '---\nname: Desk\nkind: domain\n---\nWrite to desk@skishop.example.\n' };
  await brainAfterTurn(sandbox('desk', files), 'desk', turn);
  const { d, prompts } = deps('desk', files, {}, () => {}); // the model leaves the address in
  for (const day of ['05-10', '05-11', '05-12']) assert.equal(await nightlyTidy(d, 'desk', day), 'tidied');
  assert.equal(await nightlyTidy(d, 'desk', '05-13'), 'nothing-due');
  assert.equal(prompts.length, 3);
  assert.equal((await readLint('desk'))?.[0]?.code, 'personal-data', 'still listed for people');
});

test('a project with a live turn is left for the next tick; a failed tidy is not retried that night', async () => {
  const files: Record<string, string> = { 'MEMORY.md': '- [A](a.md)\n', 'a.md': 'No frontmatter.\n' };
  await brainAfterTurn(sandbox('busy', files), 'busy', turn);
  const busy = deps('busy', files, {}, () => {}, true);
  assert.equal(await nightlyTidy(busy.d, 'busy', '05-10'), 'busy');
  assert.equal((await readTidy('busy')).lastDay, undefined);
  const failing = deps('busy', files, {}, () => {
    throw new Error('rate limited');
  });
  assert.equal(await nightlyTidy(failing.d, 'busy', '05-10'), 'failed');
  assert.equal(await nightlyTidy(failing.d, 'busy', '05-10'), 'done-today');
  assert.deepEqual((await readTidy('busy')).given, {}, 'a failure does not count towards the three runs');
});

test('a changed CLAUDE.md alone starts a tidy, which clears the finding; the first digest starts nothing', async () => {
  const files: Record<string, string> = { 'MEMORY.md': '- [Lifts](lifts.md)\n', 'lifts.md': '---\nname: Lift passes\nkind: domain\n---\nPriced per day.\n' };
  const box = { claudeMd: 'Deploy with make ship.\n' };
  await brainAfterTurn(sandbox('rules', files, box), 'rules', turn);
  const { d, prompts } = deps('rules', files, box, () => {});
  assert.equal(await nightlyTidy(d, 'rules', '05-10'), 'nothing-due', 'the first digest is the baseline');

  box.claudeMd = 'Deploy with npm run ship.\n';
  await brainAfterTurn(sandbox('rules', files, box), 'rules', { ...turn, turnId: 't2' });
  assert.equal((await readLint('rules'))?.[0]?.code, 'instructions-changed');
  assert.equal(await nightlyTidy(d, 'rules', '05-11'), 'tidied');
  assert.match(prompts[0], /\[instructions-changed\] shop\/CLAUDE\.md: changed since the last tidy/);
  assert.deepEqual(await readLint('rules'), []);
  assert.equal(await nightlyTidy(d, 'rules', '05-12'), 'nothing-due');
});
