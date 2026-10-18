// The hub client against a fake hub that speaks the real frames (protocol.ts) and checks the real
// challenge signature (seal.ts) — the Worker itself is tested in workerd (hub/test/).
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../state.js';
import { applyHubReports, connectUrl, HubClient, type HubSocket } from './hubclient.js';
import { generateKeyFile, open, seal, verifyChallenge, type KeyFile } from './seal.js';
import { memoryStore, type Delivery } from './transport.js';
import type { EventSink } from './events.js';
import type { Envelope, Payload, Sealed, WireEnvelope } from './protocol.js';
import type { OutTask } from './records.js';
import { TASK_EXPIRY_MS } from './expiry.js';

const HOME = generateKeyFile();
const BLUEFIN = generateKeyFile();
const NORTHWIND = generateKeyFile();
const pin = (k: KeyFile) => [{ sign: k.signing.public, box: k.encryption.public }];
const PEERS = { bluefin: pin(BLUEFIN), northwind: pin(NORTHWIND) };
const flush = () => new Promise((r) => setImmediate(r));
let n = 0;
const id = () => (++n).toString(16).padStart(24, '0');
const TASK = 'a'.repeat(24);
const payload = (over: Partial<Payload> = {}): Payload => ({ message: { role: 'user', parts: [{ kind: 'text', text: 'why?' }], messageId: TASK }, domain: 'home', marks: {}, depth: 0, ...over });

function events(): EventSink & { lines: string[] } {
  const lines: string[] = [];
  return { lines, log: (_l, line) => lines.push(line), capture: () => undefined, now: () => Date.now() };
}

/** One fake hub connection: the client's socket, driven from the test. */
class FakeConn implements HubSocket {
  sent: Record<string, unknown>[] = [];
  raw: string[] = [];
  closed?: { code?: number; reason?: string };
  private l: Record<string, ((ev: { data?: unknown; code?: number; reason?: string }) => void)[]> = {};
  addEventListener(type: string, fn: (ev: { data?: unknown; code?: number; reason?: string }) => void): void {
    (this.l[type] ??= []).push(fn);
  }
  send(data: string): void {
    this.raw.push(data);
    if (data !== 'ping') this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  push(frame: unknown): void {
    for (const fn of this.l.message ?? []) fn({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) });
  }
  drop(code: number, reason = ''): void {
    for (const fn of this.l.close ?? []) fn({ code, reason });
  }
  frames(t: string): Record<string, unknown>[] {
    return this.sent.filter((f) => f.t === t);
  }
}

interface FakeHub {
  conns: FakeConn[];
  readonly last: FakeConn;
  socket: (url: string) => HubSocket;
  admit: (c?: FakeConn) => Promise<void>;
}

/** A fake hub: hands out connections, sends the challenge, checks the signature, says hello. */
function fakeHub(o: { now?: () => string; removed?: { installation: string; at: string }[] } = {}): FakeHub {
  const conns: FakeConn[] = [];
  const hub: FakeHub = {
    conns,
    get last(): FakeConn {
      return conns[conns.length - 1]!;
    },
    socket: (url: string): HubSocket => {
      assert.equal(url, 'wss://hub.example/connect?as=home', 'the name it claims, as the hint');
      const c = new FakeConn();
      conns.push(c);
      setImmediate(() => c.push({ t: 'challenge', nonce: `nonce-${conns.length}`, now: o.now?.() ?? new Date().toISOString() }));
      return c;
    },
    /** Answer the auth the client sent on `c` like the hub would. */
    async admit(c = hub.last): Promise<void> {
      await flush();
      const auth = c.frames('auth')[0];
      assert.ok(auth, 'the client answered the challenge');
      assert.deepEqual({ v: auth.v, name: auth.name, key: auth.key }, { v: 2, name: 'home', key: HOME.signing.public }, 'version 2: the name and the key that claims it');
      assert.ok(verifyChallenge('hub.example', 'home', `nonce-${conns.indexOf(c) + 1}`, String(auth.sig), HOME.signing.public), 'signed with the installation key');
      c.push({ t: 'hello', now: new Date().toISOString(), online: ['bluefin'], removed: o.removed ?? [] });
      await flush();
    },
  };
  return hub;
}

function client(hub: FakeHub, over: Partial<ConstructorParameters<typeof HubClient>[0]> = {}) {
  const store = memoryStore();
  const sink = events();
  const c = new HubClient({ url: 'wss://hub.example', installation: 'home', keys: HOME, peers: () => PEERS, store, socket: hub.socket, sink, random: () => 0.5, ...over });
  return { c, store: (over.store as typeof store | undefined) ?? store, sink };
}

/** An envelope from bluefin to home, sealed as bluefin's bot would seal it. */
function fromBluefin(over: Partial<Sealed> = {}, p: Payload = payload({ domain: 'bluefin' }), signer = BLUEFIN): WireEnvelope {
  const content: Sealed = { from: 'caldora', to: 'owen-ops', method: 'answer', task: TASK, payload: p, ...over };
  return seal({ v: 2, id: id(), from: 'bluefin', to: 'home' }, content, { signing: signer.signing, recipientBox: HOME.encryption.public });
}
/** A message of home's, sealed for bluefin as the client seals it. */
function toBluefin(env: Envelope): WireEnvelope {
  return seal({ v: env.v, id: env.id, from: 'home', to: 'bluefin' }, { from: 'owen-ops', to: 'caldora', method: env.method, task: env.task, payload: payload() }, { signing: HOME.signing, recipientBox: BLUEFIN.encryption.public });
}
const unrouted = (store: { load(): { routedAt?: string }[] }) => store.load().filter((r) => !r.routedAt);

test('connectUrl — the base URL gets /connect and the claimed name as `as`; an explicit path stays', () => {
  assert.equal(connectUrl('wss://hub.example', 'home'), 'wss://hub.example/connect?as=home');
  assert.equal(connectUrl('wss://hub.example/', 'home'), 'wss://hub.example/connect?as=home');
  assert.equal(connectUrl('wss://hub.example/aven/connect', 'bluefin'), 'wss://hub.example/aven/connect?as=bluefin');
});

test('connect: version-2 `auth` signed with the installation key; after hello the allow list, then the outbox again; `routed` keeps only the clear message', async () => {
  const hub = fakeHub();
  const store = memoryStore();
  const env: Envelope = { v: 2, id: id(), from: 'home/owen-ops', to: 'bluefin/caldora', method: 'ask', task: TASK };
  store.save([{ seq: 7, env, wire: toBluefin(env), at: '2026-10-17T08:00:00.000Z' }]); // written before a restart, never routed
  const { c } = client(hub, { store });
  const outcomes: string[] = [];
  c.onOutcome((e, o) => outcomes.push(`${e.id}:${'routed' in o ? 'routed' : o.rejected}`));
  c.start();
  await hub.admit();
  assert.equal(c.connected, true);
  assert.deepEqual(hub.last.sent.map((f) => f.t), ['auth', 'allow', 'send']);
  assert.deepEqual(hub.last.frames('allow'), [{ t: 'allow', installations: ['bluefin', 'northwind'] }], 'the pinned peers');
  assert.deepEqual(hub.last.frames('send').map((f) => (f.env as WireEnvelope).id), [env.id]);
  hub.last.push({ t: 'routed', id: env.id });
  assert.deepEqual(unrouted(store), []);
  const [kept] = store.load();
  assert.deepEqual({ ...kept, routedAt: undefined }, { seq: 7, env, at: '2026-10-17T08:00:00.000Z', routedAt: undefined }, 'no ciphertext kept');
  assert.deepEqual(outcomes, [`${env.id}:routed`]);
  assert.deepEqual(c.presence(), { online: ['bluefin'], removed: [] });
  c.stop();
});

test('allow list: sent again only when a reload changes the pinned peers; not before hello', async () => {
  const hub = fakeHub();
  let peers: Record<string, ReturnType<typeof pin>> = { ...PEERS };
  const { c } = client(hub, { peers: () => peers });
  c.refreshAllow();
  c.start();
  await flush();
  assert.deepEqual(hub.last.frames('allow'), [], 'not before the hub said hello');
  await hub.admit();
  c.refreshAllow(); // a reload that changed nothing
  peers = { bluefin: pin(BLUEFIN) };
  c.refreshAllow();
  assert.deepEqual(hub.last.frames('allow'), [
    { t: 'allow', installations: ['bluefin', 'northwind'] },
    { t: 'allow', installations: ['bluefin'] },
  ]);
  c.stop();
});

test('clocks do not matter: a hub ten minutes ahead still connects; the skew is a warning once per connection, never corrected', async () => {
  const hub = fakeHub({ now: () => new Date(Date.now() + 10 * 60_000).toISOString() });
  const { c, sink } = client(hub);
  c.start();
  await hub.admit();
  assert.equal(c.connected, true);
  assert.equal(sink.lines.filter((l) => l.startsWith('messaging hub.clock.skew')).length, 1);
  const skew = Number(/skew_ms=(-?\d+)/.exec(sink.lines.find((l) => l.includes('hub.clock.skew'))!)![1]);
  assert.ok(Math.abs(skew - 600_000) < 5_000, `about ten minutes (${skew} ms)`);
  hub.last.push({ t: 'challenge', nonce: 'again', now: new Date(Date.now() + 10 * 60_000).toISOString() });
  await flush();
  assert.equal(sink.lines.filter((l) => l.includes('hub.clock.skew')).length, 1, 'once per connection');
  c.stop();
});

test('send: sealed to the peer’s pinned key and recorded before it leaves; only the peer can open it', async () => {
  const hub = fakeHub();
  const { c, store } = client(hub);
  c.start();
  await hub.admit();
  const env: Envelope = { v: 2, id: id(), from: 'home/owen-ops', to: 'bluefin/caldora', method: 'ask', task: TASK };
  const outcome = c.send(env, payload());
  assert.equal(store.load().length, 1, 'recorded first');
  const sent = hub.last.frames('send')[0]!.env as WireEnvelope;
  assert.ok(sent.ct && sent.sig && sent.eph);
  assert.deepEqual([sent.from, sent.to], ['home', 'bluefin'], 'installations in clear');
  for (const hidden of ['why?', 'owen-ops', 'caldora', TASK]) assert.equal(JSON.stringify(sent).includes(hidden), false, `${hidden} is sealed`);
  const opened = open(sent, { senderKeys: pin(HOME), own: BLUEFIN });
  assert.ok(opened.ok);
  assert.deepEqual(opened.ok && opened.content, { from: 'owen-ops', to: 'caldora', method: 'ask', task: TASK, payload: payload() });
  assert.equal(open(sent, { senderKeys: pin(HOME), own: NORTHWIND }).ok, false, 'another peer cannot');
  hub.last.push({ t: 'routed', id: env.id });
  assert.deepEqual(await outcome, { routed: true });
  assert.deepEqual(unrouted(store), []);
  const before = store.load().length;
  assert.deepEqual(await c.send({ ...env, id: id(), to: 'mallory/x' }, payload()), { rejected: 'unknown installation' });
  assert.equal(store.load().length, before, 'an unpinned installation records nothing');
  c.stop();
});

test('deliver: opened and handed over; acked only after the handler resolved; a failed handler leaves it for the next connection', async () => {
  const hub = fakeHub();
  const { c } = client(hub);
  let release!: () => void;
  const got: Delivery[] = [];
  let fail = true;
  c.onDeliver(async (d) => {
    got.push(d);
    if (fail) throw new Error('state.json is read-only');
    await new Promise<void>((r) => (release = r));
  });
  c.start();
  await hub.admit();
  const e1 = fromBluefin();
  hub.last.push({ t: 'deliver', seq: 1, env: e1 });
  await flush();
  assert.equal(got.length, 1);
  assert.deepEqual(hub.last.frames('ack'), [], 'not acked after a failure');
  fail = false;
  hub.last.push({ t: 'deliver', seq: 1, env: e1 }); // the hub delivers it again
  await flush();
  assert.equal(got.length, 2);
  assert.deepEqual(got[1]!.payload?.domain, 'bluefin');
  assert.deepEqual(got[1]!.env, { v: 2, id: e1.id, from: 'bluefin/caldora', to: 'home/owen-ops', method: 'answer', task: TASK }, 'joined back into the message the bot handles');
  assert.deepEqual(hub.last.frames('ack'), [], 'not before the handler resolved');
  release();
  await flush();
  assert.deepEqual(hub.last.frames('ack'), [{ t: 'ack', seq: 1 }]);
  c.stop();
});

test('deliver: a handler that finishes after a reconnect does not ack on the new connection before its hello (the hub would refuse it)', async () => {
  const hub = fakeHub();
  const { c } = client(hub);
  let release!: () => void;
  c.onDeliver(() => new Promise<void>((r) => (release = r)));
  c.start();
  await hub.admit();
  hub.last.push({ t: 'deliver', seq: 3, env: fromBluefin() });
  await flush();
  const first = hub.last;
  first.drop(1006);
  (c as unknown as { dial(): void }).dial(); // the redial, before its hello
  release();
  await flush();
  assert.deepEqual(hub.last.frames('ack'), [], 'nothing but auth before hello');
  assert.deepEqual(first.frames('ack'), []);
  c.stop();
});

test('deliver: an envelope this process handled already is acked and ignored', async () => {
  const hub = fakeHub();
  const { c, sink } = client(hub);
  let calls = 0;
  c.onDeliver(async () => void calls++);
  c.start();
  await hub.admit();
  const e = fromBluefin();
  hub.last.push({ t: 'deliver', seq: 4, env: e });
  await flush();
  hub.last.push({ t: 'deliver', seq: 4, env: e }); // the ack was lost on the way
  await flush();
  assert.equal(calls, 1);
  assert.deepEqual(hub.last.frames('ack'), [{ t: 'ack', seq: 4 }, { t: 'ack', seq: 4 }]);
  assert.ok(sink.lines.some((l) => l.startsWith('messaging hub.envelope.duplicate')));
  c.stop();
});

test('tampered envelope: dropped with `bad signature`, acked, no handler; so are an unpinned sender, a foreign domain claim, another version and one for another installation', async () => {
  const hub = fakeHub();
  const { c, sink } = client(hub);
  let calls = 0;
  c.onDeliver(async () => void calls++);
  c.start();
  await hub.admit();
  const tampered = { ...fromBluefin(), from: 'northwind' }; // sender altered in transit
  const forged = fromBluefin({}, payload({ domain: 'bluefin' }), NORTHWIND); // signed with another key
  const unpinned = { ...fromBluefin(), from: 'mallory' };
  const claim = fromBluefin({}, payload({ domain: 'northwind' }));
  const future = { ...fromBluefin(), v: 3 };
  const elsewhere = { ...fromBluefin(), to: 'northwind' };
  [tampered, forged, unpinned, claim, future, elsewhere].forEach((env, i) => hub.last.push({ t: 'deliver', seq: 10 + i, env }));
  await flush();
  assert.equal(calls, 0);
  assert.deepEqual(hub.last.frames('ack').map((f) => f.seq), [10, 11, 12, 13, 14, 15]);
  const names = sink.lines.map((l) => l.split(' ')[1]);
  assert.deepEqual(names, ['hub.envelope.bad_signature', 'hub.envelope.bad_signature', 'hub.envelope.bad_signature', 'ask.unexpected', 'ask.rejected', 'ask.unexpected']);
  assert.match(sink.lines[2]!, /key=unpinned/);
  assert.match(sink.lines[3]!, /a domain of bluefin, not northwind/);
  assert.match(sink.lines[4]!, /reason="unsupported version" versions="theirs 3, ours 2"/);
  assert.match(sink.lines[5]!, /an envelope for home, not for northwind/);
  assert.ok(!sink.lines.join('\n').includes(BLUEFIN.signing.public), 'fingerprints only, never a key');
  c.stop();
});

test('a version-1 record left in the outbox at the upgrade: nothing to send, its task ends `rejected: unsupported version`', async () => {
  const hub = fakeHub();
  const store = memoryStore();
  const old: Envelope = { v: 1, id: id(), from: 'home/owen-ops', to: 'bluefin/caldora', method: 'ask', task: TASK };
  store.save([{ seq: 3, env: old, at: '2026-10-17T08:00:00.000Z' }]);
  const { c } = client(hub, { store });
  const outcomes: string[] = [];
  c.onOutcome((e, o) => outcomes.push(`${e.id}:${'routed' in o ? 'routed' : o.rejected}`));
  c.start();
  await hub.admit();
  assert.deepEqual(hub.last.frames('send'), []);
  assert.deepEqual(outcomes, [`${old.id}:unsupported version`]);
  assert.deepEqual(store.load(), []);
  c.stop();
});

test('replaced: logged as a warning, and the client backs off instead of fighting the other bot', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const hub = fakeHub();
  const { c, sink } = client(hub);
  c.start();
  await hub.admit();
  hub.last.drop(4000, 'replaced');
  assert.ok(sink.lines.some((l) => l === 'messaging hub.replaced installation=home'));
  t.mock.timers.tick(29_000);
  assert.equal(hub.conns.length, 1, 'no redial within half a minute');
  t.mock.timers.tick(31_000);
  assert.equal(hub.conns.length, 2);
  c.stop();
});

test('refused at auth: `hub.connect.failed` with the reason, once per hour while it keeps retrying', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const hub = fakeHub();
  const { c, sink } = client(hub);
  c.start();
  for (let i = 0; i < 3; i++) {
    await flush();
    hub.last.drop(4003, 'name taken');
    t.mock.timers.tick(60_000);
  }
  assert.ok(hub.conns.length >= 3);
  assert.deepEqual(sink.lines.filter((l) => l.includes('hub.connect.failed')), ['messaging hub.connect.failed installation=home reason="name taken"']);
  c.stop();
});

test('allow throttled: the hub closes the connection; the client logs it, redials only after its backoff, and sends its list once — no loop', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const hub = fakeHub();
  const { c, sink } = client(hub);
  c.start();
  await hub.admit();
  hub.last.drop(4003, 'allow throttled');
  assert.ok(sink.lines.includes('messaging hub.connect.failed installation=home reason="allow throttled"'));
  t.mock.timers.tick(400);
  assert.equal(hub.conns.length, 1, 'not at once: the backoff (0.5–1 s, doubling while it fails)');
  t.mock.timers.tick(1_000);
  assert.equal(hub.conns.length, 2);
  await hub.admit(hub.last);
  assert.deepEqual(hub.last.frames('allow'), [{ t: 'allow', installations: ['bluefin', 'northwind'] }], 'one list on the new connection: under any budget');
  c.stop();
});

test('silent for 90 s: dropped and redialled; offline for 10 minutes: reported once with the outbox size', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-17T08:00:00.000Z') });
  const hub = fakeHub();
  const { c, sink, store } = client(hub);
  const queued: Envelope = { v: 2, id: id(), from: 'home/owen-ops', to: 'bluefin/caldora', method: 'ask', task: TASK };
  store.save([{ seq: 1, env: queued, wire: toBluefin(queued), at: '2026-10-17T08:00:00.000Z' }]);
  c.start();
  await hub.admit();
  t.mock.timers.tick(30_000);
  assert.ok(hub.last.raw.includes('ping'), 'keep-alive');
  t.mock.timers.tick(90_000); // nothing heard since
  assert.equal(c.connected, false);
  t.mock.timers.tick(5_000);
  assert.equal(hub.conns.length, 2, 'redialled');
  for (let i = 0; i < 25; i++) t.mock.timers.tick(30_000); // the new connection never says hello
  assert.deepEqual(sink.lines.filter((l) => l.includes('hub.disconnected.long')).length, 1);
  assert.match(sink.lines.find((l) => l.includes('hub.disconnected.long'))!, /outbox=1/);
  c.stop();
});

// ── the reports applied to the task records ──────────────────────────────────────────────────────
function storeWithTasks(): Store {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'aven-hubclient-')), 'state.json'));
  const base: OutTask = { id: TASK, slug: 'owen-ops', key: 'thread:1.2', reply: { key: 'thread:1.2', driver: 'slack' }, target: 'northwind/ledger', question: 'q', state: 'submitted', depth: 0, rounds: 0, replies: [], seen: [], createdAt: '2026-10-17T08:00:00.000Z', updatedAt: '2026-10-17T08:00:00.000Z' };
  store.putOutTask(base);
  store.putOutTask({ ...base, id: 'b'.repeat(24), target: 'bluefin/caldora', state: 'input-required', replies: ['c'.repeat(24)] });
  store.putInTask({ id: 'd'.repeat(24), origin: 'northwind', from: 'northwind/ledger', fromDomain: 'northwind', slug: 'caldora', key: `a2a:northwind:${'d'.repeat(24)}:caldora`, question: 'q', state: 'working', depth: 0, rounds: 0, seen: [], createdAt: base.createdAt, updatedAt: base.updatedAt });
  return store;
}

test('peer removed: the hub reports northwind removed — every open task with it ends `failed: peer removed`, once', async () => {
  const hub = fakeHub({ removed: [{ installation: 'northwind', at: '2026-10-17T09:00:00.000Z' }] });
  const { c, sink } = client(hub);
  const store = storeWithTasks();
  const ended: string[] = [];
  applyHubReports(c, store, { installation: 'home', onEnded: (t) => ended.push(`${t.id.slice(0, 1)}:${t.state}:${t.reason}`), sink });
  c.start();
  await hub.admit();
  assert.deepEqual(ended.sort(), ['a:failed:peer removed', 'd:failed:peer removed']);
  assert.equal(store.getOutTask('b'.repeat(24))?.state, 'input-required', 'bluefin’s task is untouched');
  hub.last.push({ t: 'presence', online: ['home'], removed: [{ installation: 'northwind', at: '2026-10-17T09:00:00.000Z' }] });
  assert.equal(ended.length, 2, 'reported again, applied once');
  assert.ok(sink.lines.includes('messaging hub.peer.removed peer=northwind ended=2'));
  c.stop();
});

test('expired and rejected: the first message rejected ends the task `rejected`; a later one ends it `failed`; an expiry `failed: expired`', async () => {
  const hub = fakeHub();
  const { c, store: outbox } = client(hub);
  const store = storeWithTasks();
  const ended: string[] = [];
  applyHubReports(c, store, { installation: 'home', onEnded: (t) => ended.push(`${t.id.slice(0, 1)}:${t.state}:${t.reason}`) });
  c.start();
  await hub.admit();
  const first = { v: 2, id: id(), from: 'home/owen-ops', to: 'northwind/ledger', method: 'ask' as const, task: TASK };
  const reply = { v: 2, id: id(), from: 'home/owen-ops', to: 'bluefin/caldora', method: 'ask' as const, task: 'b'.repeat(24) };
  void c.send(first, payload());
  void c.send(reply, payload());
  hub.last.push({ t: 'rejected', id: first.id, reason: 'backlog' });
  hub.last.push({ t: 'rejected', id: reply.id, reason: 'backlog' });
  assert.deepEqual(ended, ['a:rejected:backlog', 'b:failed:backlog']);
  assert.deepEqual(outbox.load(), []);
  // Our answer that never reached its asker: the hub reports the envelope id only; the routed record names the task.
  const answer = { v: 2, id: id(), from: 'home/caldora', to: 'northwind/ledger', method: 'answer' as const, task: 'd'.repeat(24) };
  void c.send(answer, payload());
  hub.last.push({ t: 'routed', id: answer.id });
  hub.last.push({ t: 'expired', id: id() }); // an id this client never sent: nothing to end
  hub.last.push({ t: 'expired', id: answer.id });
  assert.deepEqual(ended.slice(2), ['d:failed:expired']);
  assert.deepEqual(outbox.load(), [], 'the report used the record up');
  c.stop();
});

test('rejected `unknown installation`: the reason names the likelier cause, a missing pin on the other side', async () => {
  const hub = fakeHub();
  const { c } = client(hub);
  const store = storeWithTasks();
  const ended: string[] = [];
  applyHubReports(c, store, { installation: 'home', onEnded: (t) => ended.push(`${t.id.slice(0, 1)}:${t.state}:${t.reason}`) });
  c.start();
  await hub.admit();
  const first = { v: 2, id: id(), from: 'home/owen-ops', to: 'northwind/ledger', method: 'ask' as const, task: TASK };
  void c.send(first, payload());
  hub.last.push({ t: 'rejected', id: first.id, reason: 'unknown installation' });
  assert.deepEqual(ended, ['a:rejected:unknown installation, or it has not pinned home']);
  c.stop();
});

test('routed records are kept for an expiry report only until the bot’s own task expiry', async () => {
  const hub = fakeHub();
  const store = memoryStore();
  const stale: Envelope = { v: 2, id: id(), from: 'home/owen-ops', to: 'bluefin/caldora', method: 'ask', task: TASK };
  store.save([{ seq: 1, env: stale, at: '2026-01-01T00:00:00.000Z', routedAt: new Date(Date.now() - TASK_EXPIRY_MS - 60_000).toISOString() }]);
  const { c } = client(hub, { store });
  c.start();
  await hub.admit();
  assert.deepEqual(hub.last.frames('send'), [], 'a routed record is never sent again');
  const env: Envelope = { ...stale, id: id() };
  void c.send(env, payload());
  hub.last.push({ t: 'routed', id: env.id });
  assert.deepEqual(store.load().map((r) => r.env.id), [env.id], 'the stale one pruned on the next settle');
  c.stop();
});

test('a peer named like an Object.prototype member: `constructor` unpinned is unknown on send, and unpinned on delivery — never a crash', async () => {
  const hub = fakeHub();
  const { c, sink } = client(hub);
  c.onDeliver(async () => assert.fail('no handler for an unpinned sender'));
  c.start();
  await hub.admit();
  const env: Envelope = { v: 2, id: id(), from: 'home/owen-ops', to: 'constructor/x', method: 'ask', task: TASK };
  assert.deepEqual(await c.send(env, payload()), { rejected: 'unknown installation' });
  hub.last.push({ t: 'deliver', seq: 30, env: { ...fromBluefin(), from: 'constructor' } });
  await flush();
  assert.deepEqual(hub.last.frames('ack'), [{ t: 'ack', seq: 30 }]);
  assert.match(sink.lines.find((l) => l.includes('hub.envelope.bad_signature'))!, /from=constructor .*key=unpinned/);
  c.stop();
});
