import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttp } from '../trackers/http.js';
import { CURSOR_OVERLAP_MS, readCursor, scopeDir } from '../trackers/writer.js';
import { buildStore, openReadOnly } from '../store.js';
import { runSearch, runStuck, runTasks } from '../../../snapshot/plain/sources-mcp.mjs';
import { fetchWrikeFolder, newWrikeCache, pullWrike, pullWrikeWith, wrikeSince, WRIKE_TOKEN_ENV } from './pull.js';

// The puller against a fake Wrike: the real HTTP client with a fetch that answers by URL, so paging,
// the per-folder cursor, 429 and a dead token are exercised through the same code the bot runs.
// Ids and people are invented; shapes follow Wrike's v4 answers.

const HOST = 'www.wrike.com';
const CLIENT = 'IEAAB2CDI4CLNT01'; // configured: a client folder with one subfolder
const SITE = 'IEAAB2CDI4SITE01';
const OTHER = 'IEAAB2CDI4CLNT02'; // configured: a second client
const ROOT = 'IEAAB2CDI7777777'; // the account root a subtask's parentIds point at
const MIRA = 'KUAB2C01';
const JONAH = 'KUAB2C02';
const GONE = 'KUAB2C03';
const STATUS = { new: 'IEAAB2CDJMAAAAA1', doing: 'IEAAB2CDJMAAAAA2', waiting: 'IEAAB2CDJMAAAAA4', live: 'IEAAB2CDJMAAAAA5' };

const wtask = (id: string, title: string, o: Record<string, unknown>) => ({
  id,
  accountId: 'IEAAB2CD',
  title,
  description: `<p>${title}.</p>`,
  parentIds: [CLIENT],
  superParentIds: [],
  responsibleIds: [MIRA],
  authorIds: [JONAH],
  status: 'Active',
  importance: 'Normal',
  createdDate: '2026-09-01T08:00:00Z',
  scope: 'WsTask',
  customStatusId: STATUS.new,
  permalink: `https://www.wrike.com/open.htm?id=11002200${id.slice(-2)}`,
  ...o,
});
const T1 = wtask('IEAAB2CDKQTASK01', 'Opening hours page shows the winter times', { parentIds: [SITE], customStatusId: STATUS.doing, updatedDate: '2026-10-12T09:30:00Z' });
const T2 = wtask('IEAAB2CDKQTASK02', 'Swap the hero image', { parentIds: [ROOT], superParentIds: [SITE], updatedDate: '2026-10-01T10:00:00Z' });
const T3 = wtask('IEAAB2CDKQTASK03', 'Menu PDF for the autumn season', { customStatusId: STATUS.waiting, status: 'Deferred', authorIds: [GONE], updatedDate: '2026-09-20T07:00:00Z' });
const T4 = wtask('IEAAB2CDKQTASK04', 'Domain transfer', { parentIds: [OTHER], customStatusId: STATUS.live, status: 'Completed', updatedDate: '2026-10-02T12:00:00Z' });

const ok = (data: unknown, extra: Record<string, unknown> = {}) => new Response(JSON.stringify({ kind: 'x', ...extra, data }), { status: 200 });

interface Fake {
  urls: string[];
  fetchImpl: typeof fetch;
}

/** `pages` per folder; `script` answers chosen requests out of turn (429, 401) — first match wins, once each unless sticky. */
function fakeWrike(pages: Record<string, unknown[][]>, script: { match: RegExp; res: () => Response; sticky?: boolean }[] = []): Fake {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    const i = script.findIndex((s) => s.match.test(url));
    if (i >= 0) {
      const s = script[i]!;
      if (!s.sticky) script.splice(i, 1);
      return s.res();
    }
    const u = new URL(url);
    const p = u.pathname.replace(/^\/api\/v4/, '');
    if (p === '/workflows') {
      return ok([{ id: 'IEAAB2CDK77WF001', name: 'Client delivery', customStatuses: [
        { id: STATUS.new, name: 'New', group: 'Active' },
        { id: STATUS.doing, name: 'In Progress', group: 'Active' },
        { id: STATUS.waiting, name: 'Waiting for client', group: 'Deferred' },
        { id: STATUS.live, name: 'Live', group: 'Completed' },
      ] }]);
    }
    let m = /^\/folders\/([A-Z0-9]+)\/folders$/.exec(p);
    if (m) return ok(m[1] === CLIENT ? [{ id: CLIENT, title: 'Harbor Bakery', childIds: [SITE] }, { id: SITE, title: 'Website relaunch', childIds: [] }] : [{ id: m[1], title: 'Northwind Florist', childIds: [] }]);
    m = /^\/folders\/([A-Z0-9]+)\/tasks$/.exec(p);
    if (m) {
      const list = pages[m[1]!] ?? [[]];
      const n = Number((u.searchParams.get('nextPageToken') ?? 'page-0').slice(5));
      return ok(list[n] ?? [], n + 1 < list.length ? { nextPageToken: `page-${n + 1}`, responseSize: list.flat().length } : {});
    }
    m = /^\/tasks\/([A-Z0-9]+)\/comments$/.exec(p);
    if (m) {
      return ok(m[1] === T1.id ? [{ id: 'IEAAB2CDIMCMNT01', authorId: JONAH, text: '@Mira Talbot the winter hours are still up', createdDate: '2026-10-11T15:00:00Z', updatedDate: '2026-10-11T15:00:00Z', taskId: T1.id }] : []);
    }
    m = /^\/contacts\/([A-Z0-9,]+)$/.exec(p);
    if (m) {
      const known: Record<string, unknown> = {
        [MIRA]: { id: MIRA, firstName: 'Mira', lastName: 'Talbot', type: 'Person', primaryEmail: 'mira.talbot@studio.example', profiles: [{ email: 'mira.talbot@studio.example' }] },
        [JONAH]: { id: JONAH, firstName: 'Jonah', lastName: 'Pell', type: 'Person', profiles: [{ email: 'jonah@harbor-bakery.example', external: true }] },
        [GONE]: { id: GONE, firstName: 'Former', lastName: 'Member', type: 'Person', profiles: [], deleted: true },
      };
      return ok(m[1]!.split(',').map((id) => known[id]).filter(Boolean));
    }
    return new Response('{"error":"resource_not_found"}', { status: 404 });
  }) as unknown as typeof fetch;
  return { urls, fetchImpl };
}

const httpOf = (f: Fake, slept: number[] = []) => createHttp({ headers: {}, fetchImpl: f.fetchImpl, sleep: async (ms) => void slept.push(ms) });

test('fetchWrikeFolder: pages by nextPageToken, subtree + subtasks asked, stamps without ms, comments per task, contacts batched and cached', async () => {
  const f = fakeWrike({ [CLIENT]: [[T1, T2], [T3]] });
  const got = [];
  const cache = newWrikeCache();
  for await (const t of fetchWrikeFolder(httpOf(f), HOST, cache, CLIENT, new Date('2026-09-15T00:00:00.000Z'), () => undefined)) got.push(t);
  assert.deepEqual(
    got.map((t) => [t.id, t.project, t.status, t.statusCategory, t.assignee, t.reporter, t.comments.length]),
    [
      [T1.id, 'Website relaunch', 'In Progress', 'doing', 'Mira Talbot <mira.talbot@studio.example>', 'Jonah Pell <jonah@harbor-bakery.example>', 1],
      [T2.id, 'Website relaunch', 'New', 'todo', 'Mira Talbot <mira.talbot@studio.example>', 'Jonah Pell <jonah@harbor-bakery.example>', 0],
      [T3.id, 'Harbor Bakery', 'Waiting for client', 'todo', 'Mira Talbot <mira.talbot@studio.example>', 'Former Member', 0],
    ],
  );
  const lists = f.urls.filter((u) => u.includes(`/folders/${CLIENT}/tasks`)).map((u) => new URL(u));
  assert.equal(lists.length, 2, 'two pages');
  const first = lists[0]!.searchParams;
  assert.equal(first.get('updatedDate'), '{"start":"2026-09-15T00:00:00Z"}');
  assert.equal(first.get('descendants'), 'true');
  assert.equal(first.get('subTasks'), 'true');
  assert.equal(first.get('pageSize'), '1000');
  assert.deepEqual(JSON.parse(first.get('fields')!), ['description', 'responsibleIds', 'authorIds', 'parentIds', 'superParentIds']);
  assert.equal(lists[1]!.searchParams.get('nextPageToken'), 'page-1');
  assert.equal(f.urls.filter((u) => /\/comments\?plainText=true$/.test(u)).length, 3, 'one comments call per task');
  const contactCalls = f.urls.filter((u) => u.includes('/contacts/')).map((u) => new URL(u).pathname.split('/').pop());
  assert.deepEqual(contactCalls, [`${MIRA},${JONAH}`, GONE], 'page 2 asks only for the contact page 1 did not resolve');
  assert.equal(f.urls.filter((u) => u.endsWith('/workflows')).length, 1);
  // A second folder in the same pass reuses workflows and contacts.
  for await (const _ of fetchWrikeFolder(httpOf(f), HOST, cache, CLIENT, new Date('2026-09-15T00:00:00.000Z'), () => undefined)) void _;
  assert.equal(f.urls.filter((u) => u.endsWith('/workflows')).length, 1, 'workflows once per pass');
  assert.equal(f.urls.filter((u) => u.includes('/contacts/')).length, 2, 'no contact asked twice');
});

test('pullWrikeWith: one cursor per folder; the next pass starts at that folder\'s max updated − overlap; a folder added later starts at since', async () => {
  const out = mkdtempSync(join(tmpdir(), 'wrike-'));
  const ctx = { slug: 'studio-ops', outDir: out, tokenPath: '/nope', log: () => undefined };
  const f = fakeWrike({ [CLIENT]: [[T1, T2], [T3]], [OTHER]: [[T4]] });
  const now = () => new Date('2026-10-13T00:00:00.000Z');
  const s1 = await pullWrikeWith(ctx, { folders: [CLIENT], since: '2026-09-01' }, httpOf(f), { now });
  assert.equal(s1.ok, true);
  assert.deepEqual(s1.counts, { [`${HOST}/${CLIENT}/tasks`]: 3 });
  const dir = scopeDir(out, 'wrike', HOST, CLIENT);
  assert.equal(readFileSync(join(dir, 'tasks.jsonl'), 'utf8').trim().split('\n').length, 3);
  assert.equal(readCursor(dir).updated, '2026-10-12T09:30:00.000Z');

  f.urls.length = 0;
  const s2 = await pullWrikeWith(ctx, { folders: [CLIENT, OTHER], since: '2026-09-01' }, httpOf(f), { now });
  assert.equal(s2.ok, true);
  const starts = Object.fromEntries(
    f.urls.filter((u) => /\/tasks\?/.test(u) && !u.includes('nextPageToken')).map((u) => [new URL(u).pathname.split('/')[4], JSON.parse(new URL(u).searchParams.get('updatedDate')!).start]),
  );
  assert.deepEqual(starts, {
    [CLIENT]: new Date(Date.parse('2026-10-12T09:30:00Z') - CURSOR_OVERLAP_MS).toISOString().replace('.000Z', 'Z'),
    [OTHER]: '2026-09-01T00:00:00Z',
  });
  assert.deepEqual(s2.counts, { [`${HOST}/${CLIENT}/tasks`]: 0, [`${HOST}/${OTHER}/tasks`]: 1 }, 'unchanged rows are not re-appended (the fake ignores the window)');
});

test('pullWrikeWith: a 429 waits for Retry-After and the pass still succeeds', async () => {
  const out = mkdtempSync(join(tmpdir(), 'wrike-'));
  const f = fakeWrike({ [CLIENT]: [[T1]] }, [{ match: /\/folders\/[A-Z0-9]+\/tasks\?/, res: () => new Response('{"error":"rate_limit_exceeded"}', { status: 429, headers: { 'retry-after': '7' } }) }]);
  const slept: number[] = [];
  const s = await pullWrikeWith({ slug: 's', outDir: out, tokenPath: '/nope', log: () => undefined }, { folders: [CLIENT], since: '2026-09-01' }, httpOf(f, slept));
  assert.equal(s.ok, true);
  assert.deepEqual(slept, [7000]);
  assert.equal(s.counts[`${HOST}/${CLIENT}/tasks`], 1);
});

test('pullWrikeWith: a dead token is reauth, every folder reports it, no cursor moves; a bad folder fails alone', async () => {
  const out = mkdtempSync(join(tmpdir(), 'wrike-'));
  const ctx = { slug: 's', outDir: out, tokenPath: '/nope', log: () => undefined };
  const dead = fakeWrike({}, [{ match: /./, res: () => new Response('{"errorDescription":"Access token is unknown or invalid","error":"not_authorized"}', { status: 401 }), sticky: true }]);
  const s = await pullWrikeWith(ctx, { folders: [CLIENT, OTHER] }, httpOf(dead));
  assert.equal(s.ok, false);
  assert.equal(s.reauth, true);
  assert.equal(s.errors.length, 2);
  assert.match(s.errors[0]!, new RegExp(`^${HOST}/${CLIENT}: HTTP 401`));
  assert.equal(existsSync(join(scopeDir(out, 'wrike', HOST, CLIENT), 'cursor.json')), false);
  // One folder id the account does not know: that folder fails (400, not reauth), the other lands.
  const one = fakeWrike({ [OTHER]: [[T4]] }, [{ match: new RegExp(`/folders/${CLIENT}/folders`), res: () => new Response('{"errorDescription":"Invalid Folder ID","error":"invalid_request"}', { status: 400 }) }]);
  const s2 = await pullWrikeWith(ctx, { folders: [CLIENT, OTHER] }, httpOf(one));
  assert.deepEqual([s2.ok, s2.reauth, s2.errors.length, s2.counts[`${HOST}/${OTHER}/tasks`]], [false, false, 1, 1]);
});

test('pullWrike without the token in the environment: reauth, nothing requested', async () => {
  delete process.env.WRIKE_TEST_TOKEN_UNSET;
  const s = await pullWrike({ slug: 's', outDir: mkdtempSync(join(tmpdir(), 'wrike-')), tokenPath: '/nope', log: () => undefined }, { folders: [CLIENT], tokenEnv: 'WRIKE_TEST_TOKEN_UNSET' });
  assert.deepEqual([s.ok, s.reauth], [false, true]);
  assert.match(s.errors[0]!, /env var WRIKE_TEST_TOKEN_UNSET is empty/);
  assert.equal(WRIKE_TOKEN_ENV, 'WRIKE_API_TOKEN', 'the default variable');
});

test('wrikeSince: --since, else the config, else 30 days back', () => {
  const now = new Date('2026-10-30T12:00:00.000Z');
  assert.equal(wrikeSince({ folders: [CLIENT] }, {}, now), '2026-09-30');
  assert.equal(wrikeSince({ folders: [CLIENT], since: '2026-08-01' }, {}, now), '2026-08-01');
  assert.equal(wrikeSince({ folders: [CLIENT], since: '2026-08-01' }, { since: '2026-01-01' }, now), '2026-01-01');
});

test('Wrike tasks reach the store and the readouts like any tracker: stuck, tasks, search by source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wrike-store-'));
  const raw = join(root, 'raw');
  const f = fakeWrike({ [CLIENT]: [[T1, T2], [T3]], [OTHER]: [[T4]] });
  const s = await pullWrikeWith({ slug: 's', outDir: raw, tokenPath: '/nope', log: () => undefined }, { folders: [CLIENT, OTHER], since: '2026-09-01' }, httpOf(f));
  assert.equal(s.ok, true);
  const people = join(root, 'people.json');
  writeFileSync(people, JSON.stringify([{ person_id: 'mira', name: 'Mira Talbot', company: 'studio', identities: ['mira.talbot@studio.example'] }]));
  const b = buildStore({ slug: 's', rawDir: raw, storePath: join(root, 'store.sqlite'), replicaDir: join(root, 'replica'), peoplePath: people, log: () => undefined });
  assert.equal(b.tasks, 4, 'the per-folder raw files are found under wrike/<host>/<folder>/');
  const db = openReadOnly(join(root, 'replica', 'store.sqlite'));
  try {
    const NOW = new Date('2026-10-13T00:00:00.000Z');
    type Group = { project: string; status: string; tasks: { key: string; source: string; assignee: string; daysSinceUpdate: number }[] };
    const stuck = runStuck(db, { source: 'wrike' }, NOW);
    assert.deepEqual(
      (stuck.groups as Group[]).map((g) => [g.project, g.status, g.tasks.map((t) => [t.source, t.assignee, t.daysSinceUpdate])]),
      [
        ['Harbor Bakery', 'Waiting for client', [['wrike', 'mira', 22]]],
        ['Website relaunch', 'New', [['wrike', 'mira', 11]]],
      ],
      'T1 moved yesterday, T4 is Live (done); the assignee joins the people file through the address in Name <email>',
    );
    type Row = { ref: string; title: string; assignee: string; lastComment?: { by: string } };
    const open = runTasks(db, { source: 'wrike' }).tasks as Row[];
    assert.deepEqual(open.map((t) => t.title).sort(), ['Menu PDF for the autumn season', 'Opening hours page shows the winter times', 'Swap the hero image']);
    assert.equal(open.find((t) => t.ref === `wrike:${HOST}:${T1.id}`)?.lastComment?.by, 'Jonah Pell <jonah@harbor-bakery.example>');
    assert.equal((runTasks(db, { assignee: 'Talbot', status: 'any' }).tasks as Row[]).length, 4, 'by person');
    assert.equal((runTasks(db, { assignee: 'harbor-bakery', status: 'any' }).tasks as Row[]).length, 0, 'Jonah reports, he is assigned nothing');
    const hits = runSearch(db, { query: 'winter', source: 'wrike' }).hits as { ref: string; kind: string }[];
    assert.deepEqual(hits.map((h) => [h.ref, h.kind]), [[`wrike:${HOST}:${T1.id}`, 'task']]);
  } finally {
    db.close();
  }
});
