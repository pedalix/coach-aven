// The learning loop's Earned Keys (design notes 10 §3; ported from the lab bench's src/lab/variants/keys/{spec,learner,
// extract}.ts, where iteration 1 measured it — the bench copy stays). An answer is about a KEY, not a unit: "this alert
// family is the shop", "this mail subject is the retainer". A key is a typed fingerprint of a unit (its thread, its
// sender's template, its host, its channel …) that L2 derives from the store; this file only learns from them.
//
//   prior   Beta(a, b) per TYPE: a hypothesis about its homophily — how often a later unit with the same key carries the
//           key's label. k: how many independent answers one key needs before it may predict at all.
//   table   per key: the labels people gave its units, one observation per answer id (twelve alerts answered together
//           are one fact about their family, not twelve). Two labels on one key: it never predicts again.
//   trial   a consistent key that predicted a unit a person then labelled moves its TYPE's Beta (one per key × answer).
//           conf = the type's posterior mean, so a type decides only while its MEASURED precision stays ≥ τ.
//
// THE INVARIANT (§3.1): only what a person said (answers, audits) and the tenant's seed rows reach a table or a trial —
// never the floor's decisions, never this learner's own. On the bench, counting machine rows as evidence took weekly
// precision from 100% to 81%. Pure: no I/O, no clock, no model.

export type KeyType =
  | 'thread' // items: the thread root, or the ticket of a comment
  | 'family' // bot/bulk items: sender + 6-token template + host/app token
  | 'host' // bot items: a hostname the item is about
  | 'app' // bot items: a deploy/app token
  | 'subject' // mail: normalised subject + counterpart domain
  | 'container' // human chat items: the channel or the DM
  | 'domain' // mail: the counterpart's domain (never a free-mail one)
  | 'sender' // human items: the author
  | 'series' // call fragments: a recurring call title
  | 'run' // thread fragments: the container of the run
  | 'cpset' // call/thread fragments: the sorted counterparts
  | 'token' // fragments and items: a rare title/subject word
  | 'cowork' // call/thread fragments: the label of a work block decided by structure next to it (the value IS the label)
  | 'form' // identities: a folded surface form
  | 'ctx'; // K2a: the floor's rung instance itself (`ctx=key:VN`) — what the answers on a route's units say about the route

export interface TypeSpec {
  a: number;
  b: number;
  k: number;
  direct?: boolean; // the key's value IS its label: no table to learn (cowork)
}

// §3.2 — the bench's priors (hypotheses it tests, not tuned values: weak types start low on purpose), plus K2a's ctx.
// ctx is a PLACE-like key (a channel, a tracker prefix, a rule): container's .80 prior, but k = 3 — on the bench a route
// with siblings was right about half the time, and two lucky answers in a row are a 1-in-4 event there.
export const KEY_TYPES: Readonly<Record<KeyType, TypeSpec>> = {
  thread: { a: 19, b: 1, k: 1 },
  family: { a: 19, b: 1, k: 1 },
  host: { a: 19, b: 1, k: 1 },
  app: { a: 19, b: 1, k: 1 },
  subject: { a: 9, b: 1, k: 1 },
  container: { a: 8, b: 2, k: 2 },
  domain: { a: 8, b: 2, k: 2 },
  sender: { a: 2, b: 3, k: 3 },
  series: { a: 4, b: 2, k: 2 },
  run: { a: 2, b: 3, k: 3 },
  cpset: { a: 2, b: 3, k: 3 },
  token: { a: 4, b: 2, k: 3 },
  cowork: { a: 2, b: 2, k: 0, direct: true },
  form: { a: 39, b: 1, k: 1 },
  ctx: { a: 8, b: 2, k: 3 },
};

export const isKeyType = (t: string): t is KeyType => Object.prototype.hasOwnProperty.call(KEY_TYPES, t);

// A key id is "<type>=<value>"; the value may hold anything (titles, hosts, sets), the type never holds '='.
export const keyId = (type: KeyType, value: string): string => `${type}=${value}`;
export const typeOf = (key: string): KeyType => key.slice(0, key.indexOf('=')) as KeyType;
export const valueOf = (key: string): string => key.slice(key.indexOf('=') + 1);

// --- pool statistics: which candidate keys may speak today ------------------------------------------------------------
// A series speaks once seen on ≥ 2 calls; a token while it stays rare (df ≤ 5% of the units seen so far). These come from
// the stream itself (every unit, decided or not), never from labels — and per unit kind (a fragment title's word and an
// item subject's word live in different vocabularies).

export const TOKEN_MAX_DF = 0.05;
export const SERIES_MIN_CASES = 2;

export interface PoolStats {
  seen: number;
  df: Map<string, number>; // token value → units carrying it
  series: Map<string, Set<string>>; // series value → the cases (calls) it was seen on
}

export const newPool = (): PoolStats => ({ seen: 0, df: new Map(), series: new Map() });

/** Count one unit's candidate keys in (call once per unit). */
export function notePool(stats: PoolStats, keys: readonly string[], caseKey: string): void {
  stats.seen++;
  for (const k of keys) {
    const t = typeOf(k);
    if (t === 'token') stats.df.set(valueOf(k), (stats.df.get(valueOf(k)) ?? 0) + 1);
    else if (t === 'series') {
      const cases = stats.series.get(valueOf(k)) ?? new Set<string>();
      cases.add(caseKey);
      stats.series.set(valueOf(k), cases);
    }
  }
}

export function isActive(stats: PoolStats, key: string): boolean {
  const t = typeOf(key);
  if (t === 'series') return (stats.series.get(valueOf(key))?.size ?? 0) >= SERIES_MIN_CASES;
  if (t === 'token') return (stats.df.get(valueOf(key)) ?? 0) <= TOKEN_MAX_DF * Math.max(1, stats.seen);
  return true;
}

// --- the learner ------------------------------------------------------------------------------------------------------

export interface KeyEntry {
  labels: Map<string, number>; // label → answers that gave it
  obs: Set<string>; // answer ids counted
  n: number; // independent answers
}

export interface KeyPrediction {
  key: string;
  type: KeyType;
  label: string;
  conf: number; // h_T + 0.001·min(n, 9): the type's measured homophily, more answers break ties
  n: number;
}

export interface Beta {
  a: number;
  b: number;
}

export class Learner {
  readonly tables = new Map<string, KeyEntry>();
  readonly rel: Record<KeyType, Beta>;
  readonly trials = { success: 0, failure: 0 };
  private readonly done = new Set<string>(); // key × answer id: one trial each

  constructor(readonly spec: Readonly<Record<KeyType, TypeSpec>> = KEY_TYPES) {
    this.rel = Object.fromEntries(Object.entries(spec).map(([t, s]) => [t, { a: s.a, b: s.b }])) as Record<KeyType, Beta>;
  }

  /** The type's measured homophily: the posterior mean of its Beta. */
  h(type: KeyType): number {
    const r = this.rel[type];
    return r.a / (r.a + r.b);
  }

  /** Would a key of this type decide once it holds its k agreeing answers? */
  decidable(type: KeyType, tau: number): boolean {
    return this.h(type) + 0.001 * Math.min(this.spec[type].k, 9) >= tau;
  }

  /**
   * One answer about one key. The label always joins the key's label set (an answer that labels the key's units two ways
   * contradicts it), but an answer id counts once. Returns whether the answer was new for this key.
   */
  observe(key: string, label: string, answer: string): boolean {
    if (this.spec[typeOf(key)]?.direct) return false;
    let e = this.tables.get(key);
    if (!e) this.tables.set(key, (e = { labels: new Map(), obs: new Set(), n: 0 }));
    if (e.obs.has(answer)) {
      if (!e.labels.has(label)) e.labels.set(label, 1);
      return false;
    }
    e.obs.add(answer);
    e.n++;
    e.labels.set(label, (e.labels.get(label) ?? 0) + 1);
    return true;
  }

  /** Two labels on one key: it never predicts again (§3.6.3 — contradiction is automatic). */
  contradicted(key: string): boolean {
    return (this.tables.get(key)?.labels.size ?? 0) > 1;
  }

  /** A consistent key predicts: ≥ k independent answers, all agreeing. A direct key (cowork) predicts its value. */
  predict(key: string): KeyPrediction | null {
    const type = typeOf(key);
    const s = this.spec[type];
    if (!s) return null;
    if (s.direct) return { key, type, label: valueOf(key), conf: this.h(type), n: 0 };
    const e = this.tables.get(key);
    if (!e || e.labels.size !== 1 || e.n < Math.max(1, s.k)) return null;
    const label = e.labels.keys().next().value as string;
    return { key, type, label, conf: this.h(type) + 0.001 * Math.min(e.n, 9), n: e.n };
  }

  /** A trial of a type: one of its keys predicted a unit a person then labelled. Once per key × answer id. */
  trial(key: string, answer: string, success: boolean): boolean {
    const id = `${key}\u0000${answer}`;
    if (this.done.has(id)) return false;
    this.done.add(id);
    const r = this.rel[typeOf(key)];
    if (!r) return false;
    if (success) {
      r.a++;
      this.trials.success++;
    } else {
      r.b++;
      this.trials.failure++;
    }
    return true;
  }

  /**
   * Keys people confirmed ≥ minN times (one label, never contradicted) of a type measured ≥ minH: each may become a
   * durable tenant rule (an R-question). A thread is not a durable fact and ctx restates a rule that exists — skipped.
   */
  ruleCandidates(minN = 3, minH = 0.9): { key: string; label: string; support: number }[] {
    const out: { key: string; label: string; support: number }[] = [];
    for (const [key, e] of this.tables) {
      const t = typeOf(key);
      if (t === 'thread' || t === 'ctx' || e.labels.size !== 1 || e.n < minN || this.h(t) < minH) continue;
      out.push({ key, label: e.labels.keys().next().value as string, support: e.n });
    }
    return out.sort((a, b) => b.support - a.support || a.key.localeCompare(b.key));
  }
}

// --- the decision (§3.3) --------------------------------------------------------------------------------------------

export interface FloorView {
  label: string | null;
  conf: number;
  rung: string;
  candidates: readonly string[];
  why?: string;
}

export interface KeyDecision {
  label: string | null;
  conf: number;
  rung: string;
  why: string;
  guess: string | null; // what the loop would propose if the unit is asked
  preds: KeyPrediction[]; // every key that predicted, agreeing or not (the trials an answer will record)
}

// A disagreement or a lone floor candidate is a guess only: it must sort below anything the keys agree on.
const SPLIT_PENALTY = 0.5;
const CANDIDATE_CONF = 0.3;

const stronger = (a: KeyPrediction, b: KeyPrediction): number => b.conf - a.conf || b.n - a.n || a.key.localeCompare(b.key);
const short = (s: string, n = 48): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Decide one unit after the floor:
 *   1. the floor decides when its conf ≥ τ (calibration and sibling trust may already have pushed it below);
 *   2. every consistent key predicts its label at h_T (+ a tie-break on the number of answers);
 *   3. all predicting keys agree → that label at the strongest conf (no noisy-OR: keys of one unit are correlated);
 *      they disagree → nothing is decided;
 *   4. otherwise the best guess below τ: the agreeing keys, the strongest key of a split, the floor's own sub-τ label,
 *      its single candidate — whichever is surest — else nothing.
 */
export function decideUnit(floor: FloorView, keys: readonly string[], learner: Learner, tau: number): KeyDecision {
  const preds = keys.map((k) => learner.predict(k)).filter((p): p is KeyPrediction => !!p).sort(stronger);
  const best = preds[0] ?? null;
  if (floor.label !== null && floor.conf >= tau) return { label: floor.label, conf: floor.conf, rung: floor.rung, why: floor.why || `floor ${floor.rung}`, guess: floor.label, preds };
  const labels = new Set(preds.map((p) => p.label));
  const options: { label: string; conf: number; rung: string; why: string }[] = [];
  if (best && labels.size === 1) {
    const why = `${best.type} "${short(valueOf(best.key))}" ${best.n} answer${best.n === 1 ? '' : 's'} · type ${learner.h(best.type).toFixed(3)}${preds.length > 1 ? ` · ${preds.length} keys agree` : ''}`;
    if (best.conf >= tau) return { label: best.label, conf: best.conf, rung: `earned:${best.type}`, why, guess: best.label, preds };
    options.push({ label: best.label, conf: best.conf, rung: `guess:${best.type}`, why });
  } else if (best) {
    options.push({ label: best.label, conf: Math.min(best.conf, tau) * SPLIT_PENALTY, rung: 'guess:split', why: `${labels.size} labels from ${preds.length} keys; strongest ${best.type}` });
  }
  if (floor.label !== null) options.push({ label: floor.label, conf: floor.conf, rung: floor.rung, why: floor.why || `floor ${floor.rung} below τ` });
  else if (floor.candidates.length === 1) options.push({ label: floor.candidates[0]!, conf: CANDIDATE_CONF, rung: 'guess:candidate', why: 'the floor’s only candidate' });
  const pick = options.sort((a, b) => b.conf - a.conf)[0];
  if (!pick) return { label: null, conf: 0, rung: floor.rung || 'abstain', why: floor.why || 'no key, no floor', guess: null, preds };
  // Never a decision from here: a guess stays below τ whatever its source said.
  return { label: pick.label, conf: Math.min(pick.conf, tau - 0.001), rung: pick.rung, why: pick.why, guess: pick.label, preds };
}
