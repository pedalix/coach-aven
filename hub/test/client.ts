// A bot-side test client for the hub: connects through the Worker, answers the challenge with a test
// key, and collects frames.
import { env, exports } from 'cloudflare:workers';
import { challengeText } from '../../src/messaging/protocol.js';
import { bytesToB64u } from '../src/crypto.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Frame = Record<string, any>;
const keys = (): Record<string, { x: string; d: string }> => JSON.parse((env as unknown as { TEST_KEYS: string }).TEST_KEYS);

export async function sign(keyName: string, text: string): Promise<string> {
  const k = keys()[keyName]!;
  const key = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: k.x, d: k.d }, { name: 'Ed25519' }, false, ['sign']);
  return bytesToB64u(new Uint8Array(await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(text))));
}

export interface Client {
  ws: WebSocket;
  frames: Frame[];
  closed?: { code: number; reason: string };
  next(pred: (f: Frame) => boolean, ms?: number): Promise<Frame>;
  send(f: Frame): void;
}

export async function connect(): Promise<Client> {
  const res = await (exports as unknown as { default: { fetch(r: Request): Promise<Response> } }).default.fetch(
    new Request('https://hub.example/connect', { headers: { Upgrade: 'websocket' } }),
  );
  const ws = res.webSocket;
  if (!ws) throw new Error(`no websocket (HTTP ${res.status})`);
  ws.accept();
  const c: Client = {
    ws,
    frames: [],
    send: (f) => ws.send(JSON.stringify(f)),
    next(pred, ms = 2000) {
      let i = 0;
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

/** Connect and authenticate as `installation`, signing with `keyName` (default: its own key). */
export async function login(installation: string, keyName = installation): Promise<Client> {
  const c = await connect();
  const ch = await c.next((f) => f.t === 'challenge');
  c.send({ t: 'auth', installation, sig: await sign(keyName, challengeText('hub.example', installation, ch.nonce)) });
  await c.next((f) => f.t === 'hello' || f.t === undefined, 2000).catch(() => undefined);
  return c;
}

export async function waitClosed(c: Client, ms = 2000): Promise<{ code: number; reason: string }> {
  const t0 = Date.now();
  while (!c.closed && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 5));
  if (!c.closed) throw new Error('not closed');
  return c.closed;
}

let n = 0;
/** An envelope header with a fresh id; `ct` is opaque to the hub. */
export const envelope = (from: string, to: string, extra: Frame = {}): Frame => {
  const id = (++n).toString(16).padStart(24, '0');
  return { v: 1, id, from, to, method: 'ask', task: 'a'.repeat(24), eph: 'ZXBo', ct: 'Y2lwaGVydGV4dA', sig: 'c2ln', ...extra };
};
