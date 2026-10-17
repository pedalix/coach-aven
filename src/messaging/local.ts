// The in-process transport (design D1): agents of one installation message each other without a hub.
// The envelope travels with its payload in clear and is never serialized outside the process (D5). It
// keeps the same records as the hub client: written before delivery, removed on ack, handed over again
// by start() after a restart. It is also the transport every bot-side test runs on.
import { parseAddress, type Envelope, type Payload } from './protocol.js';
import type { Delivery, OutboxRecord, PeerTransport, RecordStore, SendOutcome } from './transport.js';

export class LocalTransport implements PeerTransport {
  readonly kind = 'local' as const;
  private handler?: (d: Delivery) => Promise<void>;
  private seq: number;

  constructor(
    private readonly store: RecordStore,
    private readonly o: { installation: string; now?: () => Date; onHandlerError?: (seq: number, err: unknown) => void },
  ) {
    this.seq = store.load().reduce((m, r) => Math.max(m, r.seq), 0);
  }

  async send(env: Envelope, payload?: Payload): Promise<SendOutcome> {
    if (parseAddress(env.to)?.installation !== this.o.installation) return { rejected: 'not an agent of this installation' };
    const rec: OutboxRecord = { seq: ++this.seq, env, ...(payload ? { payload } : {}), at: (this.o.now?.() ?? new Date()).toISOString() };
    this.store.save([...this.store.load(), rec]); // durable before anyone can act on it
    setImmediate(() => void this.hand(rec));
    return { routed: true };
  }

  onDeliver(handler: (d: Delivery) => Promise<void>): void {
    this.handler = handler;
  }

  /** After a restart: hand every record that was never acked to the handler again, in order. */
  async start(): Promise<void> {
    for (const rec of this.store.load().sort((a, b) => a.seq - b.seq)) await this.hand(rec);
  }

  async ack(seq: number): Promise<void> {
    this.store.save(this.store.load().filter((r) => r.seq !== seq));
  }

  presence(): { online: string[]; removed: [] } {
    return { online: [this.o.installation], removed: [] };
  }

  private async hand(rec: OutboxRecord): Promise<void> {
    if (!this.handler) return;
    try {
      await this.handler({ seq: rec.seq, env: rec.env, ...(rec.payload ? { payload: rec.payload } : {}) });
    } catch (e) {
      this.o.onHandlerError?.(rec.seq, e); // the record stays: start() hands it over again
    }
  }
}
