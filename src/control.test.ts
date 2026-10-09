import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consumeRunRequests, parseRequestName, requestPath, waitConsumed, writeRunRequest } from './control.js';

test('request file contract: name, atomic body, invalid ids rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctl-'));
  const p = writeRunRequest(dir, 'r3', 'cli', new Date('2026-10-09T10:00:00Z'));
  assert.equal(p, join(dir, 'run-r3.json'));
  assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { id: 'r3', requestedAt: '2026-10-09T10:00:00.000Z', by: 'cli' });
  assert.deepEqual(readdirSync(dir), ['run-r3.json'], 'no tmp file left behind');
  assert.equal(parseRequestName('run-r3.json'), 'r3');
  assert.equal(parseRequestName('run-r3.json.tmp'), undefined);
  assert.equal(parseRequestName('run-r3.json.taken'), undefined);
  assert.throws(() => requestPath(dir, '../etc'), /invalid routine id/);
});

test('consume: each request fires once, files are removed, junk is ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctl-'));
  writeRunRequest(dir, 'r1');
  writeRunRequest(dir, 'r2');
  writeFileSync(join(dir, 'notes.txt'), 'x');
  const fired: string[] = [];
  assert.deepEqual(consumeRunRequests(dir, (id) => fired.push(id)), ['r1', 'r2']);
  assert.deepEqual(fired, ['r1', 'r2']);
  assert.deepEqual(consumeRunRequests(dir, (id) => fired.push(id)), [], 'second pass finds nothing');
  assert.deepEqual(readdirSync(dir), ['notes.txt']);
  assert.deepEqual(consumeRunRequests(join(dir, 'missing'), () => undefined), []);
});

test('consume: a throwing handler still removes the request (no retry loop)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctl-'));
  writeRunRequest(dir, 'bad');
  assert.throws(() => consumeRunRequests(dir, () => { throw new Error('boom'); }), /boom/);
  assert.equal(existsSync(join(dir, 'run-bad.json')), false);
  assert.equal(existsSync(join(dir, 'run-bad.json.taken')), false);
});

test('waitConsumed: true once the bot removed the file, false on timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctl-'));
  const p = writeRunRequest(dir, 'r1');
  setTimeout(() => consumeRunRequests(dir, () => undefined), 50);
  assert.equal(await waitConsumed(p, 2000, 20), true);
  const q = writeRunRequest(dir, 'r2');
  assert.equal(await waitConsumed(q, 100, 20), false);
});
