// The hub against OpenSpec `messaging-hub`: one test per scenario, in workerd with the real Durable
// Object, its SQLite and WebSocket Hibernation (evictDurableObject tears the instance down for real).
import { env } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { connect, envelope, login, sign, waitClosed } from './client.js';
import { challengeText } from '../../src/messaging/protocol.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const stub = (): Any => (env as Any).HUB.get((env as Any).HUB.idFromName('hub'));
// runInDurableObject's overloads instantiate too deep on an untyped stub: one typed entry point.
const inHub = (fn: (instance: Any, state: DurableObjectState) => unknown): Promise<Any> => (runInDurableObject as Any)(stub(), fn);
const sql = async (query: string, ...args: unknown[]): Promise<Any[]> => (await inHub((_i, state) => state.storage.sql.exec(query, ...args).toArray())) as Any[];

describe('Installations connect outbound and prove their key', () => {
  it('Enrolled installation: accepted, and its envelopes carry its own installation as sender', async () => {
    const home = await login('home');
    expect(home.frames.find((f) => f.t === 'hello')).toMatchObject({ t: 'hello', enrolled: ['bluefin', 'home', 'northwind'] });
    const bluefin = await login('bluefin');
    // home claims to be bluefin in `from`: the hub writes the authenticated installation.
    home.send({ t: 'send', env: envelope('bluefin/caldora', 'bluefin/caldora') });
    const d = await bluefin.next((f) => f.t === 'deliver');
    expect(d.env.from).toBe('home/caldora');
    bluefin.send({ t: 'ack', seq: d.seq });
  });

  it('Unknown or wrong key: closed before any envelope is accepted', async () => {
    const wrong = await login('home', 'wrong');
    expect(await waitClosed(wrong)).toEqual({ code: 4003, reason: 'bad_sig' });
    expect(wrong.frames.some((f) => f.t === 'hello')).toBe(false);
    const stranger = await connect();
    const ch = await stranger.next((f) => f.t === 'challenge');
    stranger.send({ t: 'auth', installation: 'mallory', sig: await sign('home', challengeText('hub.example', 'mallory', ch.nonce)) });
    expect(await waitClosed(stranger)).toEqual({ code: 4003, reason: 'unknown' });
    const eager = await connect();
    eager.send({ t: 'send', env: envelope('home/x', 'bluefin/caldora') });
    expect(await waitClosed(eager)).toEqual({ code: 4003, reason: 'not_authenticated' });
    // A key past its notAfter no longer authenticates (rotation).
    const rotated = await login('bluefin', 'rotated');
    expect(await waitClosed(rotated)).toEqual({ code: 4003, reason: 'bad_sig' });
  });

  it('Clocks do not matter: the challenge carries the hub’s time and a nonce, nothing to check', async () => {
    const c = await connect();
    const ch = await c.next((f) => f.t === 'challenge');
    expect(Object.keys(ch).sort()).toEqual(['nonce', 'now', 't']);
    expect(Number.isNaN(Date.parse(ch.now))).toBe(false);
    c.ws.close();
  });

  it('Second connection: the older one is closed `replaced`, delivery continues on the new one', async () => {
    const first = await login('home');
    const second = await login('home');
    expect(await waitClosed(first)).toEqual({ code: 4000, reason: 'replaced' });
    const bluefin = await login('bluefin');
    bluefin.send({ t: 'send', env: envelope('bluefin/caldora', 'home/owen-ops', { method: 'answer' }) });
    const d = await second.next((f) => f.t === 'deliver');
    second.send({ t: 'ack', seq: d.seq });
  });

  it('the alarm closes sockets that never authenticate', async () => {
    const silent = await connect();
    await silent.next((f) => f.t === 'challenge');
    await inHub((_i, state) => {
      for (const ws of state.getWebSockets()) {
        const a = ws.deserializeAttachment() as Any;
        if (!a.installation) ws.serializeAttachment({ ...a, acceptedAt: Date.now() - 11_000 });
      }
    });
    await runDurableObjectAlarm(stub());
    expect(await waitClosed(silent)).toEqual({ code: 4003, reason: 'not_authenticated' });
  });
});

describe('Storage', () => {
  it('the schema is versioned and migrated on the first request', async () => {
    await login('home');
    expect(await sql(`SELECT v FROM meta WHERE k = 'schema_version'`)).toEqual([{ v: '1' }]);
  });
});

describe('Idle connections cost nothing', () => {
  it('Wake on message: after an eviction, an envelope is routed over the existing connections', async () => {
    const home = await login('home');
    const bluefin = await login('bluefin');
    home.ws.send('ping'); // answered by the runtime, the object stays asleep
    await home.next((f) => f.raw === 'pong');
    await evictDurableObject(stub(), { webSockets: 'hibernate' });
    home.send({ t: 'send', env: envelope('home/owen-ops', 'bluefin/caldora') });
    const d = await bluefin.next((f) => f.t === 'deliver');
    expect(home.closed).toBeUndefined();
    expect(bluefin.closed).toBeUndefined();
    bluefin.send({ t: 'ack', seq: d.seq });
  });
});

describe('The hub routes between enrolled installations only', () => {
  it('Routed: stored, delivered to a connected recipient, the sender told `routed`', async () => {
    const home = await login('home');
    const bluefin = await login('bluefin');
    const e = envelope('home/owen-ops', 'bluefin/caldora');
    home.send({ t: 'send', env: e });
    expect(await home.next((f) => f.t === 'routed' && f.id === e.id)).toEqual({ t: 'routed', id: e.id });
    const d = await bluefin.next((f) => f.t === 'deliver' && f.env.id === e.id);
    expect(typeof d.seq).toBe('number');
    bluefin.send({ t: 'ack', seq: d.seq });
  });

  it('Unknown recipient: nothing stored, `rejected: unknown installation`', async () => {
    const home = await login('home');
    const e = envelope('home/owen-ops', 'mallory/x');
    home.send({ t: 'send', env: e });
    expect(await home.next((f) => f.t === 'rejected')).toEqual({ t: 'rejected', id: e.id, reason: 'unknown installation' });
    expect(await sql(`SELECT * FROM outbox WHERE installation = 'mallory'`)).toEqual([]);
  });

  it('an unknown envelope version is refused, never guessed at', async () => {
    const home = await login('home');
    const e = envelope('home/owen-ops', 'bluefin/caldora', { v: 2 });
    home.send({ t: 'send', env: e });
    expect(await home.next((f) => f.t === 'rejected')).toEqual({ t: 'rejected', id: e.id, reason: 'unsupported version' });
  });

  it('Backlog cap: at 1000 undelivered envelopes, further ones are `rejected: backlog`', async () => {
    await inHub((_i, state) => {
      for (let i = 0; i < 1000; i++) {
        state.storage.sql.exec(
          `INSERT INTO outbox (installation, seq, env_id, sender, to_addr, method, task, size, routed_at, expires_at, env) VALUES ('northwind', ?, ?, 'home', 'northwind/ledger', 'ask', ?, 10, 0, ?, '{}')`,
          100_000 + i, `f${String(i).padStart(23, '0')}`, 'b'.repeat(24), Date.now() + 86_400_000,
        );
      }
    });
    const home = await login('home');
    const e = envelope('home/owen-ops', 'northwind/ledger');
    home.send({ t: 'send', env: e });
    expect(await home.next((f) => f.t === 'rejected')).toEqual({ t: 'rejected', id: e.id, reason: 'backlog' });
    await sql(`DELETE FROM outbox WHERE installation = 'northwind'`);
  });
});

describe('Delivery survives disconnects', () => {
  it('Recipient offline: kept, delivered once with its seq on the next connection, deleted on ack', async () => {
    const home = await login('home');
    const e = envelope('bluefin/caldora', 'northwind/ledger');
    home.send({ t: 'send', env: e });
    await home.next((f) => f.t === 'routed' && f.id === e.id);
    const northwind = await login('northwind');
    const d = await northwind.next((f) => f.t === 'deliver' && f.env.id === e.id);
    northwind.send({ t: 'ack', seq: d.seq });
    await new Promise((r) => setTimeout(r, 50));
    expect(await sql(`SELECT * FROM outbox WHERE env_id = ?`, e.id)).toEqual([]);
  });

  it('Duplicate after reconnect: re-sent with the same seq; a re-sent envelope id is stored once', async () => {
    const home = await login('home');
    const e = envelope('home/owen-ops', 'northwind/ledger');
    home.send({ t: 'send', env: e });
    await home.next((f) => f.t === 'routed' && f.id === e.id);
    home.send({ t: 'send', env: e }); // the sender re-sends after its own restart
    await home.next((f) => f.t === 'routed' && f.id === e.id && home.frames.filter((x) => x.t === 'routed' && x.id === e.id).length === 2);
    expect((await sql(`SELECT seq FROM outbox WHERE env_id = ?`, e.id)).length).toBe(1);
    const first = await login('northwind');
    const d1 = await first.next((f) => f.t === 'deliver' && f.env.id === e.id);
    first.ws.close(); // no ack
    await waitClosed(first).catch(() => undefined);
    const again = await login('northwind');
    const d2 = await again.next((f) => f.t === 'deliver' && f.env.id === e.id);
    expect(d2.seq).toBe(d1.seq);
    again.send({ t: 'ack', seq: d2.seq });
  });

  it('Expired undelivered: dropped, and the sender told on its next connection', async () => {
    const home = await login('home');
    const e = envelope('home/owen-ops', 'northwind/ledger');
    home.send({ t: 'send', env: e });
    await home.next((f) => f.t === 'routed' && f.id === e.id);
    home.ws.close();
    await waitClosed(home).catch(() => undefined);
    await sql(`UPDATE outbox SET expires_at = 0 WHERE env_id = ?`, e.id);
    await runDurableObjectAlarm(stub());
    expect(await sql(`SELECT * FROM outbox WHERE env_id = ?`, e.id)).toEqual([]);
    const back = await login('home');
    expect(await back.next((f) => f.t === 'expired')).toEqual({ t: 'expired', id: e.id, task: e.task, to: 'northwind/ledger' });
  });
});

describe('The hub sees routing metadata only', () => {
  it('Stored envelope: ciphertext and routing fields; a field the hub does not know is not stored or forwarded', async () => {
    const home = await login('home');
    const e = envelope('home/owen-ops', 'northwind/ledger', { note: 'Which orders of caldora failed today?' });
    home.send({ t: 'send', env: e });
    await home.next((f) => f.t === 'routed' && f.id === e.id);
    const [row] = await sql(`SELECT * FROM outbox WHERE env_id = ?`, e.id);
    expect(Object.keys(row).sort()).toEqual(['env', 'env_id', 'expires_at', 'installation', 'method', 'routed_at', 'sender', 'seq', 'size', 'task', 'to_addr']);
    expect(row.env).not.toContain('Which orders');
    expect(Object.keys(JSON.parse(row.env)).sort()).toEqual(['ct', 'eph', 'from', 'id', 'method', 'sig', 'task', 'to', 'v']);
    await sql(`DELETE FROM outbox WHERE env_id = ?`, e.id);
  });
});

describe('Presence and removal', () => {
  it('Peer goes away: connected installations get a presence event without it', async () => {
    const home = await login('home');
    const northwind = await login('northwind');
    await home.next((f) => f.t === 'presence' && f.online.includes('northwind'));
    northwind.ws.close();
    const p = await home.next((f) => f.t === 'presence' && !f.online.includes('northwind'));
    expect(p.online).toContain('home');
  });

  it('Installation removed: refused, its outbox dropped, envelopes for it rejected, reported to everyone', async () => {
    const home = await login('home');
    const northwind = await login('northwind');
    const e = envelope('home/owen-ops', 'northwind/ledger');
    home.send({ t: 'send', env: e });
    await home.next((f) => f.t === 'routed' && f.id === e.id);
    northwind.ws.close(); // offline, so the envelope waits in its outbox
    await home.next((f) => f.t === 'presence' && !f.online.includes('northwind'));
    const live = await login('northwind'); // ...and back, without acking it
    await live.next((f) => f.t === 'deliver' && f.env.id === e.id);
    // A deploy without northwind in HUB_CONFIG: what the constructor runs on the first request after it.
    await inHub((instance) => instance.alignEnrolment(['home', 'bluefin']));
    expect(await waitClosed(live)).toEqual({ code: 4003, reason: 'removed' });
    const p = await home.next((f) => f.t === 'presence' && f.removed?.some((r: Any) => r.installation === 'northwind'));
    expect(p.online).not.toContain('northwind');
    expect(await sql(`SELECT * FROM outbox WHERE installation = 'northwind'`)).toEqual([]);
    const gone = await login('northwind');
    expect(await waitClosed(gone)).toEqual({ code: 4003, reason: 'unknown' });
    const e2 = envelope('home/owen-ops', 'northwind/ledger');
    home.send({ t: 'send', env: e2 });
    expect(await home.next((f) => f.t === 'rejected' && f.id === e2.id)).toEqual({ t: 'rejected', id: e2.id, reason: 'unknown installation' });
    const later = await login('bluefin');
    expect(later.frames.find((f) => f.t === 'hello')?.removed).toMatchObject([{ installation: 'northwind' }]);
    // Re-enrolment lifts the tombstone (and keeps other tests independent).
    await inHub((instance) => instance.alignEnrolment(['home', 'bluefin', 'northwind']));
    expect(await sql(`SELECT * FROM removed`)).toEqual([]);
  });
});
