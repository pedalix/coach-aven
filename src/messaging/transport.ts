// How envelopes travel (OpenSpec `agent-messaging`, design D1): one mechanism, two transports. Inside
// an installation, the in-process LocalTransport (local.ts); between installations, the hub client
// (D8, the same interface). The bot never cares which one carried a message.
//
// Delivery is at-least-once: a delivery is acked only after its handler has durably recorded the
// effect, and whatever is not acked is handed over again after a restart. Handlers drop envelope ids
// they have seen (design D6 "Seen ids").
import type { Envelope, Payload, Removed } from './protocol.js';

/** An envelope as it waits in an outbox or inbox: written before it is sent, removed when acked. */
export interface OutboxRecord {
  seq: number;
  env: Envelope;
  /** In clear: only inside one process (the local transport); never serialized across installations. */
  payload?: Payload;
  /** ISO time it was queued. */
  at: string;
}

/** Where a transport keeps its records; the bot's is part of state.json, tests use memoryStore(). */
export interface RecordStore {
  load(): OutboxRecord[];
  save(records: OutboxRecord[]): void;
}

export const memoryStore = (initial: OutboxRecord[] = []): RecordStore & { records: OutboxRecord[] } => {
  const s = {
    records: [...initial],
    load: () => [...s.records],
    save: (r: OutboxRecord[]) => void (s.records = [...r]),
  };
  return s;
};

export interface Delivery {
  seq: number;
  env: Envelope;
  payload?: Payload;
}

export type SendOutcome = { routed: true } | { rejected: string };

export interface PeerTransport {
  readonly kind: 'local' | 'hub';
  /** Queue an envelope (recorded first); resolves once it is routed or rejected. */
  send(env: Envelope, payload?: Payload): Promise<SendOutcome>;
  /** The handler records the effect durably, then calls ack(seq). */
  onDeliver(handler: (d: Delivery) => Promise<void>): void;
  ack(seq: number): Promise<void>;
  /** Who is reachable now, and which installations were removed. */
  presence(): { online: string[]; removed: Removed[] };
}
