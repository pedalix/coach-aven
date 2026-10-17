// The hub (OpenSpec `messaging-hub`, design D3–D5): one Durable Object that every installation's bot
// keeps one outbound WebSocket to. It authenticates installations with a signed challenge, routes
// sealed envelopes it cannot read between enrolled installations, keeps them until the recipient acks,
// and reports presence, removals and expiries. It decides nothing about which agent may ask which.
//
// Stateless in memory on purpose: connections are found through their sockets' attachments
// (WebSocket Hibernation), everything else is in SQLite (store.ts). So an eviction between messages
// loses nothing, and keep-alive pings are answered by the runtime without waking the object.
import { DurableObject } from 'cloudflare:workers';
import { challengeText, parseAddress, parseClientFrame, parseEnvelope, type Envelope, type HubFrame } from '../../src/messaging/protocol.js';
import { keysValidAt, parseHubConfig, type HubConfig } from './config.js';
import { randomNonce, verifyEd25519 } from './crypto.js';
import { HubStore } from './store.js';

export interface Env {
  HUB: DurableObjectNamespace<Hub>;
  /** Secret: {installations: {<id>: {sign: [{key, notAfter?}]}}}. */
  HUB_CONFIG: string;
  /** Envelope expiry in days (default 7). */
  HUB_EXPIRY_DAYS?: string;
}

interface Attachment {
  nonce: string;
  host: string;
  acceptedAt: number;
  installation?: string;
  authedAt?: number;
}

const DAY_MS = 86_400_000;
const AUTH_TIMEOUT_MS = 10_000;
const BACKLOG_COUNT = 1000;
const BACKLOG_BYTES = 50 * 1024 * 1024;

const log = (level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}): void => {
  const line = JSON.stringify({ event, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

export class Hub extends DurableObject<Env> {
  private readonly store: HubStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new HubStore(ctx.storage.sql);
    // Keep-alives never wake the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    // First request after a deploy: migrate, then align with the configuration (removals).
    void ctx.blockConcurrencyWhile(async () => {
      const migrated = this.store.migrate();
      if (migrated) log('info', 'hub.schema.migrated', migrated);
      const gone = this.store.syncEnrolment(Object.keys(this.config().installations), new Date().toISOString());
      for (const i of gone) {
        log('warn', 'hub.installation.removed', { installation: i });
        for (const ws of this.ctx.getWebSockets()) if (this.att(ws).installation === i) ws.close(4003, 'removed');
      }
      if (gone.length) this.broadcastPresence();
    });
  }

  private config(): HubConfig {
    return parseHubConfig(this.env.HUB_CONFIG);
  }
  private expiryMs(): number {
    const d = Number(this.env.HUB_EXPIRY_DAYS ?? 7);
    return (Number.isFinite(d) && d > 0 ? d : 7) * DAY_MS;
  }
  private att(ws: WebSocket): Attachment {
    return (ws.deserializeAttachment() ?? {}) as Attachment;
  }
  private send(ws: WebSocket, frame: HubFrame): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      /* closing: its outbox waits for the next connection */
    }
  }
  /** The installation's live connection: the most recently authenticated one. */
  private socketOf(installation: string): WebSocket | undefined {
    let best: WebSocket | undefined;
    let at = -1;
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.att(ws);
      if (a.installation === installation && (a.authedAt ?? 0) > at) {
        best = ws;
        at = a.authedAt ?? 0;
      }
    }
    return best;
  }
  private online(): string[] {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const i = this.att(ws).installation;
      if (i) ids.add(i);
    }
    return [...ids].sort();
  }
  private broadcastPresence(): void {
    const frame: HubFrame = { t: 'presence', online: this.online(), removed: this.store.removedList() };
    for (const ws of this.ctx.getWebSockets()) if (this.att(ws).installation) this.send(ws, frame);
  }
  private async ensureAlarm(at: number): Promise<void> {
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || at < cur) await this.ctx.storage.setAlarm(at);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected a WebSocket upgrade', { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const nonce = randomNonce();
    server.serializeAttachment({ nonce, host: new URL(request.url).host, acceptedAt: Date.now() } satisfies Attachment);
    this.send(server, { t: 'challenge', nonce, now: new Date().toISOString() });
    await this.ensureAlarm(Date.now() + AUTH_TIMEOUT_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  private refuse(ws: WebSocket, reason: 'bad_sig' | 'unknown' | 'not_authenticated', installation?: string): void {
    // Logged without key material (no signature, no key).
    log('error', 'hub.auth.refused', { reason, ...(installation ? { installation } : {}) });
    ws.close(4003, reason);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
    } catch {
      raw = undefined;
    }
    const frame = parseClientFrame(raw);
    const a = this.att(ws);
    if (!a.installation) {
      if (frame?.t !== 'auth') return this.refuse(ws, 'not_authenticated');
      return this.authenticate(ws, a, frame.installation, frame.sig);
    }
    if (!frame) return; // a kind this hub does not know: ignored (additive protocol)
    if (frame.t === 'send') return this.route(ws, a.installation, frame.env);
    if (frame.t === 'ack') return this.store.ack(a.installation, frame.seq);
    // a second `auth` on an authenticated socket changes nothing
  }

  private async authenticate(ws: WebSocket, a: Attachment, installation: string, sig: string): Promise<void> {
    const removed = this.store.removedList().some((r) => r.installation === installation);
    const keys = removed ? [] : keysValidAt(this.config(), installation, Date.now());
    if (!keys.length) return this.refuse(ws, 'unknown', installation);
    const text = challengeText(a.host, installation, a.nonce);
    let ok = false;
    for (const k of keys) if ((ok = await verifyEd25519(k.key, text, sig))) break;
    if (!ok) return this.refuse(ws, 'bad_sig', installation);
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws && this.att(other).installation === installation) {
        other.serializeAttachment({ ...this.att(other), installation: undefined });
        other.close(4000, 'replaced');
        log('warn', 'hub.replaced', { installation });
      }
    }
    ws.serializeAttachment({ ...a, installation, authedAt: Date.now() } satisfies Attachment);
    this.send(ws, { t: 'hello', now: new Date().toISOString(), enrolled: Object.keys(this.config().installations).sort(), online: this.online(), removed: this.store.removedList() });
    for (const row of this.store.pendingFor(installation)) this.send(ws, { t: 'deliver', seq: row.seq, env: JSON.parse(row.env) as Record<string, unknown> });
    for (const r of this.store.expiredFor(installation)) {
      this.send(ws, { t: 'expired', id: r.env_id, task: r.task, to: r.to_addr });
      this.store.clearExpired(r.env_id);
    }
    this.broadcastPresence();
  }

  private async route(ws: WebSocket, sender: string, rawEnv: Record<string, unknown>): Promise<void> {
    const id = typeof rawEnv.id === 'string' ? rawEnv.id : '';
    const reject = (reason: string, to?: string): void => {
      log('warn', 'hub.rejected', { from: sender, ...(to ? { to } : {}), method: rawEnv.method, reason });
      this.send(ws, { t: 'rejected', id, reason });
    };
    const parsed = parseEnvelope(rawEnv);
    if (!parsed.ok) return reject(parsed.reason === 'unsupported version' ? 'unsupported version' : 'malformed');
    const env = parsed.env;
    // The sender installation is the authenticated one, whatever the envelope names; the agent part stays.
    const from = `${sender}/${parseAddress(env.from)!.agent}`;
    const to = parseAddress(env.to)!;
    const removed = this.store.removedList().some((r) => r.installation === to.installation);
    if (!(to.installation in this.config().installations) || removed) return reject('unknown installation', env.to);
    if (this.store.wasRouted(env.id)) return this.send(ws, { t: 'routed', id: env.id }); // re-sent after a restart
    // Only the known fields travel on: routing header, ephemeral key, ciphertext, signature.
    const stored: Envelope = { v: env.v, id: env.id, from, to: env.to, method: env.method, task: env.task };
    if (env.eph !== undefined) stored.eph = env.eph;
    if (env.ct !== undefined) stored.ct = env.ct;
    if (env.sig !== undefined) stored.sig = env.sig;
    const text = JSON.stringify(stored);
    const backlog = this.store.outboxSize(to.installation);
    if (backlog.count >= BACKLOG_COUNT || backlog.bytes + text.length > BACKLOG_BYTES) return reject('backlog', env.to);
    const now = Date.now();
    const row = this.store.append({
      installation: to.installation,
      env_id: env.id,
      sender,
      to_addr: env.to,
      method: env.method,
      task: env.task,
      size: text.length,
      routed_at: now,
      expires_at: now + this.expiryMs(),
      env: text,
    });
    this.send(ws, { t: 'routed', id: env.id });
    const peer = this.socketOf(to.installation);
    if (peer) this.send(peer, { t: 'deliver', seq: row.seq, env: stored as unknown as Record<string, unknown> });
    await this.ensureAlarm(row.expires_at);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    if (this.att(ws).installation) {
      ws.serializeAttachment({ ...this.att(ws), installation: undefined });
      this.broadcastPresence();
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    for (const r of this.store.expire(now)) {
      log('info', 'hub.expired', { from: r.sender, to: r.to_addr, task: r.task, env_id: r.env_id });
      const ws = this.socketOf(r.sender);
      if (ws) {
        this.send(ws, { t: 'expired', id: r.env_id, task: r.task, to: r.to_addr });
        this.store.clearExpired(r.env_id);
      }
    }
    this.store.forgetRouted(now - this.expiryMs() - DAY_MS);
    let next = now + DAY_MS;
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.att(ws);
      if (a.installation) continue;
      if (now - a.acceptedAt >= AUTH_TIMEOUT_MS) this.refuse(ws, 'not_authenticated');
      else next = Math.min(next, a.acceptedAt + AUTH_TIMEOUT_MS);
    }
    const expiry = this.store.nextExpiry();
    if (expiry !== undefined) next = Math.min(next, expiry);
    await this.ctx.storage.setAlarm(Math.max(next, now + 1000));
  }
}
