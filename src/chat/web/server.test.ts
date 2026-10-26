// The web server over HTTP (web-chat-driver 2.2 / 2.5): the session gate, the OIDC round trip against a
// fake issuer, the allow-list, CSRF, the security headers, posting into the core, and the live stream's
// per-viewer visibility and reconnect. The core is a recorder here; turn.record.test.ts drives the real one.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WebConfig } from '../../config.js';
import { Store } from '../../state.js';
import type { RegistryRef } from '../../projects.js';
import type { Interactions } from '../core/interactions.js';
import { History } from './history.js';
import { allowLocalFiles } from '../../attachments.js';
import { webDriver } from './driver.js';
import { createWebServer, LOCAL_USER, type WebServer } from './server.js';
import { csrfToken, sealSession, SESSION_COOKIE, type Identity, type Oidc } from './auth.js';

const SECRET = 'k'.repeat(32);
const reg: RegistryRef = { current: { projects: [{ slug: 'alpha', repos: ['Org/alpha'] }, { slug: 'hidden', repos: ['Org/h'], webRoom: false }] } } as unknown as RegistryRef;

function fakeOidc(): Oidc & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async authorizationUrl(p) {
      calls.push(['auth', p]);
      return new URL(`https://idp.example/authorize?state=${p.state}&code_challenge=${p.codeChallenge}&redirect_uri=${encodeURIComponent(p.redirectUri)}`);
    },
    async endSessionUrl({ postLogoutRedirectUri }) {
      calls.push(['endSession', postLogoutRedirectUri]);
      return new URL(`https://idp.example/logout?client_id=c1&post_logout_redirect_uri=${encodeURIComponent(postLogoutRedirectUri)}`);
    },
    async callback(url, checks) {
      calls.push(['callback', url.search, checks]);
      if (url.searchParams.get('state') !== checks.state) throw new Error('state mismatch');
      const code = url.searchParams.get('code');
      const people: Record<string, Identity> = {
        ann: { sub: 'sub-ann', name: 'Ann Lee', email: 'ann@corp.example', groups: ['staff'] },
        stranger: { sub: 'sub-x', name: 'X', email: 'x@elsewhere.example', groups: [] },
      };
      const id = people[code ?? ''];
      if (!id) throw new Error('bad code');
      return id;
    },
  };
}

function recorder() {
  const calls: { kind: string; args: unknown }[] = [];
  const core = {
    actions: { cancel_turn: async (a: unknown) => void calls.push({ kind: 'action:cancel_turn', args: a }) },
    submits: { feedback: async (s: unknown) => void calls.push({ kind: 'submit:feedback', args: s }) },
    home: async (who: unknown) => void calls.push({ kind: 'home', args: who }),
    parkDmPick: () => 'dp1',
  } as unknown as Interactions;
  type Msg = { conv: string; id: string; thread?: string; text: string; direct: boolean; hasFiles: boolean; files(): Promise<{ refs: { name: string; url: string; mime: string; auth?: string }[]; bearer: string } | undefined> };
  const messages = {
    onMention: async (m: Msg) => void calls.push({ kind: 'mention', args: { conv: m.conv, id: m.id, thread: m.thread, text: m.text, direct: m.direct, ...(m.hasFiles ? { files: (await m.files())?.refs.map((r) => ({ name: r.name, mime: r.mime, auth: r.auth, file: r.url.startsWith('file:///') })) } : {}) } }),
    onMessage: async (m: Msg) => void calls.push({ kind: 'message', args: { conv: m.conv, id: m.id, thread: m.thread, text: m.text, direct: m.direct } }),
  };
  const commands = { run: async (c: { text: string; conv: string; ctx: { thread?: string } }) => void calls.push({ kind: 'command', args: { text: c.text, conv: c.conv, thread: c.ctx.thread } }) };
  return { calls, core, messages: messages as never, commands: commands as never };
}

function harness(over: Partial<WebConfig> = {}, oidc: Oidc | undefined = fakeOidc()) {
  const dir = mkdtempSync(join(tmpdir(), 'aven-web-srv-'));
  const store = new Store(join(dir, 'state.json'));
  const history = new History(join(dir, 'web'));
  let seq = 0;
  const driver = webDriver({ history, baseUrl: 'http://127.0.0.1:0', nameOf: (id) => store.getWebUser(id)?.name, ids: () => `m${++seq}` });
  const rec = recorder();
  const cfg: WebConfig = { port: 0, bind: '127.0.0.1', baseUrl: 'http://127.0.0.1:0', auth: oidc ? 'oidc' : 'none', org: 'corp.example', operators: [], allow: ['ann@corp.example'], sessionSecret: SECRET, maxFileMb: 20, ...over };
  allowLocalFiles(join(dir, 'web'));
  const server = createWebServer({ cfg, store, reg, history, driver, core: rec.core, messages: rec.messages, commands: rec.commands, filesRoot: join(dir, 'web'), ...(oidc ? { oidc } : {}), ids: () => `p${++seq}` });
  return { server, store, history, driver, rec, cfg, oidc };
}

const sessionCookie = (user: string, name?: string) => `${SESSION_COOKIE}=${sealSession(SECRET, { user, name, iat: Date.now() })}`;
const csrf = (user: string, cookie: string) => csrfToken(SECRET, { user, iat: Number(JSON.parse(Buffer.from(cookie.split('=')[1].split('.')[0], 'base64url').toString()).iat) });
const cookies = (res: Response): string[] => res.headers.getSetCookie();

let s: WebServer;
let base: string;
let h: ReturnType<typeof harness>;
const cfgOf = () => h.cfg;
before(async () => {
  h = harness();
  s = h.server;
  const { port } = await s.listen();
  base = `http://127.0.0.1:${port}`;
});
after(() => s.close());

const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers, redirect: 'manual' });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers }, redirect: 'manual' });

test('without a session: pages redirect to the login, endpoints answer 401, assets are served; every response carries the CSP', async () => {
  const home = await get('/');
  assert.equal(home.status, 303);
  assert.equal(home.headers.get('location'), '/login?next=%2F');
  assert.match(home.headers.get('content-security-policy') ?? '', /default-src 'none'; script-src 'self'/);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await get('/stream?conv=room:alpha')).status, 401);
  assert.equal((await post('/post', { conv: 'room:alpha', text: 'hi' })).status, 401);
  assert.equal((await post('/action', { action: 'cancel_turn' })).status, 401);
  const css = await get('/assets/app.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type') ?? '', /text\/css/);
  assert.equal((await get('/assets/nope.js')).status, 404);
});

test('the OIDC round trip: login redirects to the issuer with PKCE and state; the callback sets the session; a stale or forged state fails; a stranger is denied', async () => {
  const login = await get('/login?next=/r/alpha');
  assert.equal(login.status, 303);
  const to = new URL(login.headers.get('location')!);
  assert.equal(to.origin, 'https://idp.example');
  assert.ok(to.searchParams.get('code_challenge'));
  const state = to.searchParams.get('state')!;
  const loginCookie = cookies(login).find((c) => c.startsWith('aven_login='))!;
  assert.match(loginCookie, /HttpOnly; SameSite=Lax; Max-Age=600/);
  assert.ok(!/Secure/.test(loginCookie), 'no Secure flag on an http base URL');

  const cb = await get(`/auth/callback?code=ann&state=${state}`, { cookie: loginCookie.split(';')[0] });
  assert.equal(cb.status, 303);
  assert.equal(cb.headers.get('location'), '/r/alpha');
  const session = cookies(cb).find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
  assert.match(session, /HttpOnly; SameSite=Lax; Max-Age=43200/);
  assert.deepEqual(h.store.getWebUser('sub-ann')?.email, 'ann@corp.example');
  const home = await get('/', { cookie: session.split(';')[0] });
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /<meta name="csrf" content="[A-Za-z0-9_-]+">/);
  assert.match(html, /Ann Lee/);
  assert.match(html, /href="\/r\/alpha"/);
  assert.ok(!html.includes('/r/hidden'), 'a project with webRoom:false has no room');

  assert.equal((await get(`/auth/callback?code=ann&state=forged`, { cookie: loginCookie.split(';')[0] })).status, 400);
  assert.equal((await get(`/auth/callback?code=ann&state=${state}`)).status, 400); // no login cookie
  const login2 = await get('/login');
  const state2 = new URL(login2.headers.get('location')!).searchParams.get('state')!;
  const denied = await get(`/auth/callback?code=stranger&state=${state2}`, { cookie: cookies(login2).find((c) => c.startsWith('aven_login='))!.split(';')[0] });
  assert.equal(denied.status, 403);
  assert.match(await denied.text(), /x@elsewhere\.example.*not on this installation/);
  assert.ok(!cookies(denied).some((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.includes('Max-Age=0')), 'no session for a denied person');
});

test('with a session: a forged POST is rejected and stores nothing; a proper post reaches the core and the history; commands are private', async () => {
  const cookie = sessionCookie('u1', 'Ann');
  const token = csrf('u1', cookie);
  const forged = await post('/post', { conv: 'room:alpha', text: 'hi' }, { cookie });
  assert.equal(forged.status, 403);
  assert.equal(h.history.conversation('room:alpha').all().length, 0);
  const crossSite = await post('/post', { conv: 'room:alpha', text: 'hi' }, { cookie, 'x-csrf': token, 'sec-fetch-site': 'cross-site' });
  assert.equal(crossSite.status, 403);

  const ok = await post('/post', { conv: 'room:alpha', text: 'fix the bug' }, { cookie, 'x-csrf': token });
  assert.equal(ok.status, 200);
  const { id, thread } = (await ok.json()) as { id: string; thread: string };
  assert.equal(thread, id);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.rec.calls.at(-1), { kind: 'mention', args: { conv: 'room:alpha', id, thread: undefined, text: 'fix the bug', direct: false } });
  const stored = h.history.conversation('room:alpha').message(id)!;
  assert.deepEqual([stored.by, stored.text], [{ id: 'u1', name: 'Ann' }, 'fix the bug']);

  const reply = await post('/post', { conv: 'room:alpha', thread: id, text: 'and the tests' }, { cookie, 'x-csrf': token });
  assert.equal(reply.status, 200);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.rec.calls.at(-1)?.kind, 'message');
  assert.equal((h.rec.calls.at(-1)?.args as { thread: string }).thread, id);
  assert.equal((await post('/post', { conv: 'room:alpha', thread: 'nope', text: 'x' }, { cookie, 'x-csrf': token })).status, 404);

  const cmd = await post('/post', { conv: 'room:alpha', thread: id, text: '/aven status' }, { cookie, 'x-csrf': token });
  assert.equal(cmd.status, 200);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.rec.calls.at(-1), { kind: 'command', args: { text: 'status', conv: 'room:alpha', thread: id } });
  const typed = h.history.conversation('room:alpha').message(((await cmd.json()) as { id: string }).id)!;
  assert.deepEqual([typed.cmd, typed.visibleTo], [true, 'u1']);
  // At a room's top level the typed command is its own thread: the replies go into it, and the client opens it.
  const top = await post('/post', { conv: 'room:alpha', text: '/status' }, { cookie, 'x-csrf': token });
  const topId = ((await top.json()) as { id: string; thread: string });
  assert.equal(topId.thread, topId.id);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.rec.calls.at(-1), { kind: 'command', args: { text: 'status', conv: 'room:alpha', thread: topId.id } });
  // In a private conversation there are no threads: the replies stay in the conversation.
  const pc = await post('/post', { conv: 'pc:u1:alpha', text: '/status' }, { cookie, 'x-csrf': token });
  assert.equal(pc.status, 200);
  await new Promise((r) => setImmediate(r));
  assert.equal((h.rec.calls.at(-1)!.args as { thread?: string }).thread, undefined);

  const priv = await post('/post', { conv: 'pc:u1:alpha', text: 'psst' }, { cookie, 'x-csrf': token });
  assert.equal(priv.status, 200);
  await new Promise((r) => setImmediate(r));
  assert.equal((h.rec.calls.at(-1)?.args as { direct: boolean }).direct, true);
  assert.equal((await post('/post', { conv: 'pc:u2:alpha', text: 'peek' }, { cookie, 'x-csrf': token })).status, 403);
  assert.equal((await post('/post', { conv: 'room:hidden', text: 'x' }, { cookie, 'x-csrf': token })).status, 404);
  assert.equal((await post('/post', { conv: 'room:alpha', text: '   ' }, { cookie, 'x-csrf': token })).status, 400);

  const act = await post('/action', { action: 'cancel_turn', value: 't1', conv: 'room:alpha', thread: id, msg: 'm9' }, { cookie, 'x-csrf': token });
  assert.equal(act.status, 202);
  await new Promise((r) => setImmediate(r));
  const a = h.rec.calls.at(-1)!;
  assert.equal(a.kind, 'action:cancel_turn');
  assert.deepEqual((a.args as { where: unknown; msg: unknown; canDialog: boolean; actor: unknown }).where, { conv: 'room:alpha', thread: id });
  assert.deepEqual((a.args as { actor: unknown }).actor, { tenant: 'corp.example', user: 'u1' });
  assert.equal((await post('/action', { action: 'rm_rf', conv: 'room:alpha' }, { cookie, 'x-csrf': token })).status, 400);
  const sub = await post('/dialog', { id: 'feedback', meta: '{"t":"t1"}', values: { reason: 'wrong', note: 'x', now: ['now'] }, conv: 'room:alpha' }, { cookie, 'x-csrf': token });
  assert.equal(sub.status, 202);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual((h.rec.calls.at(-1)!.args as { values: unknown }).values, { reason: 'wrong', note: 'x', now: ['now'] });
});

// Read SSE frames from a response until `n` named events arrived (or the time is up).
async function frames(res: Response, n: number, ms = 3000): Promise<{ event: string; id?: string; data: unknown }[]> {
  const out: { event: string; id?: string; data: unknown }[] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + ms;
  while (out.length < n && Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), deadline - Date.now()))]);
    if (chunk.done) break;
    buf += dec.decode(chunk.value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (block.startsWith(':')) continue;
      const f: { event: string; id?: string; data: unknown } = { event: '', data: undefined };
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) f.event = line.slice(7);
        else if (line.startsWith('id: ')) f.id = line.slice(4);
        else if (line.startsWith('data: ')) f.data = JSON.parse(line.slice(6));
      }
      out.push(f);
    }
  }
  void reader.cancel().catch(() => {});
  return out;
}

test('the stream: two viewers see the public message, only one the private reply; a reconnect replays what was missed; a dialog reaches its person', async () => {
  const c1 = sessionCookie('u1', 'Ann');
  const c2 = sessionCookie('u2', 'Bo');
  const conv = h.history.conversation('room:alpha');
  conv.append({ t: 'post', id: 'root1', by: { id: 'u1', name: 'Ann' }, text: 'start' });
  const start = conv.seq;
  const s1 = await get(`/stream?conv=room:alpha&thread=root1`, { cookie: c1.split(';')[0] });
  const s2 = await get(`/stream?conv=room:alpha&thread=root1`, { cookie: c2.split(';')[0] });
  assert.equal(s1.status, 200);
  assert.match(s1.headers.get('content-type') ?? '', /text\/event-stream/);
  const f1 = frames(s1, 4);
  const f2 = frames(s2, 4);
  await new Promise((r) => setTimeout(r, 50));
  await h.driver.post({ conv: 'room:alpha', thread: 'root1' }, { kind: 'status', line: 'Working…', turnId: 't1', notify: 'Working…' });
  await h.driver.postPrivate({ conv: 'room:alpha', thread: 'root1' }, 'u1', { kind: 'text', text: 'only for Ann' });
  await h.driver.openDialog({ id: 'show_trail', value: 't1', actor: { user: 'u1' }, canDialog: true, ctx: { conv: 'room:alpha', thread: 'root1', user: 'u1' } }, { kind: 'trail', trail: { steps: ['📖 Read'], elapsedMs: 1000, done: true } });
  const [got1, got2] = await Promise.all([f1, f2]);
  assert.deepEqual(got1.map((f) => f.event), ['ready', 'msg', 'msg', 'dialog']);
  assert.match((got1[2].data as { html: string }).html, /only for Ann/);
  assert.match((got1[3].data as { html: string }).html, /📖 Read/);
  assert.deepEqual(got2.map((f) => f.event).slice(0, 3), ['ready', 'msg', 'noop']);
  assert.equal(got2.length, 3, 'Bo gets no dialog and no private reply');
  assert.ok(!JSON.stringify(got2).includes('only for Ann'));

  // A reconnect from the sequence number after the root replays exactly the two events after it, re-rendered for the viewer.
  const again = await get(`/stream?conv=room:alpha&thread=root1`, { cookie: c2.split(';')[0], 'last-event-id': String(start) });
  const replay = await frames(again, 2, 1500);
  assert.deepEqual(replay.map((f) => [f.event, f.id]), [['msg', String(start + 1)], ['noop', String(start + 2)]]);

  // The room page's stream carries thread cards, re-rendered on activity in the thread.
  const room = await get(`/stream?conv=room:alpha`, { cookie: c2.split(';')[0], 'last-event-id': String(start) });
  const cards = await frames(room, 2, 1500);
  assert.deepEqual(cards.map((f) => f.event), ['thread', 'thread']);
  assert.match((cards[0].data as { html: string }).html, /id="thread-root1"/);

  assert.equal((await get(`/stream?conv=pc:u1:alpha`, { cookie: c2.split(';')[0] })).status, 404, 'another person\'s private conversation is not streamed');
});

test('pages: a room lists its threads newest first with the latest line; a thread shows its messages; a missing room is a 404 page', async () => {
  const cookie = sessionCookie('u2', 'Bo').split(';')[0];
  const room = await get('/r/alpha', { cookie });
  assert.equal(room.status, 200);
  const html = await room.text();
  assert.match(html, /id="thread-root1"/);
  assert.match(html, /<meta name="stream" content="\/stream\?conv=room%3Aalpha">/);
  const thread = await get('/r/alpha/t/root1', { cookie });
  assert.equal(thread.status, 200);
  const t = await thread.text();
  assert.match(t, /id="msg-root1"/);
  assert.ok(!t.includes('only for Ann'), 'Bo does not see Ann\'s private reply on the page either');
  assert.equal((await get('/r/alpha/t/nope', { cookie })).status, 404);
  assert.equal((await get('/r/hidden', { cookie })).status, 404);
  assert.equal((await get('/p/alpha', { cookie })).status, 200);
});

test('WEB_AUTH=none: the login sets the fixed local user; a logout clears the session', async () => {
  const local = harness({ auth: 'none' }, undefined);
  const { port } = await local.server.listen();
  try {
    const login = await fetch(`http://127.0.0.1:${port}/login`, { redirect: 'manual' });
    assert.equal(login.status, 303);
    const cookie = cookies(login).find((c) => c.startsWith(`${SESSION_COOKIE}=`))!.split(';')[0];
    const home = await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(home.status, 200);
    assert.match(await home.text(), new RegExp(LOCAL_USER.name!));
    const token = csrf('local', cookie);
    const out = await fetch(`http://127.0.0.1:${port}/logout`, { method: 'POST', headers: { cookie, 'x-csrf': token }, redirect: 'manual' });
    assert.equal(out.status, 303);
    assert.equal(out.headers.get('location'), '/signed-out', 'no identity provider: signed out locally, onto the signed-out page');
    assert.ok(cookies(out).some((c) => c.startsWith(`${SESSION_COOKIE}=;`) && c.includes('Max-Age=0')));
  } finally {
    await local.server.close();
  }
});

test('files: a too-large upload is refused naming the file, an unsupported type too; an upload rides a post as a file: reference; downloads are attachments the viewer may see', async () => {
  const cookie = sessionCookie('u1', 'Ann');
  const token = csrf('u1', cookie);
  const put = (name: string, body: Buffer | string, conv = 'room:alpha', headers: Record<string, string> = {}) =>
    fetch(`${base}/upload?conv=${encodeURIComponent(conv)}&name=${encodeURIComponent(name)}`, { method: 'PUT', body, headers: { cookie, 'x-csrf': token, 'content-type': 'application/octet-stream', ...headers } });
  const big = await put('huge.pdf', Buffer.alloc(cfgOf().maxFileMb * 1024 * 1024 + 1));
  assert.equal(big.status, 413);
  assert.deepEqual(await big.json(), { error: `huge.pdf is too large (limit ${cfgOf().maxFileMb} MB)` });
  const exe = await put('tool.exe', 'MZ');
  assert.equal(exe.status, 415);
  assert.match(((await exe.json()) as { error: string }).error, /^tool\.exe: not a file type/);
  assert.equal((await put('x.md', 'hi', 'pc:u2:alpha')).status, 404);
  assert.equal((await fetch(`${base}/upload?conv=room:alpha&name=x.md`, { method: 'PUT', body: 'hi', headers: { cookie, 'content-type': 'text/plain' } })).status, 403, 'no CSRF token');

  const ok = await put('../notes v1.md', '# notes');
  assert.equal(ok.status, 200);
  const up = (await ok.json()) as { id: string; name: string; size: number };
  assert.deepEqual([up.name, up.size], ['notes_v1.md', 7]);
  const posted = await post('/post', { conv: 'room:alpha', text: '', files: [up.id] }, { cookie, 'x-csrf': token });
  assert.equal(posted.status, 200);
  await new Promise((r) => setTimeout(r, 20));
  const m = h.rec.calls.at(-1)!;
  assert.equal(m.kind, 'mention');
  assert.deepEqual((m.args as { files: unknown }).files, [{ name: 'notes_v1.md', mime: 'text/markdown', auth: 'none', file: true }]);
  const { id } = (await posted.json()) as { id: string };
  assert.deepEqual(h.history.conversation('room:alpha').message(id)!.files, [{ id: up.id, name: 'notes_v1.md', size: 7 }]);
  assert.equal((await post('/post', { conv: 'room:alpha', text: 'x', files: ['fnope'] }, { cookie, 'x-csrf': token })).status, 400);

  const dl = await get(`/files/alpha/${up.id}`, { cookie });
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-disposition'), `attachment; filename="notes_v1.md"; filename*=UTF-8''notes_v1.md`);
  assert.match(dl.headers.get('content-type') ?? '', /^text\/markdown/);
  assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await dl.text(), '# notes');
  // A private upload: its owner downloads it, another person gets nothing.
  const priv = await put('secret.txt', 'psst', 'pc:u1:alpha');
  const pid = ((await priv.json()) as { id: string }).id;
  assert.equal((await get(`/files/alpha/${pid}`, { cookie })).status, 200);
  assert.equal((await get(`/files/alpha/${pid}`, { cookie: sessionCookie('u2', 'Bo').split(';')[0] })).status, 404);
  assert.equal((await get(`/files/alpha/../../etc`, { cookie })).status, 404);
  const page = await get('/r/alpha/t/' + id, { cookie });
  assert.match(await page.text(), new RegExp(`href="/files/alpha/${up.id}">📎 notes_v1.md</a>`));
});

test('/help shows the Home cheat-sheet to the caller; the composer gets the verbs and the file limit', async () => {
  const cookie = sessionCookie('u1', 'Ann');
  const token = csrf('u1', cookie);
  const r = await post('/post', { conv: 'room:alpha', text: '/help' }, { cookie, 'x-csrf': token });
  assert.equal(r.status, 200);
  await new Promise((rs) => setTimeout(rs, 20));
  assert.deepEqual(h.rec.calls.at(-1), { kind: 'home', args: { tenant: 'corp.example', user: 'u1' } });
  const html = await (await get('/r/alpha', { cookie })).text();
  assert.match(html, /<meta name="verbs" content="help home status [a-z ]+">/);
  assert.match(html, /<meta name="max-file-mb" content="20">/);
  assert.match(html, /data-conv="room:alpha" data-last="20/);
  assert.match(html, /id="file-input" multiple/);
});

test('sign out ends the identity provider\'s session too: the cookie is cleared and the browser goes to the end-session URL, which returns to /signed-out (no session needed)', async () => {
  const cookie = sessionCookie('u1', 'Ann');
  const token = csrf('u1', cookie);
  const out = await post('/logout', {}, { cookie, 'x-csrf': token });
  assert.equal(out.status, 303);
  assert.equal(out.headers.get('location'), `https://idp.example/logout?client_id=c1&post_logout_redirect_uri=${encodeURIComponent('http://127.0.0.1:0/signed-out')}`);
  assert.ok(cookies(out).some((c) => c.startsWith(`${SESSION_COOKIE}=;`) && c.includes('Max-Age=0')));
  const page = await get('/signed-out');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /You are signed out.*href="\/login"/s);
});
