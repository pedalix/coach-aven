// Fail loudly (OpenSpec `agent-messaging`, design D16): every event in the catalogue has a code path that
// emits it — a catalogued failure nobody emits would be a silent one. (That every emitted name is in
// the catalogue is the type checker's job: emit() takes an EventName.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EVENTS } from './events.js';

const ROOT = new URL('../../', import.meta.url).pathname;
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === 'node_modules' || f === 'fixtures' ? [] : sources(p);
    return /\.ts$/.test(f) && !/\.test\.ts$/.test(f) && !p.endsWith(join('messaging', 'events.ts')) ? [p] : [];
  });
}

test('every event of the D16 catalogue is emitted by some code path (bot or hub)', () => {
  const code = [...sources(join(ROOT, 'src')), ...sources(join(ROOT, 'hub', 'src'))].map((p) => readFileSync(p, 'utf8')).join('\n');
  const silent = Object.keys(EVENTS).filter((name) => !code.includes(`'${name}'`));
  assert.deepEqual(silent, [], `catalogued but never emitted: ${silent.join(', ')}`);
});
