// End to end for the tracker family on the read side: raw tasks.jsonl → store → replica →
// the sandbox MCP server's search / tasks / get / stats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStore, openReadOnly } from './store.js';
import { scrubTask, type TaskRecord } from './trackers/task.js';
import { runGet, runSearch, runStats, runTasks } from '../../snapshot/plain/sources-mcp.mjs';

const t0: TaskRecord = {
  source: 'youtrack', account: 'bluefin-example.youtrack.cloud', id: '2-1', key: 'CG-50', title: 'Payment webhook times out', status: 'In Progress',
  statusCategory: 'doing', assignee: 'youtrack:owen', reporter: 'florin@client.example', due: '2026-10-10', created: '2026-09-20T00:00:00.000Z',
  updated: '2026-10-05T08:30:00.000Z', project: 'CG', url: 'https://bluefin-example.youtrack.cloud/issue/CG-50', labels: [], text: 'Payora webhook latency on Hillrail.',
  comments: [{ id: 'c1', author: 'owen@home.example', ts: '2026-10-01T00:00:00.000Z', text: 'Grafana shows p99 at 31s' }],
};

function replica(): string {
  const root = mkdtempSync(join(tmpdir(), 'tasks-'));
  const raw = join(root, 'raw');
  mkdirSync(join(raw, 'youtrack', 'bluefin-example.youtrack.cloud'), { recursive: true });
  mkdirSync(join(raw, 'jira', 'acme.atlassian.net'), { recursive: true });
  const people = join(root, 'people.json');
  writeFileSync(people, JSON.stringify([{ person_id: 'owen', name: 'Owen', identities: ['owen@home.example', 'youtrack:owen', 'owen.hale@partner.example'] }, { person_id: 'florin', name: 'Florin', identities: ['florin@client.example'] }]));
  const yt = join(raw, 'youtrack', 'bluefin-example.youtrack.cloud', 'tasks.jsonl');
  appendFileSync(yt, `${JSON.stringify(scrubTask(t0))}\n`);
  appendFileSync(yt, `${JSON.stringify(scrubTask({ ...t0, id: '2-2', key: 'CG-51', title: 'Old closed thing', status: 'Done', statusCategory: 'done', due: '' }))}\n`);
  // A later line for the same id wins (status changed, still open).
  appendFileSync(yt, `${JSON.stringify(scrubTask({ ...t0, status: 'Code Review', updated: '2026-10-06T08:30:00.000Z' }))}\n`);
  appendFileSync(
    join(raw, 'jira', 'acme.atlassian.net', 'tasks.jsonl'),
    `${JSON.stringify(scrubTask({ ...t0, source: 'jira', account: 'acme.atlassian.net', id: '100', key: 'P1-7', title: 'Rotate GastroDat keys', assignee: 'owen.hale@partner.example', reporter: 'jira:tobin', due: '2026-10-08', project: 'P1', url: 'https://acme.atlassian.net/browse/P1-7', text: 'creds: mysql://root:TopSecret1@db:3306/x', comments: [] }))}\n`,
  );
  const s = buildStore({ slug: 't', rawDir: raw, storePath: join(root, 'store.sqlite'), replicaDir: join(root, 'replica'), peoplePath: people, log: () => {} });
  assert.equal(s.tasks, 4);
  return join(root, 'replica', 'store.sqlite');
}

test('tasks land in the store, compacted, person-resolved, secrets gone', () => {
  const db = openReadOnly(replica());
  try {
    const rows = db.prepare('SELECT key, status, assignee_person, text FROM tasks ORDER BY key').all() as { key: string; status: string; assignee_person: string; text: string }[];
    assert.deepEqual(rows.map((r) => [r.key, r.status, r.assignee_person]), [['CG-50', 'Code Review', 'owen'], ['CG-51', 'Done', 'owen'], ['P1-7', 'In Progress', 'owen']]);
    assert.doesNotMatch(JSON.stringify(rows), /TopSecret1/);
  } finally {
    db.close();
  }
});

test('MCP: search finds tasks (incl. comments), tasks lists open work due-first, get returns the ticket', () => {
  const db = openReadOnly(replica());
  try {
    const s = runSearch(db, { query: 'p99' });
    assert.equal(s.hits[0]!.kind, 'task');
    assert.equal(s.hits[0]!.permalink, 'https://bluefin-example.youtrack.cloud/issue/CG-50');
    assert.equal(runSearch(db, { query: 'webhook', source: 'jira' }).hits.length, 0);
    const open = runTasks(db, { assignee: 'owen' });
    assert.deepEqual(open.tasks.map((t) => t.key), ['P1-7', 'CG-50']);
    assert.deepEqual(runTasks(db, { status: 'done' }).tasks.map((t) => t.key), ['CG-51']);
    assert.deepEqual(runTasks(db, { dueBefore: '2026-10-09' }).tasks.map((t) => t.key), ['P1-7']);
    assert.deepEqual(runTasks(db, { project: 'CG' }).tasks.map((t) => t.key), ['CG-50']);
    const g = runGet(db, { ref: 'youtrack:bluefin-example.youtrack.cloud:2-1' });
    assert.equal(g.kind, 'task');
    assert.equal((g.comments as unknown[]).length, 1);
    const st = runStats(db) as { tasks: { source: string; n: number; open: number }[] };
    assert.deepEqual(st.tasks.map((x) => [x.source, x.n, x.open]), [['jira', 1, 1], ['youtrack', 2, 1]]);
  } finally {
    db.close();
  }
});
