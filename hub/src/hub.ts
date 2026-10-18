// The hub (OpenSpec `messaging-hub`, design D3–D5; `hub-open-network`, design N1–N7): one Durable Object
// that every installation's bot keeps one outbound WebSocket to.
// - An installation claims its name with a signed challenge: first come, first served under the
//   configuration's registration policy, or reserved there for the operator's own keys (N1, N7).
// - It tells the hub whom it hears from: its pinned peers, the allow list (N3). The hub routes sealed
//   envelopes it cannot read only along those lists, and keeps them until the recipient acks.
// - Presence and removals go only along relationships (N4); expiries go to the sender, by envelope id.
// - It sees installations, never agents (N5), and decides nothing about which agent may ask which.
//
// Stateless in memory on purpose: connections are found through their sockets' attachments
// (WebSocket Hibernation), everything else is in SQLite (store.ts). So an eviction between messages
// loses nothing, and keep-alive pings are answered by the runtime without waking the object.
import { DurableObject } from 'cloudflare:workers';
import { challengeText, parseClientFrame, parseWireEnvelope, type HubFrame, type Removed, type WireEnvelope } from '../../src/messaging/protocol.js';
import { keysValidAt, parseHubConfig, reservedNameOfKey, type HubConfig } from './config.js';
import { randomNonce, verifyEd25519 } from './crypto.js';
import { HubStore } from './store.js';
import { log, type Level, type SentryEnv } from './report.js';

export interface Env extends SentryEnv {
  HUB: DurableObjectNamespace<Hub>;
  /** Secret: the registration policy — {registration, reserved, limits?} (config.ts). */
  HUB_CONFIG: string;
  /** Envelope expiry in days (default 7). */
  HUB_EXPIRY_DAYS?: string;
}

interface Attachment {
  nonce: string;
  host: string;
  acceptedAt: number;
  /** The name the connection said it claims (`?as=`): an `auth` for another name is refused. */
  hint?: string;
  /** The client's address (`CF-Connecting-IP`), for the claim limit. */
  ip?: string;
  installation?: string;
  /** The key it authenticated with: a later configuration may stop admitting it. */
  key?: string;
  authedAt?: number;
}

/**
 * Why an `auth` is refused — the close reason the bot logs — and how loudly the hub logs it. On an open
 * hub most refusals are other people's business (info); a reserved name claimed with another key is our
 * own bot misconfigured or someone posing as it.
 */
const REFUSALS = {
  'not authenticated': 'info',
  'unsupported version': 'warn',
  'hint mismatch': 'warn',
  'bad signature': 'warn',
  'bad config': 'error',
  reserved: 'error',
  'name taken': 'info',
  'key holds a name': 'info',
  closed: 'info',
  'claim limit': 'info',
} as const satisfies Record<string, Level>;
type Refusal = keyof typeof REFUSALS;

const DAY_MS = 86_400_000;
const AUTH_TIMEOUT_MS = 10_000;

export class Hub extends DurableObject<Env> {
  private readonly store: HubStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new HubStore(ctx.storage.sql);
    // Keep-alives never wake the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    // First request after a deploy: migrate, then align with the configuration (revocations).
    void ctx.blockConcurrencyWhile(async () => {
      const migrated = this.store.migrate();
      if (migrated) log('info', 'hub.schema.migrated', migrated);
      const cfg = this.config();
      if (cfg) this.alignWithConfig(cfg);
    });
  }

  /**
   * Apply a (new) configuration to the names held now:
   * - a claimed name the configuration reserves for nobody, or for other keys, is revoked;
   * - a claimed name it reserves for the same key just becomes reserved;
   * - a connected name reserved for nobody now is revoked; one reserved for keys that no longer include
   *   the one it authenticated with is disconnected (`reserved`), and keeps its name.
   */
  alignWithConfig(cfg: HubConfig): void {
    const now = Date.now();
    for (const row of this.store.claimedNames()) {
      if (!(row.name in cfg.reserved)) continue;
      const keys = cfg.reserved[row.name];
      if (keys && keysValidAt(keys, now).some((k) => k.key === row.key)) this.store.unclaim(row.name); // reserved now: never released
      else this.removeName(row.name, 'revoked');
    }
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.att(ws);
      if (!a.installation || !(a.installation in cfg.reserved)) continue;
      const keys = cfg.reserved[a.installation];
      if (keys === null) this.removeName(a.installation, 'revoked');
      else if (!keysValidAt(keys ?? [], now).some((k) => k.key === a.key)) {
        ws.serializeAttachment({ ...a, installation: undefined });
        ws.close(4003, 'reserved');
        for (const peer of this.edges(a.installation)) this.presenceTo(peer);
      }
    }
  }

  /** The configuration, or undefined when it does not parse: logged, and every connection refused. */
  private config(): HubConfig | undefined {
    try {
      return parseHubConfig(this.env.HUB_CONFIG);
    } catch (e) {
      log('error', 'hub.config.invalid', { error: e instanceof Error ? e.message : String(e) });
      return undefined;
    }
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
  private connected(): Set<string> {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const i = this.att(ws).installation;
      if (i) ids.add(i);
    }
    return ids;
  }
  private mutual(a: string, b: string): boolean {
    return this.store.allows(a, b) && this.store.allows(b, a);
  }
  /** The connected installations `name` has a relationship with: both allow each other (N4). */
  private edges(name: string): string[] {
    return [...this.connected()].filter((x) => x !== name && this.mutual(name, x)).sort();
  }
  /** The removals `name` hears of: of names its allow list holds. */
  private removedFor(name: string): Removed[] {
    const allowed = new Set(this.store.allowOf(name));
    return this.store.tombstones().filter((t) => allowed.has(t.name)).map((t) => ({ installation: t.name, at: t.at }));
  }
  /** A fresh view for one installation, if it is connected: never a list of who is on the hub. */
  private presenceTo(name: string): void {
    const ws = this.socketOf(name);
    if (ws) this.send(ws, { t: 'presence', online: this.edges(name), removed: this.removedFor(name) });
  }
  private async ensureAlarm(at: number): Promise<void> {
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || at < cur) await this.ctx.storage.setAlarm(at);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected a WebSocket upgrade', { status: 426 });
    const url = new URL(request.url);
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const nonce = randomNonce();
    const hint = url.searchParams.get('as') ?? undefined;
    server.serializeAttachment({ nonce, host: url.host, acceptedAt: Date.now(), ...(hint ? { hint } : {}), ip: request.headers.get('CF-Connecting-IP') ?? 'unknown' } satisfies Attachment);
    this.send(server, { t: 'challenge', nonce, now: new Date().toISOString() });
    await this.ensureAlarm(Date.now() + AUTH_TIMEOUT_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  private refuse(ws: WebSocket, reason: Refusal, name?: string): void {
    // Logged without key material (no signature, no key).
    log(REFUSALS[reason], 'hub.auth.refused', { reason, ...(name ? { installation: name } : {}) });
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
      if (frame?.t === 'auth-unsupported') return this.refuse(ws, 'unsupported version', a.hint);
      if (frame?.t !== 'auth') return this.refuse(ws, 'not authenticated', a.hint);
      return this.authenticate(ws, a, frame.name, frame.key, frame.sig);
    }
    if (!frame) return; // a kind this hub does not know: ignored (additive protocol)
    if (frame.t === 'send') return this.route(ws, a.installation, frame.env);
    if (frame.t === 'ack') return this.store.ack(a.installation, frame.seq);
    if (frame.t === 'allow') return this.allow(a.installation, frame.installations);
    // a second `auth` on an authenticated socket changes nothing
  }

  /**
   * Who may hold `name` (N1, N7) — the one place that reads `registration`: invite codes, domain proofs
   * or organisation signatures would be new values and new branches here. Undefined: admitted, and a
   * free name is claimed for `key` now.
   */
  private admit(cfg: HubConfig, name: string, key: string, ip: string, now: number): Refusal | undefined {
    if (name in cfg.reserved) {
      const keys = cfg.reserved[name];
      if (!keys || !keysValidAt(keys, now).some((k) => k.key === key)) return 'reserved';
      if (this.store.isTombstoned(name)) this.store.lift(name);
      return undefined;
    }
    const row = this.store.nameRow(name);
    if (row) return row.key === key ? undefined : 'name taken';
    if (reservedNameOfKey(cfg, key) !== undefined || this.store.nameOfKey(key) !== undefined) return 'key holds a name';
    if (cfg.registration === 'closed') return 'closed';
    const day = Math.floor(now / DAY_MS);
    if (this.store.claimCount(ip, day) >= cfg.limits.claimsPerIpPerDay) return 'claim limit';
    this.store.claim(name, key, now);
    this.store.countClaim(ip, day);
    log('info', 'hub.name.claimed', { installation: name });
    return undefined;
  }

  private async authenticate(ws: WebSocket, a: Attachment, name: string, key: string, sig: string): Promise<void> {
    if (a.hint !== name) return this.refuse(ws, 'hint mismatch', name);
    if (!(await verifyEd25519(key, challengeText(a.host, name, key, a.nonce), sig))) return this.refuse(ws, 'bad signature', name);
    const cfg = this.config();
    if (!cfg) return this.refuse(ws, 'bad config', name);
    const now = Date.now();
    const refusal = this.admit(cfg, name, key, a.ip ?? 'unknown', now);
    if (refusal) return this.refuse(ws, refusal, name);
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws && this.att(other).installation === name) {
        other.serializeAttachment({ ...this.att(other), installation: undefined });
        other.close(4000, 'replaced');
        log('warn', 'hub.replaced', { installation: name });
      }
    }
    ws.serializeAttachment({ ...a, installation: name, key, authedAt: now } satisfies Attachment);
    this.store.touch(name, now);
    this.send(ws, { t: 'hello', now: new Date(now).toISOString(), online: this.edges(name), removed: this.removedFor(name) });
    for (const row of this.store.pendingFor(name)) this.send(ws, { t: 'deliver', seq: row.seq, env: JSON.parse(row.env) as Record<string, unknown> });
    for (const r of this.store.expiredFor(name)) {
      this.send(ws, { t: 'expired', id: r.env_id });
      this.store.clearExpired(r.env_id);
    }
    for (const peer of this.edges(name)) this.presenceTo(peer);
  }

  /** A new allow list (N3): it governs envelopes routed from now on; both sides of every changed edge get a fresh view. */
  private allow(installation: string, peers: string[]): void {
    const cfg = this.config();
    const max = cfg?.limits.allowMax ?? peers.length;
    const list = peers.filter((p) => p !== installation);
    if (list.length > max) log('warn', 'hub.allow.capped', { installation, size: list.length, max });
    const before = this.store.allowOf(installation);
    this.store.setAllow(installation, list.slice(0, max));
    this.presenceTo(installation);
    for (const p of new Set([...before, ...list])) this.presenceTo(p);
  }

  /** Whether an installation holds a name here now: reserved for keys, or claimed, and not removed. */
  private holds(cfg: HubConfig, name: string): boolean {
    if (this.store.isTombstoned(name)) return false;
    return name in cfg.reserved ? cfg.reserved[name] !== null : this.store.nameRow(name) !== undefined;
  }

  private async route(ws: WebSocket, sender: string, raw: Record<string, unknown>): Promise<void> {
    const id = typeof raw.id === 'string' ? raw.id : '';
    const to = typeof raw.to === 'string' ? raw.to : undefined;
    const size = JSON.stringify(raw).length;
    const reject = (reason: string): void => {
      log('warn', 'hub.rejected', { from: sender, ...(to ? { to } : {}), ...(id ? { env_id: id } : {}), size, reason });
      this.send(ws, { t: 'rejected', id, reason });
    };
    const parsed = parseWireEnvelope(raw);
    if (!parsed.ok) return reject(parsed.reason === 'unsupported version' ? 'unsupported version' : 'malformed');
    const env = parsed.env;
    const cfg = this.config();
    if (!cfg) return reject('unavailable');
    // A name nobody holds, a removed one, and one that does not allow the sender look the same: the hub
    // does not tell a sender who exists (N3).
    if (!this.holds(cfg, env.to) || !this.store.allows(env.to, sender)) return reject('unknown installation');
    if (this.store.wasRouted(env.id)) return this.send(ws, { t: 'routed', id: env.id }); // re-sent after a restart
    // The sender is the authenticated installation, whatever the envelope names; only the known fields travel on.
    const stored: WireEnvelope = { v: env.v, id: env.id, from: sender, to: env.to, eph: env.eph, ct: env.ct, sig: env.sig };
    const text = JSON.stringify(stored);
    const all = this.store.outboxSize(env.to);
    const pair = this.store.pairSize(env.to, sender);
    const l = cfg.limits;
    if (all.count >= l.backlogEnvelopes || all.bytes + text.length > l.backlogBytes || pair.count >= l.pairEnvelopes || pair.bytes + text.length > l.pairBytes) return reject('backlog');
    const now = Date.now();
    const row = this.store.append({ installation: env.to, env_id: env.id, sender, size: text.length, routed_at: now, expires_at: now + this.expiryMs(), env: text });
    this.send(ws, { t: 'routed', id: env.id });
    const peer = this.socketOf(env.to);
    if (peer) this.send(peer, { t: 'deliver', seq: row.seq, env: stored as unknown as Record<string, unknown> });
    await this.ensureAlarm(row.expires_at);
  }

  /** A released or revoked name: tombstoned, cut off, and reported to the installations that allow it. */
  private removeName(name: string, reason: 'released' | 'revoked'): void {
    const allowers = this.store.allowedBy(name);
    this.store.remove(name, new Date().toISOString(), reason);
    log('warn', 'hub.installation.removed', { installation: name, reason });
    for (const ws of this.ctx.getWebSockets()) {
      if (this.att(ws).installation !== name) continue;
      ws.serializeAttachment({ ...this.att(ws), installation: undefined });
      ws.close(4003, 'removed');
    }
    for (const i of allowers) this.presenceTo(i);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const name = this.att(ws).installation;
    if (name) {
      ws.serializeAttachment({ ...this.att(ws), installation: undefined });
      for (const peer of this.edges(name)) this.presenceTo(peer);
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    for (const r of this.store.expire(now)) {
      log('info', 'hub.expired', { from: r.sender, to: r.installation, env_id: r.env_id, size: r.size });
      const ws = this.socketOf(r.sender);
      if (ws) {
        this.send(ws, { t: 'expired', id: r.env_id });
        this.store.clearExpired(r.env_id);
      }
    }
    this.store.forgetRouted(now - this.expiryMs() - DAY_MS);
    const cfg = this.config();
    if (cfg) {
      // A connection is a sign of life however long it lasts; then names silent for `idleDays` go.
      for (const name of this.connected()) this.store.touch(name, now);
      for (const name of this.store.idleNames(now - cfg.limits.idleDays * DAY_MS)) if (!(name in cfg.reserved)) this.removeName(name, 'released');
    }
    let next = now + DAY_MS;
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.att(ws);
      if (a.installation) continue;
      if (now - a.acceptedAt >= AUTH_TIMEOUT_MS) this.refuse(ws, 'not authenticated');
      else next = Math.min(next, a.acceptedAt + AUTH_TIMEOUT_MS);
    }
    const expiry = this.store.nextExpiry();
    if (expiry !== undefined) next = Math.min(next, expiry);
    await this.ctx.storage.setAlarm(Math.max(next, now + 1000));
  }
}
