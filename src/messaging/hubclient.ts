// The bot's side of the hub (OpenSpec `agent-messaging`, design D4, D5, D8): a PeerTransport over one
// outbound WebSocket. Started by the composition root only when HUB_URL is set (config.ts).
//
//   connect → `challenge` (the hub's time and a nonce) → `auth` (Ed25519 over host|installation|nonce)
//   → `hello` (enrolled, online, removed) → the outbox is sent again, the hub replays what it holds
//
// - **Clocks.** The hub's `now` is compared with ours once per connection; past 30 s it is a warning
//   (`hub.clock.skew`), never a correction — keeping the host's clock is the host's job.
// - **Outgoing.** Envelopes are sealed to the peer's pinned key and written to the outbox (state.json)
//   BEFORE they are sent; `routed`/`rejected` clears them. A restart sends them again, and the hub
//   de-duplicates by envelope id.
// - **Incoming.** A `deliver` is opened (signature against the sender's pinned keys first, then the own
//   keys), its domain claim checked against the authenticated installation, and handed to the handler.
//   It is acked only after the handler resolved — the handler records the effect durably first. A
//   redelivery of an envelope this process already handled is acked and ignored; across restarts the
//   handler's own record (the task's seen ids) does that.
// - **Reports.** `expired`, removals (in `hello` and `presence`) and outcomes go to the hooks; `replaced`
//   (two bots with one key) and refusals are logged loudly.
// - **Connection.** Exponential backoff with jitter (1 s → 60 s), a `ping` every 30 s (the hub's runtime
//   answers `pong` without waking the hub), and a connection silent for 90 s is dropped and redialled.
import { emit, type EventSink } from './events.js';
import { isId } from './a2a.js';
import { domainClaimOk, parseAddress, parseEnvelope, parseHubFrame, parsePayload, PROTOCOL_VERSION, type Envelope, type HubFrame, type Payload, type Removed } from './protocol.js';
import { fingerprint, open, seal, signChallenge, type KeyFile } from './seal.js';
import type { Delivery, OutboxRecord, PeerTransport, RecordStore, SendOutcome } from './transport.js';
import { endTasksWithPeer, validKeys, type Peers } from './peers.js';
import { isOpen, type InTask, type OutTask } from './records.js';
import type { Store } from '../state.js';

/** The WebSocket surface the client uses (the WHATWG WebSocket of Node ≥ 22; tests pass a fake). */
export interface HubSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (ev: { data?: unknown; code?: number; reason?: string }) => void): void;
}
export type SocketFactory = (url: string) => HubSocket;

export interface HubClientOptions {
  /** HUB_URL: the hub's base (`wss://hub.example.com`); `/connect` is added when the URL names no path. */
  url: string;
  installation: string;
  keys: KeyFile;
  /** The pinned peers, read at use time (a reload changes them). */
  peers: () => Peers;
  /** The outbox: state.json's `messaging.outbox.hub`. */
  store: RecordStore;
  socket?: SocketFactory;
  sink?: EventSink;
  random?: () => number;
}

export const SKEW_WARN_MS = 30_000;
export const PING_MS = 30_000;
export const SILENT_MS = 90_000;
export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;
export const LONG_OUTAGE_MS = 10 * 60_000;
export const OUTBOX_WARN = 100;
const HOUR = 3_600_000;
const SEEN_MAX = 2_000;

export const connectUrl = (base: string): string => {
  const u = new URL(base);
  if (u.pathname === '' || u.pathname === '/') u.pathname = '/connect';
  return u.toString();
};

export interface Unsupported {
  from: string;
  to?: string;
  task: string;
  theirs: unknown;
}

export interface Expiry {
  id: string;
  task: string;
  to: string;
}

export class HubClient implements PeerTransport {
  readonly kind = 'hub' as const;
  private readonly url: string;
  private readonly host: string;
  private ws?: HubSocket;
  private authed = false;
  private stopped = true;
  private attempt = 0;
  private skewChecked = false;
  private lastHeard = 0;
  private downSince?: number;
  private outageReported = false;
  private pingTimer?: ReturnType<typeof setInterval>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private seq: number;
  private online: string[] = [];
  private removed: Removed[] = [];
  private enrolled: string[] = [];
  private handler?: (d: Delivery) => Promise<void>;
  private readonly waiting = new Map<string, (o: SendOutcome) => void>();
  private readonly inFlight = new Set<number>();
  private readonly handled = new Set<string>();
  private readonly outcomeHooks: ((env: Envelope, o: SendOutcome) => void)[] = [];
  private readonly expiryHooks: ((e: Expiry) => void)[] = [];
  private readonly presenceHooks: ((p: { online: string[]; removed: Removed[] }) => void)[] = [];
  private readonly unsupportedHooks: ((u: Unsupported) => void)[] = [];

  constructor(private readonly o: HubClientOptions) {
    this.url = connectUrl(o.url);
    this.host = new URL(this.url).host;
    this.seq = o.store.load().reduce((m, r) => Math.max(m, r.seq), 0);
  }

  // ── PeerTransport ───────────────────────────────────────────────────────────────────────────
  /**
   * Seal and queue an envelope for a pinned peer. Resolves with the hub's `routed`/`rejected` — possibly
   * after reconnects, so a tool never waits on it; `onOutcome` sees every outcome, also after a restart.
   */
  async send(env: Envelope, payload?: Payload): Promise<SendOutcome> {
    const peer = parseAddress(env.to)?.installation;
    const keys = peer ? validKeys(this.o.peers()[peer], new Date()) : [];
    if (!peer || !keys.length) return { rejected: 'unknown installation' };
    const sealed = seal({ v: env.v, id: env.id, from: env.from, to: env.to, method: env.method, task: env.task }, payload ?? {}, { signing: this.o.keys.signing, recipientBox: keys[0]!.box });
    const rec: OutboxRecord = { seq: ++this.seq, env: sealed, at: new Date().toISOString() };
    const records = [...this.o.store.load(), rec];
    this.o.store.save(records); // durable before it can leave
    if (records.length > OUTBOX_WARN) this.backlog(records);
    const outcome = new Promise<SendOutcome>((resolve) => this.waiting.set(sealed.id, resolve));
    if (this.authed) this.frame({ t: 'send', env: sealed });
    return outcome;
  }

  onDeliver(handler: (d: Delivery) => Promise<void>): void {
    this.handler = handler;
  }

  /** Only on an authenticated connection: anything before `auth` closes it. A lost ack means a redelivery, which the handler de-duplicates. */
  async ack(seq: number): Promise<void> {
    if (this.authed) this.frame({ t: 'ack', seq });
  }

  presence(): { online: string[]; removed: Removed[] } {
    return { online: [...this.online], removed: [...this.removed] };
  }

  // ── hub-specific hooks ──────────────────────────────────────────────────────────────────────
  /** Every `routed`/`rejected` of an outbox envelope, including ones sent again after a restart. */
  onOutcome(h: (env: Envelope, o: SendOutcome) => void): void {
    this.outcomeHooks.push(h);
  }
  /** An envelope that expired undelivered at the hub (the task ends `failed: expired`). */
  onExpired(h: (e: Expiry) => void): void {
    this.expiryHooks.push(h);
  }
  /** Who is connected, and which installations the hub removed (their tasks end `failed: peer removed`). */
  onPresence(h: (p: { online: string[]; removed: Removed[] }) => void): void {
    this.presenceHooks.push(h);
  }
  /**
   * An envelope of a protocol version this release does not know (a newer hub routed it): dropped and
   * logged here; the answering side tells its sender `rejected: unsupported version` (D5).
   */
  onUnsupported(h: (u: Unsupported) => void): void {
    this.unsupportedHooks.push(h);
  }
  /** The installations the hub enrols, from the last `hello`. */
  enrolledInstallations(): string[] {
    return [...this.enrolled];
  }
  get connected(): boolean {
    return this.authed;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.downSince ??= Date.now();
    this.pingTimer = setInterval(() => this.tick(), PING_MS);
    this.pingTimer.unref?.();
    this.dial();
  }

  stop(): void {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.pingTimer = this.retryTimer = undefined;
    const ws = this.ws;
    this.ws = undefined;
    this.authed = false;
    try {
      ws?.close(1000, 'stopping');
    } catch {
      /* already closed */
    }
  }

  // ── the connection ──────────────────────────────────────────────────────────────────────────
  private dial(): void {
    if (this.stopped) return;
    this.skewChecked = false;
    this.lastHeard = Date.now();
    let ws: HubSocket;
    try {
      ws = (this.o.socket ?? ((u) => new WebSocket(u) as unknown as HubSocket))(this.url);
    } catch (e) {
      this.failed('unreachable', e);
      return this.retry();
    }
    this.ws = ws;
    ws.addEventListener('message', (ev) => {
      if (this.ws !== ws) return;
      this.lastHeard = Date.now();
      const text = typeof ev.data === 'string' ? ev.data : String(ev.data);
      if (text === 'pong') return;
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return;
      }
      const frame = parseHubFrame(raw);
      if (frame) this.onFrame(frame);
    });
    ws.addEventListener('close', (ev) => {
      if (this.ws !== ws) return;
      this.onClose(ev.code ?? 1006, ev.reason ?? '');
    });
    ws.addEventListener('error', () => {
      /* a close follows */
    });
  }

  private onClose(code: number, reason: string): void {
    const wasAuthed = this.authed;
    this.ws = undefined;
    this.authed = false;
    this.downSince ??= Date.now();
    if (code === 4000) {
      emit('hub.replaced', { installation: this.o.installation }, { onceEvery: { key: 'replaced', ms: HOUR }, sink: this.o.sink });
      this.attempt = Math.max(this.attempt, 6); // another bot holds this key: do not fight it every second
    } else if (code === 4003) {
      this.failed(reason || 'refused');
    } else if (!wasAuthed) {
      this.failed('unreachable');
    }
    this.retry();
  }

  private failed(reason: string, err?: unknown): void {
    void err;
    emit('hub.connect.failed', { installation: this.o.installation, reason }, { onceEvery: { key: reason, ms: HOUR }, sink: this.o.sink });
  }

  private retry(): void {
    if (this.stopped) return;
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempt);
    this.attempt++;
    const delay = Math.round(base * (0.5 + (this.o.random ?? Math.random)() * 0.5));
    this.retryTimer = setTimeout(() => this.dial(), delay);
    this.retryTimer.unref?.();
  }

  /** Every PING_MS: keep the connection alive, drop a silent one, report a long outage once. */
  private tick(): void {
    const now = Date.now();
    if (this.ws && now - this.lastHeard > SILENT_MS) {
      const ws = this.ws;
      this.onClose(1006, 'silent');
      try {
        ws.close(4001, 'silent');
      } catch {
        /* gone */
      }
      return;
    }
    if (this.ws) {
      try {
        this.ws.send('ping');
      } catch {
        /* the close event follows */
      }
    }
    if (!this.authed && this.downSince !== undefined && !this.outageReported && now - this.downSince > LONG_OUTAGE_MS) {
      this.outageReported = true;
      emit('hub.disconnected.long', { minutes: Math.round((now - this.downSince) / 60_000), outbox: this.o.store.load().length }, { sink: this.o.sink });
    }
  }

  private frame(f: Record<string, unknown>): void {
    if (!this.ws) return;
    try {
      this.ws.send(JSON.stringify(f));
    } catch {
      /* the close event follows; the outbox and the hub keep what matters */
    }
  }

  // ── frames ──────────────────────────────────────────────────────────────────────────────────
  private onFrame(f: HubFrame): void {
    switch (f.t) {
      case 'challenge': {
        if (!this.skewChecked) {
          this.skewChecked = true;
          const skew = Date.parse(f.now) - Date.now();
          if (Number.isFinite(skew) && Math.abs(skew) > SKEW_WARN_MS) emit('hub.clock.skew', { skew_ms: skew }, { sink: this.o.sink });
        }
        this.frame({ t: 'auth', installation: this.o.installation, sig: signChallenge(this.host, this.o.installation, f.nonce, this.o.keys.signing) });
        return;
      }
      case 'hello': {
        this.authed = true;
        this.attempt = 0;
        this.downSince = undefined;
        this.outageReported = false;
        this.enrolled = f.enrolled;
        this.setPresence(f.online, f.removed);
        const records = this.o.store.load().sort((a, b) => a.seq - b.seq);
        for (const r of records) this.frame({ t: 'send', env: r.env });
        if (records.length > OUTBOX_WARN) this.backlog(records);
        return;
      }
      case 'presence':
        this.setPresence(f.online, f.removed ?? this.removed);
        return;
      case 'routed':
        return this.settle(f.id, { routed: true });
      case 'rejected':
        return this.settle(f.id, { rejected: f.reason });
      case 'expired':
        for (const h of this.expiryHooks) h({ id: f.id, task: f.task, to: f.to });
        return;
      case 'deliver':
        void this.deliver(f.seq, f.env);
        return;
    }
  }

  private setPresence(online: string[], removed: Removed[]): void {
    this.online = [...online];
    this.removed = [...removed];
    for (const h of this.presenceHooks) h({ online: [...online], removed: [...removed] });
  }

  private settle(id: string, outcome: SendOutcome): void {
    const records = this.o.store.load();
    const rec = records.find((r) => r.env.id === id);
    if (!rec) return; // not ours, or settled already
    this.o.store.save(records.filter((r) => r.env.id !== id));
    if ('rejected' in outcome) emit('hub.rejected', { from: rec.env.from, to: rec.env.to, method: rec.env.method, reason: outcome.rejected }, { sink: this.o.sink });
    this.waiting.get(id)?.(outcome);
    this.waiting.delete(id);
    for (const h of this.outcomeHooks) h(rec.env, outcome);
  }

  private backlog(records: OutboxRecord[]): void {
    const oldest = Math.min(...records.map((r) => Date.parse(r.at)));
    emit('hub.outbox.backlog', { installation: this.o.installation, size: records.length, oldest_age: `${Math.round((Date.now() - oldest) / 60_000)}m` }, { onceEvery: { key: 'backlog', ms: HOUR }, sink: this.o.sink });
  }

  /** Open, check and hand over one delivery; ack after the handler, or at once when it is dropped. */
  private async deliver(seq: number, raw: Record<string, unknown>): Promise<void> {
    if (this.inFlight.has(seq)) return;
    const drop = (): void => void this.ack(seq);
    const s = (k: string): string | undefined => (typeof raw[k] === 'string' ? (raw[k] as string) : undefined);
    const parsed = parseEnvelope(raw);
    if (!parsed.ok) {
      if (parsed.reason === 'unsupported version') {
        emit('ask.rejected', { from: s('from'), to: s('to'), task: s('task'), reason: 'unsupported version', versions: `theirs ${String(parsed.theirs)}, ours ${PROTOCOL_VERSION}` }, { sink: this.o.sink });
        const from = s('from');
        const task = s('task');
        if (from && task && parseAddress(from) && isId(task)) for (const h of this.unsupportedHooks) h({ from, to: s('to'), task, theirs: parsed.theirs });
      } else {
        emit('ask.unexpected', { task: s('task'), from: s('from'), expected: 'a well-formed envelope' }, { sink: this.o.sink });
      }
      return drop();
    }
    const env = parsed.env;
    if (this.handled.has(env.id)) {
      emit('hub.envelope.duplicate', { from: env.from, task: env.task, env_id: env.id }, { sink: this.o.sink });
      return drop();
    }
    const sender = parseAddress(env.from)!.installation;
    const pinned = this.o.peers()[sender];
    const bad = (name: 'hub.envelope.bad_signature' | 'hub.envelope.decrypt_failed', key: string): void =>
      emit(name, { from: env.from, method: env.method, task: env.task, env_id: env.id, key }, { sink: this.o.sink });
    if (!pinned?.length) {
      bad('hub.envelope.bad_signature', 'unpinned');
      return drop();
    }
    const opened = open(env, { senderKeys: validKeys(pinned, new Date()), own: this.o.keys });
    if (!opened.ok) {
      if (opened.reason === 'decrypt_failed') bad('hub.envelope.decrypt_failed', fingerprint(this.o.keys.encryption.public));
      else bad('hub.envelope.bad_signature', pinned.map((k) => fingerprint(k.sign)).join(','));
      return drop();
    }
    const payload = parsePayload(opened.payload);
    if (!payload) {
      emit('ask.unexpected', { task: env.task, from: env.from, expected: 'a valid payload' }, { sink: this.o.sink });
      return drop();
    }
    if (!domainClaimOk(payload.domain, sender)) {
      emit('ask.unexpected', { task: env.task, from: env.from, expected: `a domain of ${sender}, not ${payload.domain}` }, { sink: this.o.sink });
      return drop();
    }
    if (!this.handler) return; // nobody to take it yet: the hub keeps it until we ack
    this.inFlight.add(seq);
    try {
      await this.handler({ seq, env, payload });
      this.handled.add(env.id);
      if (this.handled.size > SEEN_MAX) this.handled.delete(this.handled.values().next().value!);
      await this.ack(seq);
    } catch {
      // Not acked: the hub delivers it again on the next connection. The handler logs its own failure.
    } finally {
      this.inFlight.delete(seq);
    }
  }
}

/**
 * The hub's reports applied to the task records (D8, "Terminal states are reported"):
 * - `expired`: the task the envelope belonged to ends `failed: expired`;
 * - a peer reported removed (in `hello` or `presence`): every open task with it ends `failed: peer removed`;
 * - `rejected`: an asker's first message ends its task `rejected: <reason>`; any later message (a reply,
 *   an answer) ends it `failed: <reason>`.
 * `onEnded` hears each task that ended here, so its conversation can be told (the deliverer's job).
 */
export function applyHubReports(client: HubClient, store: Store, o: { installation: string; onEnded?: (t: OutTask | InTask) => void; sink?: EventSink }): void {
  const ended = (t: OutTask | InTask | undefined): void => {
    if (t) o.onEnded?.(t);
  };
  const endOut = (id: string, state: 'failed' | 'rejected', reason: string): void => {
    const t = store.getOutTask(id);
    if (t && isOpen(t)) ended(store.patchOutTask(id, { state, reason, updatedAt: new Date().toISOString() }));
  };
  const endIn = (origin: string, id: string, reason: string): void => {
    const t = store.getInTask(origin, id);
    if (t && isOpen(t)) ended(store.patchInTask(origin, id, { state: 'failed', reason, updatedAt: new Date().toISOString() }));
  };
  client.onExpired((e) => {
    const to = parseAddress(e.to);
    if (!to) return;
    const out = store.getOutTask(e.task);
    if (out && out.target === e.to) endOut(e.task, 'failed', 'expired');
    else endIn(to.installation, e.task, 'expired'); // an answer of ours that never reached its asker
  });
  client.onOutcome((env, outcome) => {
    if (!('rejected' in outcome)) return;
    if (env.method === 'ask') {
      const t = store.getOutTask(env.task);
      const first = t !== undefined && t.state === 'submitted' && !t.replies.length;
      endOut(env.task, first ? 'rejected' : 'failed', outcome.rejected);
    } else if (env.method === 'answer') {
      const to = parseAddress(env.to);
      if (to) endIn(to.installation, env.task, outcome.rejected);
    }
  });
  const applied = new Set<string>();
  client.onPresence(({ removed }) => {
    for (const r of removed) {
      if (applied.has(r.installation) || r.installation === o.installation) continue;
      applied.add(r.installation);
      const gone = endTasksWithPeer(store, r.installation, 'peer removed');
      if (gone.out.length || gone.in.length) emit('hub.peer.removed', { peer: r.installation, ended: gone.out.length + gone.in.length }, { sink: o.sink });
      for (const t of [...gone.out, ...gone.in]) ended(t);
    }
  });
}
