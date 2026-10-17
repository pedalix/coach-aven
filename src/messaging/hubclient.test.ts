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
import type { Envelope, Payload } from './protocol.js';
import type { OutTask } from './records.js';

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
      assert.equal(url, 'wss://hub.example/connect');
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
      assert.ok(verifyChallenge('hub.example', 'home', `nonce-${conns.indexOf(c) + 1}`, String(auth.sig), HOME.signing.public), 'signed with the installation key');
      c.push({ t: 'hello', now: new Date().toISOString(), enrolled: ['bluefin', 'home', 'northwind'], online: ['bluefin', 'home'], removed: o.removed ?? [] });
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
function fromBluefin(over: Partial<Envelope> = {}, p: Payload = payload({ domain: 'bluefin' }), signer = BLUEFIN): Envelope {
  const header = { v: 1, id: id(), from: 'bluefin/caldora', to: 'home/owen-ops', method: 'answer' as const, task: TASK, ...over };
  return seal(header, p, { signing: signer.signing, recipientBox: HOME.encryption.public });
}

test('connectUrl — the base URL gets /connect; an explicit path stays', () => {
  assert.equal(connectUrl('wss://hub.example'), 'wss://hub.example/connect');
  assert.equal(connectUrl('wss://hub.example/'), 'wss://hub.example/connect');
  assert.equal(connectUrl('wss://hub.example/aven/connect'), 'wss://hub.example/aven/connect');
});

test('connect: the challenge is signed with the installation key; after hello the outbox goes out again, and `routed` clears it', async () => {
  const hub = fakeHub();
  const store = memoryStore();
  const left = seal({ v: 1, id: id(), from: 'home/owen-ops', to: 'bluefin/caldora', method: 'ask', task: TASK }, payload(), { signing: HOME.signing, recipientBox: BLUEFIN.encryption.public });
  store.save([{ seq: 7, env: left, at: '2026-10-17T08:00:00.000Z' }]); // written before a restart, never routed
  const { c } = client(hub, { store });
  const outcomes: string[] = [];
  c.onOutcome((env, o) => outcomes.push(`${env.id}:${'routed' in o ? 'routed' : o.rejected}`));
  c.start();
  await hub.admit();
  assert.equal(c.connected, true);
  assert.deepEqual(hub.last.frames('send').map((f) => (f.env as Envelope).id), [left.id]);
  hub.last.push({ t: 'routed', id: left.id });
  assert.deepEqual(store.load(), []);
  assert.deepEqual(outcomes, [`${left.id}:routed`]);
  assert.deepEqual(c.presence(), { online: ['bluefin', 'home'], removed: [] });
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
  const env: Envelope = { v: 1, id: id(), from: 'home/owen-ops', to: 'bluefin/caldora', method: 'ask', task: TASK };
  const outcome = c.send(env, payload());
  assert.equal(store.load().length, 1, 'recorded first');
  const sent = hub.last.frames('send')[0]!.env as Envelope;
  assert.ok(sent.ct && sent.sig && sent.eph);
  assert.equal(JSON.stringify(sent).includes('why?'), false, 'nothing readable on the wire');
  const opened = open(sent, { senderKeys: pin(HOME), own: BLUEFIN });
  assert.ok(opened.ok && (opened.payload as Payload).domain === 'home');
  assert.equal(open(sent, { senderKeys: pin(HOME), own: NORTHWIND }).ok, false, 'another peer cannot');
  hub.last.push({ t: 'routed', id: env.id });
  assert.deepEqual(await outcome, { routed: true });
  assert.deepEqual(store.load(), []);
  assert.deepEqual(await c.send({ ...env, id: id(), to: 'mallory/x' }, payload()), { rejected: 'unknown installation' });
  assert.deepEqual(store.load(), [], 'an unpinned installation records nothing');
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

test('tampered envelope: dropped with `bad signature`, acked, no handler; so are an unpinned sender, a foreign domain claim and an unknown version', async () => {
  const hub = fakeHub();
  const { c, sink } = client(hub);
  let calls = 0;
  c.onDeliver(async () => void calls++);
  c.start();
  await hub.admit();
  const tampered = { ...fromBluefin(), from: 'bluefin/billing' }; // sender altered in transit
  const forged = fromBluefin({}, payload({ domain: 'bluefin' }), NORTHWIND); // signed with another key
  const unpinned = { ...fromBluefin(), from: 'mallory/x' };
  const claim = fromBluefin({}, payload({ domain: 'northwind' }));
  const future = { ...fromBluefin(), v: 2 };
  [tampered, forged, unpinned, claim, future].forEach((env, i) => hub.last.push({ t: 'deliver', seq: 10 + i, env }));
  await flush();
  assert.equal(calls, 0);
  assert.deepEqual(hub.last.frames('ack').map((f) => f.seq), [10, 11, 12, 13, 14]);
  const names = sink.lines.map((l) => l.split(' ')[1]);
  assert.deepEqual(names, ['hub.envelope.bad_signature', 'hub.envelope.bad_signature', 'hub.envelope.bad_signature', 'ask.unexpected', 'ask.rejected']);
  assert.match(sink.lines[2]!, /key=unpinned/);
  assert.match(sink.lines[3]!, /a domain of bluefin, not northwind/);
  assert.match(sink.lines[4]!, /reason="unsupported version" versions="theirs 2, ours 1"/);
  assert.ok(!sink.lines.join('\n').includes(BLUEFIN.signing.public), 'fingerprints only, never a key');
  c.stop();
});

test('unknown version: the answering side hears of it, to tell the sender', async () => {
  const hub = fakeHub();
  const { c } = client(hub);
  const heard: unknown[] = [];
  c.onUnsupported((u) => heard.push(u));
  c.start();
  await hub.admit();
  const future = { ...fromBluefin({ method: 'ask' }), v: 2 };
  hub.last.push({ t: 'deliver', seq: 20, env: future });
  await flush();
  assert.deepEqual(heard, [{ from: 'bluefin/caldora', to: 'home/owen-ops', task: TASK, theirs: 2 }]);
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
    hub.last.drop(4003, 'bad_sig');
    t.mock.timers.tick(60_000);
  }
  assert.ok(hub.conns.length >= 3);
  assert.deepEqual(sink.lines.filter((l) => l.includes('hub.connect.failed')), ['messaging hub.connect.failed installation=home reason=bad_sig']);
  c.stop();
});

test('silent for 90 s: dropped and redialled; offline for 10 minutes: reported once with the outbox size', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-17T08:00:00.000Z') });
  const hub = fakeHub();
  const { c, sink, store } = client(hub);
  store.save([{ seq: 1, env: { v: 1, id: id(), from: 'home/owen-ops', to: 'bluefin/caldora', method: 'ask', task: TASK }, at: '2026-10-17T08:00:00.000Z' }]);
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
  const first = { v: 1, id: id(), from: 'home/owen-ops', to: 'northwind/ledger', method: 'ask' as const, task: TASK };
  const reply = { v: 1, id: id(), from: 'home/owen-ops', to: 'bluefin/caldora', method: 'ask' as const, task: 'b'.repeat(24) };
  void c.send(first, payload());
  void c.send(reply, payload());
  hub.last.push({ t: 'rejected', id: first.id, reason: 'backlog' });
  hub.last.push({ t: 'rejected', id: reply.id, reason: 'backlog' });
  assert.deepEqual(ended, ['a:rejected:backlog', 'b:failed:backlog']);
  assert.deepEqual(outbox.load(), []);
  hub.last.push({ t: 'expired', id: id(), task: 'd'.repeat(24), to: 'northwind/ledger' });
  assert.deepEqual(ended.slice(2), ['d:failed:expired'], 'our answer that never reached its asker');
  c.stop();
});
