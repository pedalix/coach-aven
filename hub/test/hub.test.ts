// The hub against OpenSpec `messaging-hub` (as `hub-open-network` changes it): one test per scenario, in
// workerd with the real Durable Object, its SQLite and WebSocket Hibernation (evictDurableObject tears
// the instance down for real). The object's storage lives across the tests of this file, so every test
// sets the allow lists it relies on.
import { env } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { allow, connect, envelope, freshKey, keyOf, login, pair, sign, waitClosed } from './client.js';
import { challengeText } from '../../src/messaging/protocol.js';
import { parseHubConfig } from '../src/config.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const stub = (): Any => (env as Any).HUB.get((env as Any).HUB.idFromName('hub'));
// runInDurableObject's overloads instantiate too deep on an untyped stub: one typed entry point.
const inHub = (fn: (instance: Any, state: DurableObjectState) => unknown): Promise<Any> => (runInDurableObject as Any)(stub(), fn);
const sql = async (query: string, ...args: unknown[]): Promise<Any[]> => (await inHub((_i, state) => state.storage.sql.exec(query, ...args).toArray())) as Any[];
const config = (): Any => parseHubConfig((env as Any).HUB_CONFIG);

describe('Installations connect outbound and prove their key', () => {
  it('Admitted installation: accepted, and its envelopes carry its own installation as sender', async () => {
    const home = await login('home');
    expect(home.frames.find((f) => f.t === 'hello')).toBeDefined();
    const bluefin = await login('bluefin');
    await pair(home, bluefin);
    // home names bluefin as the sender: the hub writes the authenticated installation.
    home.send({ t: 'send', env: envelope('bluefin', 'bluefin') });
    const d = await bluefin.next((f) => f.t === 'deliver');
    expect(d.env.from).toBe('home');
    bluefin.send({ t: 'ack', seq: d.seq });
  });

  it('Unknown or wrong key: closed before any envelope is accepted, logged without key material', async () => {
    const wrong = await login('home', 'wrong');
    expect(await waitClosed(wrong)).toEqual({ code: 4003, reason: 'reserved' });
    expect(wrong.frames.some((f) => f.t === 'hello')).toBe(false);
    // A signature that does not verify with the key the client presents.
    const forger = await connect({ as: 'home' });
    const ch = await forger.next((f) => f.t === 'challenge');
    forger.send({ t: 'auth', v: 2, name: 'home', key: keyOf('home').x, sig: await sign('wrong', challengeText('hub.example', 'home', keyOf('home').x, ch.nonce)) });
    expect(await waitClosed(forger)).toEqual({ code: 4003, reason: 'bad signature' });
    const eager = await connect({ as: 'home' });
    eager.send({ t: 'send', env: envelope('home', 'bluefin') });
    expect(await waitClosed(eager)).toEqual({ code: 4003, reason: 'not authenticated' });
    // A key past its notAfter no longer authenticates (rotation).
    const rotated = await login('bluefin', 'rotated');
    expect(await waitClosed(rotated)).toEqual({ code: 4003, reason: 'reserved' });
  });

  it('Hint and claim differ: closed before any envelope is accepted', async () => {
    const c = await login('northwind', 'northwind', { hint: 'bluefin' });
    expect(await waitClosed(c)).toEqual({ code: 4003, reason: 'hint mismatch' });
  });

  it('Version 1 client: its `auth` is refused `unsupported version`', async () => {
    const old = await connect(); // version 1 had no `?as=`
    const ch = await old.next((f) => f.t === 'challenge');
    old.send({ t: 'auth', installation: 'home', sig: await sign('home', `coach-aven-hub/1|hub.example|home|${ch.nonce}`) });
    expect(await waitClosed(old)).toEqual({ code: 4003, reason: 'unsupported version' });
  });

  it('Clocks do not matter: the challenge carries the hub’s time and a nonce, nothing to check', async () => {
    const c = await connect({ as: 'home' });
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
    await pair(second, bluefin);
    bluefin.send({ t: 'send', env: envelope('bluefin', 'home') });
    const d = await second.next((f) => f.t === 'deliver');
    second.send({ t: 'ack', seq: d.seq });
  });

  it('the alarm closes sockets that never authenticate', async () => {
    const silent = await connect({ as: 'home' });
    await silent.next((f) => f.t === 'challenge');
    await inHub((_i, state) => {
      for (const ws of state.getWebSockets()) {
        const a = ws.deserializeAttachment() as Any;
        if (!a.installation) ws.serializeAttachment({ ...a, acceptedAt: Date.now() - 11_000 });
      }
    });
    await runDurableObjectAlarm(stub());
    expect(await waitClosed(silent)).toEqual({ code: 4003, reason: 'not authenticated' });
  });
});

describe('Names are claimed first come, first served', () => {
  const quillon = freshKey();

  it('First claim: a free name is bound to the first key that claims it', async () => {
    const k = await quillon;
    const c = await login('quillon', k, { ip: '198.51.100.1' });
    expect(c.frames.find((f) => f.t === 'hello')).toBeDefined();
    expect(await sql(`SELECT name, key FROM names WHERE name = 'quillon'`)).toEqual([{ name: 'quillon', key: k.x }]);
    c.ws.close();
  });

  it('Name taken: a second key is refused, and the name stays bound to the first', async () => {
    const other = await login('quillon', await freshKey(), { ip: '198.51.100.1' });
    expect(await waitClosed(other)).toEqual({ code: 4003, reason: 'name taken' });
    expect(await sql(`SELECT key FROM names WHERE name = 'quillon'`)).toEqual([{ key: (await quillon).x }]);
    const again = await login('quillon', await quillon, { ip: '198.51.100.1' });
    expect(again.frames.find((f) => f.t === 'hello')).toBeDefined();
    again.ws.close();
  });

  it('One name per key: a key that holds a name — claimed or reserved — claims no other', async () => {
    const c = await login('quillon-2', await quillon, { ip: '198.51.100.1' });
    expect(await waitClosed(c)).toEqual({ code: 4003, reason: 'key holds a name' });
    const r = await login('home-2', 'home', { ip: '198.51.100.1' });
    expect(await waitClosed(r)).toEqual({ code: 4003, reason: 'key holds a name' });
  });

  it('Reserved name: another key cannot claim it, open registration or not, and `local`/`hub` are nobody’s', async () => {
    for (const name of ['bluefin', 'mallory', 'local', 'hub']) {
      const c = await login(name, await freshKey(), { ip: '198.51.100.2' });
      expect(await waitClosed(c), name).toEqual({ code: 4003, reason: 'reserved' });
    }
  });

  it('Closed registration: only reserved names are admitted', async () => {
    const closed = { ...config(), registration: 'closed' };
    const key = (await freshKey()).x;
    expect(await inHub((instance) => instance.admit(closed, 'kestrel', key, '198.51.100.3', Date.now()))).toBe('closed');
    expect(await inHub((instance) => instance.admit(closed, 'home', keyOf('home').x, '198.51.100.3', Date.now()))).toBeUndefined();
  });

  it('Silent name: released after the idle days, reported to those who allow it, then free to claim again', async () => {
    const k = await freshKey();
    const silent = await login('quillon-s', k, { ip: '198.51.100.4' });
    silent.ws.close();
    const bluefin = await login('bluefin');
    await allow(bluefin, ['quillon-s']);
    await sql(`UPDATE names SET last_seen = ? WHERE name = 'quillon-s'`, Date.now() - 181 * 86_400_000);
    const from = bluefin.frames.length;
    await runDurableObjectAlarm(stub());
    expect(await sql(`SELECT * FROM names WHERE name = 'quillon-s'`)).toEqual([]);
    expect(await sql(`SELECT name, reason FROM removed WHERE name = 'quillon-s'`)).toEqual([{ name: 'quillon-s', reason: 'released' }]);
    const p = await bluefin.next((f) => f.t === 'presence' && f.removed?.some((r: Any) => r.installation === 'quillon-s'), 2000, from);
    expect(p.online).not.toContain('quillon-s');
    const anew = await login('quillon-s', await freshKey(), { ip: '198.51.100.4' });
    expect(anew.frames.find((f) => f.t === 'hello')).toBeDefined();
    expect(await sql(`SELECT * FROM removed WHERE name = 'quillon-s'`)).toEqual([]);
    anew.ws.close();
    await allow(bluefin, []);
  });

  it('Claim flood: one address’s sixth new name in a day is refused; the names already bound keep working', async () => {
    const keys = await Promise.all([1, 2, 3, 4, 5, 6].map(() => freshKey()));
    for (let i = 0; i < 5; i++) {
      const c = await login(`flood-${i}`, keys[i]!, { ip: '203.0.113.9' });
      expect(c.frames.find((f) => f.t === 'hello'), `claim ${i}`).toBeDefined();
      c.ws.close();
    }
    const sixth = await login('flood-5', keys[5]!, { ip: '203.0.113.9' });
    expect(await waitClosed(sixth)).toEqual({ code: 4003, reason: 'claim limit' });
    const back = await login('flood-0', keys[0]!, { ip: '203.0.113.9' });
    expect(back.frames.find((f) => f.t === 'hello')).toBeDefined();
    back.ws.close();
  });

  it('Old configuration: the version-1 shape admits nobody, and the error names the expected shape', async () => {
    const v1 = JSON.stringify({ installations: { home: { sign: [{ key: keyOf('home').x }] } } });
    expect(() => parseHubConfig(v1)).toThrow(/version-1 shape .*"registration": "open"\|"closed"/);
    const saved = await inHub((instance) => instance.env.HUB_CONFIG);
    await inHub((instance) => void (instance.env.HUB_CONFIG = v1));
    try {
      const c = await login('home');
      expect(await waitClosed(c)).toEqual({ code: 4003, reason: 'bad config' });
    } finally {
      await inHub((instance) => void (instance.env.HUB_CONFIG = saved));
    }
  });
});

describe('Each installation tells the hub whom it hears from', () => {
  it('Peer added: from then on the peer’s envelopes are routed', async () => {
    const bluefin = await login('bluefin');
    const northwind = await login('northwind');
    await allow(bluefin, []);
    await allow(northwind, ['bluefin']);
    const before = envelope('northwind', 'bluefin');
    northwind.send({ t: 'send', env: before });
    expect(await northwind.next((f) => f.t === 'rejected' && f.id === before.id)).toEqual({ t: 'rejected', id: before.id, reason: 'unknown installation' });
    await allow(bluefin, ['northwind']);
    const after = envelope('northwind', 'bluefin');
    northwind.send({ t: 'send', env: after });
    expect(await northwind.next((f) => f.t === 'routed' && f.id === after.id)).toEqual({ t: 'routed', id: after.id });
    const d = await bluefin.next((f) => f.t === 'deliver' && f.env.id === after.id);
    bluefin.send({ t: 'ack', seq: d.seq });
  });

  it('Peer dropped: its envelopes are refused, and it stops seeing the installation online', async () => {
    const bluefin = await login('bluefin');
    const northwind = await login('northwind');
    await pair(bluefin, northwind);
    await northwind.next((f) => f.t === 'presence' && f.online.includes('bluefin'));
    const from = northwind.frames.length;
    await allow(bluefin, []);
    await northwind.next((f) => f.t === 'presence' && !f.online.includes('bluefin'), 2000, from);
    const e = envelope('northwind', 'bluefin');
    northwind.send({ t: 'send', env: e });
    expect(await northwind.next((f) => f.t === 'rejected' && f.id === e.id)).toEqual({ t: 'rejected', id: e.id, reason: 'unknown installation' });
  });

  it('Before any list: a newly named installation hears from nobody', async () => {
    const fresh = await login('quillon-b', await freshKey(), { ip: '198.51.100.5' });
    const home = await login('home');
    await allow(home, ['quillon-b']);
    const e = envelope('home', 'quillon-b');
    home.send({ t: 'send', env: e });
    expect(await home.next((f) => f.t === 'rejected' && f.id === e.id)).toEqual({ t: 'rejected', id: e.id, reason: 'unknown installation' });
    fresh.ws.close();
    await allow(home, []);
  });
});

describe('The hub routes only to installations that accept the sender', () => {
  it('Routed: stored, delivered to a connected recipient, the sender told `routed`', async () => {
    const home = await login('home');
    const bluefin = await login('bluefin');
    await pair(home, bluefin);
    const e = envelope('home', 'bluefin');
    home.send({ t: 'send', env: e });
    expect(await home.next((f) => f.t === 'routed' && f.id === e.id)).toEqual({ t: 'routed', id: e.id });
    const d = await bluefin.next((f) => f.t === 'deliver' && f.env.id === e.id);
    expect(typeof d.seq).toBe('number');
    bluefin.send({ t: 'ack', seq: d.seq });
  });

  it('Recipient does not allow the sender: nothing stored, the same answer as for a name nobody holds', async () => {
    const home = await login('home');
    const northwind = await login('northwind');
    await allow(northwind, []);
    const e = envelope('home', 'northwind');
    home.send({ t: 'send', env: e });
    expect(await home.next((f) => f.t === 'rejected' && f.id === e.id)).toEqual({ t: 'rejected', id: e.id, reason: 'unknown installation' });
    const nobody = envelope('home', 'kestrel');
    home.send({ t: 'send', env: nobody });
    expect(await home.next((f) => f.t === 'rejected' && f.id === nobody.id)).toEqual({ t: 'rejected', id: nobody.id, reason: 'unknown installation' });
    expect(await sql(`SELECT * FROM outbox WHERE env_id IN (?, ?)`, e.id, nobody.id)).toEqual([]);
  });

  it('an envelope of another version is refused, never guessed at', async () => {
    const home = await login('home');
    for (const v of [1, 3]) {
      const e = envelope('home', 'bluefin', { v });
      home.send({ t: 'send', env: e });
      expect(await home.next((f) => f.t === 'rejected' && f.id === e.id)).toEqual({ t: 'rejected', id: e.id, reason: 'unsupported version' });
    }
  });

  it('Installation removed: the name revoked — refused, its outbox dropped, envelopes for it refused, reported to those who allow it', async () => {
    const home = await login('home');
    const northwind = await login('northwind');
    await pair(home, northwind);
    const e = envelope('home', 'northwind');
    home.send({ t: 'send', env: e });
    await home.next((f) => f.t === 'routed' && f.id === e.id);
    await northwind.next((f) => f.t === 'deliver' && f.env.id === e.id); // not acked: it stays in the outbox
    const from = home.frames.length;
    // A deploy that reserves northwind for nobody: what the constructor runs on the first request after it.
    const revoked = { ...config(), reserved: { ...config().reserved, northwind: null } };
    await inHub((instance) => instance.alignWithConfig(revoked));
    expect(await waitClosed(northwind)).toEqual({ code: 4003, reason: 'removed' });
    const p = await home.next((f) => f.t === 'presence' && f.removed?.some((r: Any) => r.installation === 'northwind'), 2000, from);
    expect(p.online).not.toContain('northwind');
    expect(await sql(`SELECT * FROM outbox WHERE installation = 'northwind'`)).toEqual([]);
    const e2 = envelope('home', 'northwind');
    home.send({ t: 'send', env: e2 });
    expect(await home.next((f) => f.t === 'rejected' && f.id === e2.id)).toEqual({ t: 'rejected', id: e2.id, reason: 'unknown installation' });
    const later = await login('home');
    expect(later.frames.find((f) => f.t === 'hello')?.removed).toMatchObject([{ installation: 'northwind' }]);
    // Reserved for its key again (the test configuration): admitted, and the tombstone goes.
    const back = await login('northwind');
    expect(back.frames.find((f) => f.t === 'hello')).toBeDefined();
    expect(await sql(`SELECT * FROM removed WHERE name = 'northwind'`)).toEqual([]);
  });
});

describe('Delivery survives disconnects', () => {
  it('Recipient offline: kept, delivered once with its seq on the next connection, deleted on ack', async () => {
    const home = await login('home');
    const northwind = await login('northwind');
    await pair(home, northwind);
    northwind.ws.close();
    await waitClosed(northwind).catch(() => undefined);
    const e = envelope('home', 'northwind');
    home.send({ t: 'send', env: e });
    await home.next((f) => f.t === 'routed' && f.id === e.id);
    const back = await login('northwind');
    const d = await back.next((f) => f.t === 'deliver' && f.env.id === e.id);
    back.send({ t: 'ack', seq: d.seq });
    await new Promise((r) => setTimeout(r, 50));
    expect(await sql(`SELECT * FROM outbox WHERE env_id = ?`, e.id)).toEqual([]);
  });

  it('Duplicate after reconnect: re-sent with the same seq; a re-sent envelope id is stored once', async () => {
    const home = await login('home');
    const northwind = await login('northwind');
    await pair(home, northwind);
    northwind.ws.close();
    await waitClosed(northwind).catch(() => undefined);
    const e = envelope('home', 'northwind');
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

  it('Expired undelivered: dropped, and the sender told the envelope id on its next connection', async () => {
    const home = await login('home');
    const northwind = await login('northwind');
    await pair(home, northwind);
    northwind.ws.close();
    await waitClosed(northwind).catch(() => undefined);
    const e = envelope('home', 'northwind');
    home.send({ t: 'send', env: e });
    await home.next((f) => f.t === 'routed' && f.id === e.id);
    home.ws.close();
    await waitClosed(home).catch(() => undefined);
    await sql(`UPDATE outbox SET expires_at = 0 WHERE env_id = ?`, e.id);
    await runDurableObjectAlarm(stub());
    expect(await sql(`SELECT * FROM outbox WHERE env_id = ?`, e.id)).toEqual([]);
    const back = await login('home');
    expect(await back.next((f) => f.t === 'expired')).toEqual({ t: 'expired', id: e.id });
  });

  it('Backlog cap: at 1000 undelivered envelopes, further ones are `rejected: backlog`', async () => {
    await inHub((_i, state) => {
      for (let i = 0; i < 1000; i++) {
        state.storage.sql.exec(
          `INSERT INTO outbox (installation, seq, env_id, sender, size, routed_at, expires_at, env) VALUES ('northwind', ?, ?, ?, 10, 0, ?, '{}')`,
          100_000 + i, `f${String(i).padStart(23, '0')}`, `sender-${i % 10}`, Date.now() + 86_400_000,
        );
      }
    });
    const home = await login('home');
    const northwind = await login('northwind');
    await pair(home, northwind);
    const e = envelope('home', 'northwind');
    home.send({ t: 'send', env: e });
    expect(await home.next((f) => f.t === 'rejected' && f.id === e.id)).toEqual({ t: 'rejected', id: e.id, reason: 'backlog' });
    await sql(`DELETE FROM outbox WHERE installation = 'northwind'`);
  });

  it('Backlog per sender: 200 from one sender fill its share; another sender is still routed', async () => {
    await inHub((_i, state) => {
      for (let i = 0; i < 210; i++) {
        state.storage.sql.exec(
          `INSERT INTO outbox (installation, seq, env_id, sender, size, routed_at, expires_at, env) VALUES ('bluefin', ?, ?, ?, 10, 0, ?, '{}')`,
          200_000 + i, `e${String(i).padStart(23, '0')}`, i < 200 ? 'northwind' : 'kestrel', Date.now() + 86_400_000,
        );
      }
    });
    const home = await login('home');
    const bluefin = await login('bluefin');
    const northwind = await login('northwind');
    await allow(bluefin, ['home', 'northwind']);
    await allow(northwind, ['bluefin']);
    await allow(home, ['bluefin']);
    const full = envelope('northwind', 'bluefin');
    northwind.send({ t: 'send', env: full });
    expect(await northwind.next((f) => f.t === 'rejected' && f.id === full.id)).toEqual({ t: 'rejected', id: full.id, reason: 'backlog' });
    const other = envelope('home', 'bluefin');
    home.send({ t: 'send', env: other });
    expect(await home.next((f) => f.t === 'routed' && f.id === other.id)).toEqual({ t: 'routed', id: other.id });
    await sql(`DELETE FROM outbox WHERE installation = 'bluefin'`);
  });
});

describe('The hub sees routing metadata only', () => {
  it('Stored envelope: ciphertext, the two installations, id, size and times; a field the hub does not know is not stored or forwarded', async () => {
    const home = await login('home');
    const northwind = await login('northwind');
    await pair(home, northwind);
    northwind.ws.close();
    await waitClosed(northwind).catch(() => undefined);
    const e = envelope('home', 'northwind', { note: 'Which orders of caldora failed today?', method: 'ask', task: 'a'.repeat(24) });
    home.send({ t: 'send', env: e });
    await home.next((f) => f.t === 'routed' && f.id === e.id);
    const [row] = await sql(`SELECT * FROM outbox WHERE env_id = ?`, e.id);
    expect(Object.keys(row).sort()).toEqual(['env', 'env_id', 'expires_at', 'installation', 'routed_at', 'sender', 'seq', 'size']);
    expect(row.env).not.toContain('Which orders');
    expect(Object.keys(JSON.parse(row.env)).sort()).toEqual(['ct', 'eph', 'from', 'id', 'sig', 'to', 'v']);
    await sql(`DELETE FROM outbox WHERE env_id = ?`, e.id);
  });

  it('Hub logs: routed, rejected and expired lines name installations, the envelope id and the size, never an agent, method or task', async () => {
    const lines: Any[] = [];
    const keep = (...a: unknown[]): void => void lines.push(JSON.parse(String(a[0])));
    const spies = [vi.spyOn(console, 'log').mockImplementation(keep), vi.spyOn(console, 'warn').mockImplementation(keep)];
    try {
      const home = await login('home');
      const e = envelope('home', 'kestrel', { method: 'ask', task: 'a'.repeat(24) });
      home.send({ t: 'send', env: e });
      await home.next((f) => f.t === 'rejected' && f.id === e.id);
    } finally {
      for (const s of spies) s.mockRestore();
    }
    const rejected = lines.find((l) => l.event === 'hub.rejected');
    expect(rejected).toMatchObject({ event: 'hub.rejected', from: 'home', to: 'kestrel', reason: 'unknown installation', size: expect.any(Number) });
    for (const l of lines) for (const k of ['method', 'task', 'agent']) expect(l, JSON.stringify(l)).not.toHaveProperty(k);
  });
});

describe('Idle connections cost nothing', () => {
  it('Wake on message: after an eviction, an envelope is routed over the existing connections', async () => {
    const home = await login('home');
    const bluefin = await login('bluefin');
    await pair(home, bluefin);
    home.ws.send('ping'); // answered by the runtime, the object stays asleep
    await home.next((f) => f.raw === 'pong');
    await evictDurableObject(stub(), { webSockets: 'hibernate' });
    home.send({ t: 'send', env: envelope('home', 'bluefin') });
    const d = await bluefin.next((f) => f.t === 'deliver');
    expect(home.closed).toBeUndefined();
    expect(bluefin.closed).toBeUndefined();
    bluefin.send({ t: 'ack', seq: d.seq });
  });
});

describe('Presence', () => {
  it('Peer goes away: those it has a relationship with get a presence event without it', async () => {
    const home = await login('home');
    const northwind = await login('northwind');
    await pair(home, northwind);
    await home.next((f) => f.t === 'presence' && f.online.includes('northwind'));
    const from = home.frames.length;
    northwind.ws.close();
    const p = await home.next((f) => f.t === 'presence' && !f.online.includes('northwind'), 2000, from);
    expect(p.online).not.toContain('home');
  });

  it('One-sided allow list: home allows northwind, northwind does not allow home — home never sees it come or go', async () => {
    const northwind = await login('northwind');
    await allow(northwind, []); // first: an earlier test left it allowing home
    const home = await login('home');
    await allow(home, ['northwind']);
    northwind.ws.close();
    await waitClosed(northwind).catch(() => undefined);
    const again = await login('northwind');
    again.ws.close();
    await new Promise((r) => setTimeout(r, 50));
    for (const f of home.frames) if (f.t === 'presence' || f.t === 'hello') expect(f.online).not.toContain('northwind');
    await allow(home, []);
  });

  it('Nothing about strangers: a newly named installation’s hello names no other installation', async () => {
    const c = await login('quillon-n', await freshKey(), { ip: '198.51.100.6' });
    const hello = c.frames.find((f) => f.t === 'hello')!;
    expect(hello).toMatchObject({ online: [], removed: [] });
    expect(hello).not.toHaveProperty('enrolled');
    c.ws.close();
  });
});

describe('Storage', () => {
  it('the schema is versioned; a version-1 store migrates to version 2, its rows dropped', async () => {
    await login('home');
    expect(await sql(`SELECT v FROM meta WHERE k = 'schema_version'`)).toEqual([{ v: '2' }]);
    const migrated = await inHub((instance, state) => {
      const q = state.storage.sql;
      q.exec(`UPDATE meta SET v = '1' WHERE k = 'schema_version'`);
      q.exec(`DROP TABLE outbox`);
      q.exec(`CREATE TABLE outbox (installation TEXT NOT NULL, seq INTEGER NOT NULL, env_id TEXT NOT NULL, sender TEXT NOT NULL,
        to_addr TEXT NOT NULL, method TEXT NOT NULL, task TEXT NOT NULL, size INTEGER NOT NULL, routed_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, env TEXT NOT NULL, PRIMARY KEY (installation, seq))`);
      q.exec(`INSERT INTO outbox VALUES ('bluefin', 1, 'x', 'home', 'bluefin/caldora', 'ask', 't', 1, 0, 0, '{}')`);
      q.exec(`CREATE TABLE enrolled (installation TEXT PRIMARY KEY)`);
      return instance.store.migrate();
    });
    expect(migrated).toEqual({ from: 1, to: 2 });
    expect(await sql(`SELECT * FROM outbox`)).toEqual([]);
    expect((await sql(`PRAGMA table_info(outbox)`)).map((c: Any) => c.name)).not.toContain('method');
    expect(await sql(`SELECT name FROM sqlite_master WHERE name = 'enrolled'`)).toEqual([]);
  });
});
