import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_GOLD, goldRecall, parseGitleaks, scanJsonl, scanRecord, type GoldRow } from './audit.js';

test('scanRecord: finds a DSN nested inside arrays/objects, skips scrub meta and link fields', () => {
  const rec = {
    id: 'x',
    text: 'clean',
    blocks: [{ text: 'mysql://u:p4ssw0rd-long@h/db' }],
    permalink: 'https://u:ignored@example.com/',
    scrub: { findings: [{ kind: 'dsn' }] },
  };
  const hits = scanRecord(rec, 'f.jsonl', 3);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.kind, 'dsn');
  assert.equal(hits[0]!.field, 'blocks[0].text');
  assert.equal(hits[0]!.line, 3);
  assert.doesNotMatch(JSON.stringify(hits), /p4ssw0rd/);
});

test('scanJsonl: counts records and malformed lines, a scrubbed marker is not a hit', () => {
  const r = scanJsonl('f', '{"id":"1","text":"Password: [REDACTED:kv:abc123]"}\nbroken\n{"id":"2","text":"ok"}\n');
  assert.equal(r.records, 2);
  assert.equal(r.malformed, 1);
  assert.equal(r.hits.filter((h) => h.confidence === 'exact').length, 0);
});

test('goldRecall: the shipped gold set is fully caught and credits detector kinds', () => {
  const rows = readFileSync(DEFAULT_GOLD, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as GoldRow);
  const r = goldRecall(rows);
  assert.equal(r.missed.length, 0, `missed: ${JSON.stringify(r.missed)}`);
  assert.equal(r.caught, r.total);
  assert.ok(Object.keys(r.perKind).length >= 3);
});

test('goldRecall: a planted secret the detectors do not know is reported as missed, by hash only', () => {
  const r = goldRecall([{ id: 'g', text: 'the launch code is tangerine-giraffe-42 ok', secrets: ['tangerine-giraffe-42'] }]);
  assert.equal(r.missed.length, 1);
  assert.match(r.missed[0]!.hash6, /^[0-9a-f]{6}$/);
  assert.doesNotMatch(JSON.stringify(r), /tangerine/);
});

test('parseGitleaks: maps findings to hits without the secret value', () => {
  const hits = parseGitleaks(JSON.stringify([{ RuleID: 'aws-access-token', File: 'a.jsonl', StartLine: 7, Secret: 'AKIAIOSFODNN7EXAMPLE' }]));
  assert.deepEqual(hits.map((h) => [h.kind, h.file, h.line]), [['gitleaks:aws-access-token', 'a.jsonl', 7]]);
  assert.doesNotMatch(JSON.stringify(hits), /AKIA/);
});
