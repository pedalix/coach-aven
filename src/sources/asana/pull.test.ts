import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttp } from '../trackers/http.js';
import { fetchAsana, resolveMe } from './pull.js';

// fetchAsana against a fake Asana: the real HTTP client with a fetch that answers by URL, so the
// scope rule (watched projects contribute only tasks assigned to me or following me) is tested
// where it is applied — before the per-task story fetch.

const ME = '1167899671459952';
const ROWAN = '7520977444547';
const task = (gid: string, name: string, assignee: string | null, followers: string[]) => ({
  gid,
  name,
  notes: '',
  completed: false,
  assignee: assignee ? { gid: assignee, name: assignee === ME ? 'Owen Hale' : 'Rowan Mills', ...(assignee === ME ? { email: 'owen@example.com' } : {}) } : null,
  created_by: { gid: ROWAN, name: 'Rowan Mills' },
  followers: followers.map((g) => ({ gid: g })),
  created_at: '2026-10-01T00:00:00.000Z',
  modified_at: '2026-10-12T14:55:16.012Z',
  memberships: [{ project: { name: 'CartGenie dev board' }, section: { name: 'In progress' } }],
  permalink_url: `https://app.asana.com/0/P1/${gid}`,
  tags: [],
});
const data = (d: unknown) => new Response(JSON.stringify({ data: d }), { status: 200 });

function fakeAsana() {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    const u = new URL(url);
    if (u.pathname.endsWith('/users/me')) return data({ gid: ME, email: 'owen@example.com' });
    if (u.pathname.endsWith('/tasks') && u.searchParams.get('assignee') === 'me') return data([task('A', 'AWS billing alerts', ME, [ME, ROWAN])]);
    if (u.pathname.endsWith('/tasks') && u.searchParams.get('project') === 'P1') {
      return data([
        task('A', 'AWS billing alerts', ME, [ME, ROWAN]), // mine — already seen through assignee=me
        task('B', 'Cloudvisor invoice', ROWAN, [ROWAN, ME]), // Rowan's task; a comment @mentioned me → follower
        task('C', 'Monto roadmap', ROWAN, [ROWAN]), // Rowan's, nothing to do with me
      ]);
    }
    const m = /\/tasks\/([A-Z])\/stories$/.exec(u.pathname);
    if (m) return data([{ gid: `s-${m[1]}`, type: 'comment', resource_subtype: 'comment_added', text: `comment on ${m[1]}`, created_at: '2026-10-12T14:51:00.000Z', created_by: { gid: ROWAN, name: 'Rowan Mills' } }]);
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return { http: createHttp({ headers: {}, fetchImpl }), urls };
}

test('fetchAsana: a watched project contributes only tasks assigned to me or following me, deduped, stories fetched per kept task only', async () => {
  const { http, urls } = fakeAsana();
  const lines: string[] = [];
  const got: string[] = [];
  for await (const t of fetchAsana(http, { workspace: 'W', projects: ['P1'] }, new Date('2026-10-12T00:00:00Z'), (l) => lines.push(l))) got.push(`${t.id}:${t.assignee}:${t.comments.length}`);
  assert.deepEqual(got, ['A:owen@example.com:1', 'B:asana:7520977444547:1']);
  assert.equal(urls.filter((u) => u.includes('/users/me')).length, 1, 'me resolved once per pull');
  assert.ok(!urls.some((u) => u.includes('/tasks/C/stories')), 'a task that is not mine costs no story fetch');
  assert.equal(urls.filter((u) => u.includes('/tasks/A/stories')).length, 1, 'the duplicate from the project query is not fetched twice');
  const project = urls.find((u) => u.includes('project=P1'));
  assert.ok(project && project.includes('modified_since=2026-10-12T00%3A00%3A00.000Z') && project.includes('followers.email'), project);
  assert.ok(lines.some((l) => /project=P1: 1 tasks \(1 neither assigned to nor followed by me, skipped\)/.test(l)), lines.join('\n'));
});

test('fetchAsana without projects is unchanged: the assignee query only, no /users/me request', async () => {
  const { http, urls } = fakeAsana();
  const got: string[] = [];
  for await (const t of fetchAsana(http, { workspace: 'W' }, new Date('2026-10-12T00:00:00Z'), () => undefined)) got.push(t.id);
  assert.deepEqual(got, ['A']);
  assert.ok(!urls.some((u) => u.includes('/users/me')));
});

test('resolveMe: a configured gid or e-mail needs no request; `me` asks /users/me', async () => {
  const { http, urls } = fakeAsana();
  assert.deepEqual(await resolveMe(http, '42'), { gid: '42' });
  assert.deepEqual(await resolveMe(http, 'Owen@X.com'), { email: 'owen@x.com' });
  assert.equal(urls.length, 0);
  assert.deepEqual(await resolveMe(http), { gid: ME, email: 'owen@example.com' });
});
