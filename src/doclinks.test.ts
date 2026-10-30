import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { brokenRefs, joinPath } from './doclinks.js';

const ROOT = new URL('..', import.meta.url).pathname;

test('joinPath — relative segments, and no climbing out of the repository', () => {
  assert.equal(joinPath('docs', '../src/a.ts'), 'src/a.ts');
  assert.equal(joinPath('', './README.md'), 'README.md');
  assert.equal(joinPath('docs', '../../x'), undefined);
});

test('brokenRefs — links resolve against the doc, paths against the root or the doc; code and placeholders are skipped', () => {
  const files = new Set(['docs/a.md', 'src/x.ts', 'hub/src/report.ts']);
  const exists = (p: string): boolean => files.has(p);
  const text = [
    '[ok](a.md#part) [gone](b.md) [web](https://example.com) [anchor](#top)',
    '`src/x.ts` `src/y.ts` `infra/<slug>/projects.config.json` `src/*.ts`',
    '`[inline](nowhere.md)`',
    '```\n[fenced](nowhere.md) `src/z.ts`\n```',
  ].join('\n');
  assert.deepEqual(brokenRefs('docs/a.md', text, exists), [
    { doc: 'docs/a.md', kind: 'link', target: 'b.md' },
    { doc: 'docs/a.md', kind: 'path', target: 'src/y.ts' },
    { doc: 'docs/a.md', kind: 'path', target: 'src/z.ts' },
  ]);
  assert.deepEqual(brokenRefs('hub/README.md', '`src/report.ts`', exists), [], "a package's README names its own files");
  assert.deepEqual(brokenRefs('docs/rollout.md', '`src/removed.ts` [gone](b.md)', exists, { history: true }), [
    { doc: 'docs/rollout.md', kind: 'link', target: 'b.md' },
  ]);
});

// The public docs: the root pages, docs/, and the READMEs of the packages and the deploy tooling.
// OpenSpec (plans, partly historical) and the CHANGELOG pointer are not docs a reader follows.
function publicDocs(): string[] {
  const out = ['README.md', 'CONTRIBUTING.md', 'CLAUDE.md', 'SECURITY.md', 'SUPPORT.md', 'CODE_OF_CONDUCT.md'].filter((f) => existsSync(ROOT + f));
  const walk = (dir: string): void => {
    for (const e of readdirSync(ROOT + dir)) {
      const rel = `${dir}/${e}`;
      if (e === 'node_modules' || e.startsWith('.')) continue;
      if (statSync(ROOT + rel).isDirectory()) walk(rel);
      else if (e.endsWith('.md')) out.push(rel);
    }
  };
  // infra/ holds the deploy tooling and, in an operator's checkout, private ops repos
  // (infra/<slug>/, gitignored): only the public parts are walked.
  if (existsSync(ROOT + 'infra/README.md')) out.push('infra/README.md');
  for (const d of ['docs', 'hub', 'snapshot', 'infra/deploy', 'infra/teams']) if (existsSync(ROOT + d)) walk(d);
  return out;
}

test('the public docs: every relative link and every repository path they name exists', () => {
  const broken = publicDocs().flatMap((doc) =>
    brokenRefs(doc, readFileSync(ROOT + doc, 'utf8'), (p) => existsSync(ROOT + p), { history: doc === 'docs/rollout.md' }),
  );
  assert.deepEqual(broken.map((b) => `${b.doc}: ${b.kind} ${b.target}`), []);
});
