// The hub's state in its Durable Object's SQLite (design D3; `hub-open-network`, design N1, N3, N6).
// Everything the hub knows survives an eviction here, or in the sockets' attachments; the object keeps
// nothing in memory between messages.
//   outbox   — per recipient installation, strictly increasing seq, the envelope (the clear header and
//              the ciphertext, re-serialized from the known fields only), its sender and size; deleted on
//              ack. Installations only: no agent, method or task (N5)
//   seqs     — the next seq per installation
//   routed   — envelope ids already routed, so a re-sent envelope is answered `routed` and stored once
//   expired  — expiry reports owed to a sender (by envelope id), delivered now or on its next connection
//   removed  — tombstones: a released or revoked name, so its removal reaches those who allowed it even
//              with an empty outbox; cleared when the name is claimed again
//   names    — the names claimed first come, first served: the key, when claimed and last seen. Reserved
//              names live in the configuration, not here
//   allow    — each installation's allow list: whom it hears from (N3)
//   claims   — new names claimed per IP address per day (the claim limit)
export const SCHEMA_VERSION = 2;

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
  // Version 2 (N6): installation-level rows. Version-1 rows go: no version-2 client can read them, and
  // only the operator's canary envelopes ever waited in them (their tasks end by the bots' own expiry).
  2: [
    `DROP TABLE IF EXISTS outbox`,
    `DROP TABLE IF EXISTS expired`,
    `DROP TABLE IF EXISTS removed`,
    `DROP TABLE IF EXISTS enrolled`,
    `DELETE FROM seqs`,
    `DELETE FROM routed`,
    `CREATE TABLE IF NOT EXISTS outbox (installation TEXT NOT NULL, seq INTEGER NOT NULL, env_id TEXT NOT NULL, sender TEXT NOT NULL,
       size INTEGER NOT NULL, routed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, env TEXT NOT NULL, PRIMARY KEY (installation, seq))`,
    `CREATE INDEX IF NOT EXISTS outbox_expires ON outbox (expires_at)`,
    `CREATE INDEX IF NOT EXISTS outbox_pair ON outbox (installation, sender)`,
    `CREATE TABLE IF NOT EXISTS expired (env_id TEXT PRIMARY KEY, sender TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS removed (name TEXT PRIMARY KEY, at TEXT NOT NULL, reason TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS names (name TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, claimed_at INTEGER NOT NULL, last_seen INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS allow (installation TEXT NOT NULL, peer TEXT NOT NULL, PRIMARY KEY (installation, peer))`,
    `CREATE INDEX IF NOT EXISTS allow_peer ON allow (peer)`,
    `CREATE TABLE IF NOT EXISTS claims (ip TEXT NOT NULL, day INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (ip, day))`,
  ],
};

export type OutboxRow = {
  installation: string;
  seq: number;
  env_id: string;
  sender: string;
  size: number;
  routed_at: number;
  expires_at: number;
  env: string;
};
export type NameRow = {
  name: string;
  key: string;
  claimed_at: number;
  last_seen: number;
};
export type Tombstone = {
  name: string;
  at: string;
  reason: string;
};

const HOUR_MS = 3_600_000;

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

  // ── outboxes ──────────────────────────────────────────────────────────────────────────────────
  outboxSize(installation: string): { count: number; bytes: number } {
    const r = this.sql.exec<{ c: number; b: number | null }>(`SELECT COUNT(*) AS c, SUM(size) AS b FROM outbox WHERE installation = ?`, installation).one();
    return { count: r.c, bytes: r.b ?? 0 };
  }

  /** What one sender has waiting for one recipient (the pair cap, N6). */
  pairSize(installation: string, sender: string): { count: number; bytes: number } {
    const r = this.sql.exec<{ c: number; b: number | null }>(`SELECT COUNT(*) AS c, SUM(size) AS b FROM outbox WHERE installation = ? AND sender = ?`, installation, sender).one();
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
      `INSERT INTO outbox (installation, seq, env_id, sender, size, routed_at, expires_at, env) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      r.installation, seq, r.env_id, r.sender, r.size, r.routed_at, r.expires_at, r.env,
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
  expire(now: number): { sender: string; env_id: string; installation: string; size: number }[] {
    const rows = this.sql.exec<OutboxRow>(`SELECT * FROM outbox WHERE expires_at <= ?`, now).toArray();
    for (const r of rows) {
      this.sql.exec(`DELETE FROM outbox WHERE installation = ? AND seq = ?`, r.installation, r.seq);
      this.sql.exec(`INSERT OR REPLACE INTO expired (env_id, sender) VALUES (?, ?)`, r.env_id, r.sender);
    }
    return rows.map((r) => ({ sender: r.sender, env_id: r.env_id, installation: r.installation, size: r.size }));
  }

  /** Dedupe ids are kept a day past the expiry, then forgotten. */
  forgetRouted(before: number): void {
    this.sql.exec(`DELETE FROM routed WHERE at < ?`, before);
  }

  expiredFor(sender: string): { env_id: string }[] {
    return this.sql.exec<{ env_id: string }>(`SELECT env_id FROM expired WHERE sender = ?`, sender).toArray();
  }

  clearExpired(envId: string): void {
    this.sql.exec(`DELETE FROM expired WHERE env_id = ?`, envId);
  }

  nextExpiry(): number | undefined {
    const r = this.sql.exec<{ e: number | null }>(`SELECT MIN(expires_at) AS e FROM outbox`).one();
    return r.e ?? undefined;
  }

  // ── names (N1) ───────────────────────────────────────────────────────────────────────────────
  nameRow(name: string): NameRow | undefined {
    return this.sql.exec<NameRow>(`SELECT * FROM names WHERE name = ?`, name).toArray()[0];
  }
  nameOfKey(key: string): string | undefined {
    return this.sql.exec<{ name: string }>(`SELECT name FROM names WHERE key = ?`, key).toArray()[0]?.name;
  }
  claimedNames(): NameRow[] {
    return this.sql.exec<NameRow>(`SELECT * FROM names ORDER BY name`).toArray();
  }
  /** Bind a free name to a key; a tombstone of an earlier holder is lifted. */
  claim(name: string, key: string, now: number): void {
    this.sql.exec(`INSERT INTO names (name, key, claimed_at, last_seen) VALUES (?, ?, ?, ?)`, name, key, now, now);
    this.sql.exec(`DELETE FROM removed WHERE name = ?`, name);
  }
  /** The claim goes, nothing else: the name became reserved for the same key. */
  unclaim(name: string): void {
    this.sql.exec(`DELETE FROM names WHERE name = ?`, name);
  }
  /** Mark a claimed name seen; rounded to the hour, so an idle hub writes once per connection at most. */
  touch(name: string, now: number): void {
    this.sql.exec(`UPDATE names SET last_seen = ? WHERE name = ? AND last_seen < ?`, now, name, now - HOUR_MS);
  }
  idleNames(before: number): string[] {
    return this.sql.exec<{ name: string }>(`SELECT name FROM names WHERE last_seen < ? ORDER BY name`, before).toArray().map((r) => r.name);
  }

  /** New names claimed from one IP address on one day (UTC day number). */
  claimCount(ip: string, day: number): number {
    return this.sql.exec<{ count: number }>(`SELECT count FROM claims WHERE ip = ? AND day = ?`, ip, day).toArray()[0]?.count ?? 0;
  }
  countClaim(ip: string, day: number): void {
    this.sql.exec(`INSERT INTO claims (ip, day, count) VALUES (?, ?, 1) ON CONFLICT (ip, day) DO UPDATE SET count = count + 1`, ip, day);
    this.sql.exec(`DELETE FROM claims WHERE day < ?`, day - 1);
  }

  // ── removals ─────────────────────────────────────────────────────────────────────────────────
  tombstones(): Tombstone[] {
    return this.sql.exec<Tombstone>(`SELECT name, at, reason FROM removed ORDER BY name`).toArray();
  }
  isTombstoned(name: string): boolean {
    return this.sql.exec(`SELECT 1 FROM removed WHERE name = ?`, name).toArray().length > 0;
  }
  /**
   * A released or revoked name: tombstoned, its claim, outbox, expiry reports and allow list dropped.
   * Others' allow lists that name it stay — their bots drop it when their operators unpin it — so the
   * removal keeps reaching them.
   */
  remove(name: string, at: string, reason: string): void {
    this.sql.exec(`INSERT OR REPLACE INTO removed (name, at, reason) VALUES (?, ?, ?)`, name, at, reason);
    this.sql.exec(`DELETE FROM names WHERE name = ?`, name);
    this.sql.exec(`DELETE FROM outbox WHERE installation = ?`, name);
    this.sql.exec(`DELETE FROM seqs WHERE installation = ?`, name);
    this.sql.exec(`DELETE FROM expired WHERE sender = ?`, name);
    this.sql.exec(`DELETE FROM allow WHERE installation = ?`, name);
  }
  /** A reserved name admitted again (its operator re-reserved it): the tombstone goes. */
  lift(name: string): void {
    this.sql.exec(`DELETE FROM removed WHERE name = ?`, name);
  }

  // ── allow lists (N3) ─────────────────────────────────────────────────────────────────────────
  allowOf(installation: string): string[] {
    return this.sql.exec<{ peer: string }>(`SELECT peer FROM allow WHERE installation = ? ORDER BY peer`, installation).toArray().map((r) => r.peer);
  }
  allows(installation: string, peer: string): boolean {
    return this.sql.exec(`SELECT 1 FROM allow WHERE installation = ? AND peer = ?`, installation, peer).toArray().length > 0;
  }
  /** The installations whose allow list names `peer`. */
  allowedBy(peer: string): string[] {
    return this.sql.exec<{ installation: string }>(`SELECT installation FROM allow WHERE peer = ? ORDER BY installation`, peer).toArray().map((r) => r.installation);
  }
  setAllow(installation: string, peers: readonly string[]): void {
    this.sql.exec(`DELETE FROM allow WHERE installation = ?`, installation);
    for (const p of peers) this.sql.exec(`INSERT OR IGNORE INTO allow (installation, peer) VALUES (?, ?)`, installation, p);
  }
}
