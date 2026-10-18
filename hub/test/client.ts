// A bot-side test client for the hub: connects through the Worker with the name it claims (`?as=`),
// answers the challenge in version 2 with a test key, and collects frames.
import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { challengeText } from '../../src/messaging/protocol.js';
import { bytesToB64u } from '../src/crypto.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Frame = Record<string, any>;
/** An Ed25519 key as JWK halves: `x` public, `d` private. */
export interface TestKey {
  x: string;
  d: string;
}
const named = (): Record<string, TestKey> => JSON.parse((env as unknown as { TEST_KEYS: string }).TEST_KEYS);
/** A key of vitest.config.ts by name, or one a test made. */
export const keyOf = (k: string | TestKey): TestKey => (typeof k === 'string' ? named()[k]! : k);

/** A key no configuration knows: a stranger on the open hub. */
export async function freshKey(): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  return { x: jwk.x!, d: jwk.d! };
}

export async function sign(k: string | TestKey, text: string): Promise<string> {
  const { x, d } = keyOf(k);
  const key = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x, d }, { name: 'Ed25519' }, false, ['sign']);
  return bytesToB64u(new Uint8Array(await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(text))));
}

export interface Client {
  name?: string;
  ws: WebSocket;
  frames: Frame[];
  closed?: { code: number; reason: string };
  /** The first frame matching `pred` at index `from` or later. */
  next(pred: (f: Frame) => boolean, ms?: number, from?: number): Promise<Frame>;
  send(f: Frame): void;
}

export async function connect(o: { as?: string; ip?: string } = {}): Promise<Client> {
  const headers: Record<string, string> = { Upgrade: 'websocket' };
  if (o.ip) headers['CF-Connecting-IP'] = o.ip;
  const res = await (exports as unknown as { default: { fetch(r: Request): Promise<Response> } }).default.fetch(
    new Request(`https://hub.example/connect${o.as !== undefined ? `?as=${o.as}` : ''}`, { headers }),
  );
  const ws = res.webSocket;
  if (!ws) throw new Error(`no websocket (HTTP ${res.status})`);
  ws.accept();
  const c: Client = {
    ws,
    frames: [],
    send: (f) => ws.send(JSON.stringify(f)),
    next(pred, ms = 2000, from = 0) {
      let i = from;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no matching frame within ${ms} ms; got ${JSON.stringify(c.frames)}`)), ms);
        const check = (): void => {
          for (; i < c.frames.length; i++) {
            if (pred(c.frames[i]!)) {
              clearTimeout(timer);
              return resolve(c.frames[i]!);
            }
          }
          setTimeout(check, 5);
        };
        check();
      });
    },
  };
  ws.addEventListener('message', (e) => {
    const text = String(e.data);
    try {
      c.frames.push(JSON.parse(text) as Frame);
    } catch {
      c.frames.push({ raw: text }); // the runtime's own `pong`
    }
  });
  ws.addEventListener('close', (e) => {
    c.closed = { code: e.code, reason: e.reason };
  });
  return c;
}

/** Until the hub said hello or closed the socket. */
async function settled(c: Client, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!c.closed && !c.frames.some((f) => f.t === 'hello') && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 5));
}

/** Connect and authenticate as `name` with `key` (default: the test key of that name); `hint` overrides `?as=`. */
export async function login(name: string, key: string | TestKey = name, o: { ip?: string; hint?: string } = {}): Promise<Client> {
  const c = await connect({ as: o.hint ?? name, ...(o.ip ? { ip: o.ip } : {}) });
  c.name = name;
  const ch = await c.next((f) => f.t === 'challenge');
  const k = keyOf(key);
  c.send({ t: 'auth', v: 2, name, key: k.x, sig: await sign(k, challengeText('hub.example', name, k.x, ch.nonce)) });
  await settled(c);
  return c;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
/** What the hub stores as `name`'s allow list now. */
export async function storedAllow(name: string): Promise<string[]> {
  const stub = (env as Any).HUB.get((env as Any).HUB.idFromName('hub'));
  return (await (runInDurableObject as Any)(stub, (_i: unknown, state: DurableObjectState) =>
    state.storage.sql.exec(`SELECT peer FROM allow WHERE installation = ? ORDER BY peer`, name).toArray().map((r) => r.peer as string))) as string[];
}

/**
 * Send an allow list and wait until the hub stored it. The hub answers nothing when the list is unchanged,
 * and sends views only where an edge changed, so there is no frame to wait for in general.
 */
export async function allow(c: Client, installations: string[]): Promise<void> {
  c.send({ t: 'allow', installations });
  const want = JSON.stringify([...new Set(installations.filter((i) => i !== c.name))].sort());
  const t0 = Date.now();
  while (JSON.stringify(await storedAllow(c.name!)) !== want) {
    if (Date.now() - t0 > 2000) throw new Error(`allow list of ${c.name} not stored as ${want}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Make the clients' installations pin each other: every one allows all the others. */
export async function pair(...cs: Client[]): Promise<void> {
  for (const c of cs) await allow(c, cs.filter((o) => o !== c).map((o) => o.name!));
}

export async function waitClosed(c: Client, ms = 2000): Promise<{ code: number; reason: string }> {
  const t0 = Date.now();
  while (!c.closed && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 5));
  if (!c.closed) throw new Error('not closed');
  return c.closed;
}

let n = 0;
/** A version-2 wire envelope with a fresh id: installations in clear, `ct` opaque to the hub. */
export const envelope = (from: string, to: string, extra: Frame = {}): Frame => {
  const id = (++n).toString(16).padStart(24, '0');
  return { v: 2, id, from, to, eph: 'ZXBo', ct: 'Y2lwaGVydGV4dA', sig: 'c2ln', ...extra };
};
