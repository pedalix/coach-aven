// A tiny TTL "seen recently" set over Map insertion order. Powers the Slack Connect
// claim-on-act dedup (events.ts) and the tenant gate's polite-reply cooldown (slack.ts).
// Eviction is an amortized-O(1) front sweep: Map iteration order is insertion order, so
// expired entries cluster at the front — delete until the first fresh one and stop.
// (The naive alternatives both misbehave: a wholesale clear() wipes LIVE cooldowns —
// including the entry just written — and a scan-all sweep is O(n) per call forever once
// the map is big.)

export class RecentSet {
  private seen = new Map<string, number>();

  constructor(private readonly ttlMs: number) {}

  // Mark `key` as seen now. Returns FALSE if it was already seen within the TTL
  // (i.e. the claim is lost / the cooldown is still active); true = first claim.
  claim(key: string, now = Date.now()): boolean {
    this.sweep(now);
    const at = this.seen.get(key);
    if (at !== undefined && now - at < this.ttlMs) return false;
    this.seen.delete(key); // re-insert → moves to the back, keeping front = oldest
    this.seen.set(key, now);
    return true;
  }

  get size(): number {
    return this.seen.size;
  }

  private sweep(now: number): void {
    for (const [k, at] of this.seen) {
      if (now - at < this.ttlMs) break; // fronts are oldest — the rest is fresh
      this.seen.delete(k);
    }
  }
}
