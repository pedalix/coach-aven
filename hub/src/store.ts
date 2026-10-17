// The hub's state in its Durable Object's SQLite (design D3). Everything the hub knows survives an
// eviction here, or in the sockets' attachments; the object keeps nothing in memory between messages.
//   outbox   — per recipient installation, strictly increasing seq, the envelope (header + ciphertext,
//              re-serialized from the known fields only) and its routing fields; deleted on ack
//   seqs     — the next seq per installation
//   routed   — envelope ids already routed, so a re-sent envelope is answered `routed` and stored once
//   expired  — expiry reports owed to a sender, delivered now or on its next connection
//   removed  — tombstones: removal is known even with an empty outbox
//   enrolled — who the configuration enrolled at the last start, to tombstone whoever disappears
export const SCHEMA_VERSION = 1;

const MIGRATIONS: Record<number, string[]> = {
  1: [
    `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS outbox (installation TEXT NOT NULL, seq INTEGER NOT NULL, env_id TEXT NOT NULL, sender TEXT NOT NULL,
       to_addr TEXT NOT NULL, method TEXT NOT NULL, task TEXT NOT NULL, size INTEGER NOT NULL, routed_at INTEGER NOT NULL,
       expires_at INTEGER NOT NULL, env TEXT NOT NULL, PRIMARY KEY (installation, seq))`,
    `CREATE INDEX IF NOT EXISTS outbox_expires ON outbox (expires_at)`,
    `CREATE TABLE IF NOT EXISTS seqs (installation TEXT PRIMARY KEY, next_seq INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS routed (env_id TEXT PRIMARY KEY, at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS expired (env_id TEXT PRIMARY KEY, sender TEXT NOT NULL, task TEXT NOT NULL, to_addr TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS removed (installation TEXT PRIMARY KEY, at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS enrolled (installation TEXT PRIMARY KEY)`,
  ],
};

export type OutboxRow = {
  installation: string;
  seq: number;
  env_id: string;
  sender: string;
  to_addr: string;
  method: string;
  task: string;
  size: number;
  routed_at: number;
  expires_at: number;
  env: string;
};

export class HubStore {
  constructor(private readonly sql: SqlStorage) {}

  /** Run the migrations up to SCHEMA_VERSION; returns the versions when it migrated. */
  migrate(): { from: number; to: number } | undefined {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    const row = this.sql.exec<{ v: string }>(`SELECT v FROM meta WHERE k = 'schema_version'`).toArray()[0];
    const from = row ? Number(row.v) : 0;
    if (from >= SCHEMA_VERSION) return undefined;
    for (let v = from + 1; v <= SCHEMA_VERSION; v++) for (const stmt of MIGRATIONS[v] ?? []) this.sql.exec(stmt);
    this.sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES ('schema_version', ?)`, String(SCHEMA_VERSION));
    return { from, to: SCHEMA_VERSION };
  }

  outboxSize(installation: string): { count: number; bytes: number } {
    const r = this.sql.exec<{ c: number; b: number | null }>(`SELECT COUNT(*) AS c, SUM(size) AS b FROM outbox WHERE installation = ?`, installation).one();
    return { count: r.c, bytes: r.b ?? 0 };
  }

  wasRouted(envId: string): boolean {
    return this.sql.exec(`SELECT 1 FROM routed WHERE env_id = ?`, envId).toArray().length > 0;
  }

  /** Append to the recipient's outbox with the next seq; returns the stored row. */
  append(r: Omit<OutboxRow, 'seq'>): OutboxRow {
    const cur = this.sql.exec<{ next_seq: number }>(`SELECT next_seq FROM seqs WHERE installation = ?`, r.installation).toArray()[0];
    const seq = cur?.next_seq ?? 1;
    this.sql.exec(`INSERT OR REPLACE INTO seqs (installation, next_seq) VALUES (?, ?)`, r.installation, seq + 1);
    this.sql.exec(
      `INSERT INTO outbox (installation, seq, env_id, sender, to_addr, method, task, size, routed_at, expires_at, env) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.installation, seq, r.env_id, r.sender, r.to_addr, r.method, r.task, r.size, r.routed_at, r.expires_at, r.env,
    );
    this.sql.exec(`INSERT OR REPLACE INTO routed (env_id, at) VALUES (?, ?)`, r.env_id, r.routed_at);
    return { ...r, seq };
  }

  pendingFor(installation: string): OutboxRow[] {
    return this.sql.exec<OutboxRow>(`SELECT * FROM outbox WHERE installation = ? ORDER BY seq`, installation).toArray();
  }

  ack(installation: string, seq: number): void {
    this.sql.exec(`DELETE FROM outbox WHERE installation = ? AND seq = ?`, installation, seq);
  }

  /** Move envelopes past their expiry into expiry reports for their senders; returns the reports made. */
  expire(now: number): { sender: string; env_id: string; task: string; to_addr: string }[] {
    const rows = this.sql.exec<OutboxRow>(`SELECT * FROM outbox WHERE expires_at <= ?`, now).toArray();
    for (const r of rows) {
      this.sql.exec(`DELETE FROM outbox WHERE installation = ? AND seq = ?`, r.installation, r.seq);
      this.sql.exec(`INSERT OR REPLACE INTO expired (env_id, sender, task, to_addr) VALUES (?, ?, ?, ?)`, r.env_id, r.sender, r.task, r.to_addr);
    }
    return rows.map((r) => ({ sender: r.sender, env_id: r.env_id, task: r.task, to_addr: r.to_addr }));
  }

  /** Dedupe ids are kept a day past the expiry, then forgotten. */
  forgetRouted(before: number): void {
    this.sql.exec(`DELETE FROM routed WHERE at < ?`, before);
  }

  expiredFor(sender: string): { env_id: string; task: string; to_addr: string }[] {
    return this.sql.exec<{ env_id: string; task: string; to_addr: string }>(`SELECT env_id, task, to_addr FROM expired WHERE sender = ?`, sender).toArray();
  }

  clearExpired(envId: string): void {
    this.sql.exec(`DELETE FROM expired WHERE env_id = ?`, envId);
  }

  nextExpiry(): number | undefined {
    const r = this.sql.exec<{ e: number | null }>(`SELECT MIN(expires_at) AS e FROM outbox`).one();
    return r.e ?? undefined;
  }

  removedList(): { installation: string; at: string }[] {
    return this.sql.exec<{ installation: string; at: string }>(`SELECT installation, at FROM removed ORDER BY installation`).toArray();
  }

  /**
   * Align with the configuration: an installation enrolled before and gone now is tombstoned and its
   * outbox and expiry reports dropped; one (re-)enrolled loses its tombstone. Returns who was removed.
   */
  syncEnrolment(configured: string[], at: string): string[] {
    const before = this.sql.exec<{ installation: string }>(`SELECT installation FROM enrolled`).toArray().map((r) => r.installation);
    const gone = before.filter((i) => !configured.includes(i));
    for (const i of gone) {
      this.sql.exec(`INSERT OR REPLACE INTO removed (installation, at) VALUES (?, ?)`, i, at);
      this.sql.exec(`DELETE FROM outbox WHERE installation = ?`, i);
      this.sql.exec(`DELETE FROM seqs WHERE installation = ?`, i);
      this.sql.exec(`DELETE FROM expired WHERE sender = ?`, i);
      this.sql.exec(`DELETE FROM enrolled WHERE installation = ?`, i);
    }
    for (const i of configured) {
      this.sql.exec(`INSERT OR IGNORE INTO enrolled (installation) VALUES (?)`, i);
      this.sql.exec(`DELETE FROM removed WHERE installation = ?`, i);
    }
    return gone;
  }
}
