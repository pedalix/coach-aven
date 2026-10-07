// A full Gmail sync that dies (quota, crash, restart) must not start over: the raw file is the
// checkpoint and the next pass fetches only what is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gmailIdsInRaw, idsToFetch } from './pull.js';

test('resume: ids already in raw are skipped; tombstoned, foreign-account and torn lines are not "had"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gmail-resume-'));
  const raw = join(dir, 'messages.jsonl');
  const acct = 'me@x.com';
  writeFileSync(raw, [
    JSON.stringify({ source: 'gmail', account: acct, id: 'a', text: '…' }),
    JSON.stringify({ source: 'gmail', account: acct, id: 'b', text: '…' }),
    JSON.stringify({ source: 'gmail', account: acct, id: 'b', deleted: true }),
    JSON.stringify({ source: 'gmail', account: 'other@x.com', id: 'c', text: '…' }),
    '{"source":"gmail","account":"me@x.com","id":"d","te', // torn by a crash mid-write
  ].join('\n'));
  const have = gmailIdsInRaw(raw, acct);
  assert.deepEqual([...have].sort(), ['a']);
  assert.deepEqual(idsToFetch(['a', 'b', 'c', 'd', 'e'], have, false), ['b', 'c', 'd', 'e']);
  assert.deepEqual(idsToFetch(['a', 'b'], have, true), ['a', 'b'], '--full refetches everything');
  assert.equal(gmailIdsInRaw(join(dir, 'missing.jsonl'), acct).size, 0);
});
