import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dueFromText, readDueNow } from './tenant.js';
import { openStore, rawRecordCount } from './store.js';

const line = (o: object) => JSON.stringify(o) + '\n';

test('dueFromText — last line per id wins; open escalations and open commitments due today or earlier count', () => {
  const esc =
    line({ id: 'e1', kind: 'attribution', status: 'open' }) +
    line({ id: 'e2', kind: 'identity_merge', status: 'open' }) +
    line({ id: 'e2', kind: 'identity_merge', status: 'answered' }) + // superseded: answered
    'not json\n' +
    line({ id: 'e3', status: 'dropped' });
  const com =
    line({ id: 'c1', status: 'proposed', due: '2026-10-14' }) + // due today
    line({ id: 'c2', status: 'confirmed', due: '2026-10-01T00:00:00Z' }) + // overdue, datetime form
    line({ id: 'c3', status: 'confirmed', due: '2026-10-16' }) + // not yet
    line({ id: 'c4', status: 'proposed', due: '2026-10-10' }) +
    line({ id: 'c4', status: 'done', due: '2026-10-10' }) + // closed later
    line({ id: 'c5', status: 'confirmed' }); // no due date
  assert.deepEqual(dueFromText(esc, com, '2026-10-14'), { escalationsOpen: 1, commitmentsDue: 2 });
  assert.deepEqual(dueFromText('', '', '2026-10-14'), { escalationsOpen: 0, commitmentsDue: 0 });
});

test('readDueNow — missing checkout is undefined (fire), missing files are empty (skippable), AVEN_DATA_DIR respected', () => {
  const root = mkdtempSync(join(tmpdir(), 'due-'));
  const prev = process.env.AVEN_DATA_DIR;
  process.env.AVEN_DATA_DIR = root;
  try {
    const t = { repo: 'x/y' };
    assert.equal(readDueNow('t', t, '2026-10-14'), undefined, 'no checkout yet');
    mkdirSync(join(root, 't', 'tenant', '.git'), { recursive: true });
    assert.deepEqual(readDueNow('t', t, '2026-10-14'), { escalationsOpen: 0, commitmentsDue: 0 }, 'checkout without ledgers');
    mkdirSync(join(root, 't', 'tenant', 'annotations'), { recursive: true });
    mkdirSync(join(root, 't', 'tenant', 'ledger'), { recursive: true });
    writeFileSync(join(root, 't', 'tenant', 'annotations', 'escalations.jsonl'), line({ id: 'e1', status: 'open' }));
    writeFileSync(join(root, 't', 'tenant', 'ledger', 'commitments.jsonl'), line({ id: 'c1', status: 'confirmed', due: '2026-10-13' }));
    assert.deepEqual(readDueNow('t', t, '2026-10-14'), { escalationsOpen: 1, commitmentsDue: 1 });
    assert.deepEqual(readDueNow('t', { repo: 'x/y', path: 'elsewhere' }, '2026-10-14'), { escalationsOpen: 0, commitmentsDue: 1 }, 'annotations path from the tenant config');
  } finally {
    if (prev === undefined) delete process.env.AVEN_DATA_DIR;
    else process.env.AVEN_DATA_DIR = prev;
  }
});

test('rawRecordCount — rows of raw_records; missing or non-store file is undefined', () => {
  const dir = mkdtempSync(join(tmpdir(), 'raw-'));
  const path = join(dir, 'store.sqlite');
  assert.equal(rawRecordCount(path), undefined);
  const db = openStore(path);
  db.prepare("INSERT INTO raw_records(source, account, id, line_hash, body, ingested_at) VALUES ('slack', 'T1', 'a', 'h1', '{}', '2026-10-14T00:00:00Z')").run();
  db.prepare("INSERT INTO raw_records(source, account, id, line_hash, body, ingested_at) VALUES ('slack', 'T1', 'b', 'h2', '{}', '2026-10-14T00:00:00Z')").run();
  db.close();
  assert.equal(rawRecordCount(path), 2);
  writeFileSync(join(dir, 'junk.sqlite'), 'not a database');
  assert.equal(rawRecordCount(join(dir, 'junk.sqlite')), undefined);
});
