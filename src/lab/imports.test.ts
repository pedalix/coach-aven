// The lab boundary as a rule: the bench calls a model on the host (src/lab/llm.ts) — fine for a dev
// experiment, never for production, where the model runs only inside the sandbox. So nothing outside
// src/lab/ may import from it; a variant that wins on the bench reaches production by being ported
// into the deterministic layer or the sandbox routine, not by importing the bench.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = new URL('../', import.meta.url).pathname;

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'fixtures' ? [] : tsFiles(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

test('nothing outside src/lab/ imports the lab', () => {
  const offenders = tsFiles(SRC)
    .map((p) => relative(SRC, p))
    .filter((rel) => !rel.startsWith('lab/'))
    .filter((rel) => /from ['"][./]*(?:\.\.\/)*lab\//.test(readFileSync(join(SRC, rel), 'utf8')));
  assert.deepEqual(offenders, []);
});

test('only src/lab/llm.ts spawns the claude CLI from the lab', () => {
  const offenders = tsFiles(join(SRC, 'lab'))
    .map((p) => relative(SRC, p))
    .filter((rel) => rel !== 'lab/llm.ts' && !rel.endsWith('.test.ts'))
    .filter((rel) => /spawn\(\s*['"]claude['"]/.test(readFileSync(join(SRC, rel), 'utf8')));
  assert.deepEqual(offenders, []);
});
