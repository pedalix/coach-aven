// The probe's boundary as a rule (OpenSpec `cli-probe`): it is tooling. Nothing the bot runs imports it,
// and it reads or writes no installation's state or configuration — so its modules import none of the
// modules that hold them (a type-only import of the Config shape is fine: it loads nothing).

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

test('nothing outside src/cliprobe/ imports the probe', () => {
  const offenders = tsFiles(SRC)
    .map((p) => relative(SRC, p))
    .filter((rel) => !rel.startsWith('cliprobe/'))
    .filter((rel) => /from ['"][./]*(?:\.\.\/)*cliprobe\//.test(readFileSync(join(SRC, rel), 'utf8')));
  assert.deepEqual(offenders, []);
});

test('the probe imports no state, chat, sources or project-configuration module', () => {
  const FORBIDDEN = /^\.\.\/(state|turn|projects|queuejournal|drafts|metering|pollers|channels|registry)\.js$|^\.\.\/(chat|sources)\//;
  const offenders: string[] = [];
  for (const p of tsFiles(join(SRC, 'cliprobe')).filter((f) => !f.endsWith('.test.ts'))) {
    const text = readFileSync(p, 'utf8');
    for (const m of text.matchAll(/^import\s+(type\s+)?[^'"]*from\s+['"]([^'"]+)['"]/gm)) {
      const spec = m[2]!.replace(/^\.\.\/\.\.\//, '../');
      if (FORBIDDEN.test(spec)) offenders.push(`${relative(SRC, p)} → ${m[2]}`);
      if (!m[1] && /^\.\.\/config\.js$/.test(spec)) offenders.push(`${relative(SRC, p)} → ${m[2]} (value import)`);
    }
  }
  assert.deepEqual(offenders, []);
});
