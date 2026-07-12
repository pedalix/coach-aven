import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { envelopeMeta, EventLog } from './eventlog.js';

const CTX = { teamId: 'T0AAAAAAA', enterpriseId: undefined, isEnterpriseInstall: false };

test('envelopeMeta — event envelope: structural fields in, text NEVER out', () => {
  const meta = envelopeMeta(
    {
      event: {
        type: 'message',
        subtype: 'file_share',
        channel: 'C123',
        channel_type: 'channel',
        ts: '1.2',
        thread_ts: '1.0',
        user: 'U9',
        is_ext_shared_channel: true,
        text: 'SECRET CLIENT CONTENT', // must not survive
      },
    },
    CTX,
    new Date('2026-07-12T10:00:00Z'),
  );
  assert.equal(meta.kind, 'message');
  assert.equal(meta.subtype, 'file_share');
  assert.equal(meta.channel, 'C123');
  assert.equal(meta.threadTs, '1.0');
  assert.equal(meta.extShared, true);
  assert.equal(meta.team, 'T0AAAAAAA');
  assert.ok(!JSON.stringify(meta).includes('SECRET'));
});

test('envelopeMeta — command: verb only, arguments never', () => {
  const meta = envelopeMeta(
    { command: '/aven', text: 'reload SECRET ARGS', channel: { id: 'C1' } },
    CTX,
  );
  assert.equal(meta.kind, 'command');
  assert.equal(meta.subtype, '/aven');
  assert.equal(meta.channel, 'C1');
  assert.ok(!JSON.stringify(meta).includes('SECRET'));
});

test('envelopeMeta — block_actions: action_id family only, value never', () => {
  const meta = envelopeMeta(
    { type: 'block_actions', actions: [{ action_id: 'mem_open:x', value: 'SECRET' }], channel: { id: 'C2' } },
    CTX,
  );
  assert.equal(meta.kind, 'block_actions');
  assert.equal(meta.subtype, 'mem_open');
  assert.ok(!JSON.stringify(meta).includes('SECRET'));
});

test('envelopeMeta — garbage in, "unknown" out (middleware must never throw)', () => {
  assert.equal(envelopeMeta(null, {}).kind, 'unknown');
  assert.equal(envelopeMeta(42, {}).kind, 'unknown');
});

test('EventLog — appends JSONL into a per-day file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aven-events-'));
  const logf = new EventLog(dir);
  logf.append({ at: '2026-07-12T10:00:00.000Z', kind: 'message', team: 'T1' });
  logf.append({ at: '2026-07-12T11:00:00.000Z', kind: 'command', decision: 'gated' });
  const files = readdirSync(dir);
  assert.deepEqual(files, ['2026-07-12.jsonl']);
  const lines = readFileSync(join(dir, files[0]), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).decision, 'gated');
});
