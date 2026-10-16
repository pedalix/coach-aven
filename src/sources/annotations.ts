// The tenant's decisions as the store reads them (owen-ops docs/PLAN.md → "Contracts"). The
// tenant's review session — running in the sandbox — decides which FRAGMENT of Owen's day belongs
// to which initiative and commits that to its repo; the bot only INDEXES those decisions at build
// time so `search(initiative=…)` can filter by them. Interpretation never happens here.
//
//   annotations/fragments.jsonl   append-only; the last line per `id` wins; `superseded` is ignored
//   annotations/people.json       people + identities + markers (people.ts)
//
// Who decided: `rule` | `model` | `owner` (the tenant's owner) | `human:<person_id>` (a person, any tenant). A tenant
// whose own tooling writes another literal for the owner names it in attribution.json (`ownerDecider`); lines carrying
// that literal parse as `owner` (DeciderOpts) — the code knows no owner name of its own.
// A `human:<id>` line keeps parsing as `model` for the plan, exactly as before; its decider rides in `decider`, which
// only the learning loop reads (attribution/learn-load.ts) — as it reads what the machine said BEFORE the answer
// (`guess`, `conf`, `rung`), the question's `answer` id (lines of one answer are one observation) and `audit: true`
// (a re-asked auto-decision). Without those fields a line parses exactly as before.
//
// Pure: parse + validate + flatten into attribution rows. A malformed line is skipped and
// counted (a tenant mistake must not take the bot's build down), a malformed people file is not
// (people.ts throws — identity resolution silently going wrong is worse than a visible failure).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type FragmentKind = 'call' | 'thread' | 'work';
export type DecidedBy = 'rule' | 'model' | 'owner';
export type FragmentStatus = 'decided' | 'escalated' | 'superseded';

export interface Attribution {
  initiative: string;
  share: number;
}

export interface Fragment {
  id: string;
  kind: FragmentKind;
  start: string;
  end: string;
  refs: string[];
  attributions: Attribution[];
  decided_by: DecidedBy;
  rule_id?: string | null;
  rationale?: string;
  decided_at?: string;
  status: FragmentStatus;
  /** `human:<person_id>` when a person other than the owner's literal decided (decided_by then reads `model`, as before). */
  decider?: string;
  /** The question this line answers: lines of one answer are ONE observation for the learning loop. */
  answer?: string;
  /** What the machine proposed before the person answered (null: it had nothing), its confidence and rung instance. */
  guess?: string | null;
  conf?: number;
  rung?: string;
  /** An audit: the person re-checked a decision the machine had made on its own. */
  audit?: boolean;
}

export interface AttributionRow {
  ref: string;
  initiative: string;
  share: number;
  fragment_id: string;
  decided_by: DecidedBy;
}

const KINDS: readonly string[] = ['call', 'thread', 'work'];
export const OWNER: DecidedBy = 'owner';
const DECIDERS: readonly string[] = ['rule', 'model', OWNER];
const STATUSES: readonly string[] = ['decided', 'escalated', 'superseded'];
/** A person as decider: `human:<person_id>` (people.json's id shape). */
const HUMAN_DECIDER = /^human:[a-z0-9][a-z0-9._-]{0,63}$/;

/** How a tenant's ledger names its owner: `ownerDecider` (attribution.json) is read as `owner`. Absent: only `owner` is. */
export interface DeciderOpts {
  ownerDecider?: string;
}

/** A usable `ownerDecider`: a plain lowercase literal, not one of the canonical deciders and never `human:…`. */
export const isOwnerDeciderAlias = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(v) && !DECIDERS.includes(v);

/** A raw decider as the code reads it: the tenant's owner literal becomes `owner`, anything else is unchanged. */
export const canonicalDecider = (d: string, o: DeciderOpts = {}): string => (o.ownerDecider && d === o.ownerDecider ? OWNER : d);

/**
 * The tenant's owner literal from `<annotationsDir>/attribution.json`, for the readers that parse the ledger before (or
 * without) the attribution config: undefined when there is no file, no field, or anything unreadable — the config parse
 * (attribution/config.ts) is where a bad value is reported.
 */
export function readOwnerDecider(annotationsDir: string | undefined): string | undefined {
  if (!annotationsDir) return undefined;
  const p = join(annotationsDir, 'attribution.json');
  try {
    if (!existsSync(p)) return undefined;
    const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown;
    const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).ownerDecider : undefined;
    return isOwnerDeciderAlias(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Is this decider a person — the owner (`owner`, or the tenant's literal for it) or `human:<id>`? Only a person's lines are evidence for the learning loop. */
export const isHumanDecider = (d: string | null | undefined, o: DeciderOpts = {}): boolean => (d != null && canonicalDecider(d, o) === OWNER) || HUMAN_DECIDER.test(d ?? '');

/** Did a person decide this ledger line? */
export const isHumanLine = (f: Pick<Fragment, 'decided_by' | 'decider'>): boolean => isHumanDecider(f.decider ?? f.decided_by);

export function parseFragment(raw: unknown, o: DeciderOpts = {}): Fragment | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const by = typeof r.decided_by === 'string' ? canonicalDecider(r.decided_by, o) : undefined;
  if (typeof r.id !== 'string' || !r.id) return undefined;
  const status = typeof r.status === 'string' && STATUSES.includes(r.status) ? (r.status as FragmentStatus) : 'decided';
  const refs = Array.isArray(r.refs) ? r.refs.filter((x): x is string => typeof x === 'string' && !!x) : [];
  const attributions = (Array.isArray(r.attributions) ? r.attributions : [])
    .map((a) => (a && typeof a === 'object' ? (a as Record<string, unknown>) : {}))
    .filter((a) => typeof a.initiative === 'string' && a.initiative)
    .map((a) => ({ initiative: a.initiative as string, share: typeof a.share === 'number' && a.share > 0 ? Math.min(1, a.share) : 1 }));
  return {
    id: r.id,
    kind: typeof r.kind === 'string' && KINDS.includes(r.kind) ? (r.kind as FragmentKind) : 'thread',
    start: typeof r.start === 'string' ? r.start : '',
    end: typeof r.end === 'string' ? r.end : '',
    refs,
    attributions,
    decided_by: by !== undefined && DECIDERS.includes(by) ? (by as DecidedBy) : 'model',
    ...(typeof r.rule_id === 'string' ? { rule_id: r.rule_id } : {}),
    ...(typeof r.rationale === 'string' ? { rationale: r.rationale } : {}),
    ...(typeof r.decided_at === 'string' ? { decided_at: r.decided_at } : {}),
    status,
    // The learning loop's fields: present only when the line carries them, so an older line's parse is unchanged.
    ...(typeof r.decided_by === 'string' && HUMAN_DECIDER.test(r.decided_by) ? { decider: r.decided_by } : {}),
    ...(typeof r.answer === 'string' && r.answer ? { answer: r.answer } : {}),
    ...(typeof r.guess === 'string' || r.guess === null ? { guess: r.guess as string | null } : {}),
    ...(typeof r.conf === 'number' && Number.isFinite(r.conf) && r.conf >= 0 && r.conf <= 1 ? { conf: r.conf } : {}),
    ...(typeof r.rung === 'string' && r.rung ? { rung: r.rung } : {}),
    ...(r.audit === true ? { audit: true } : {}),
  };
}

/** Last line per id wins; superseded fragments are dropped. Returns live fragments + the number of unusable lines. */
export function parseFragments(text: string, o: DeciderOpts = {}): { fragments: Fragment[]; malformed: number } {
  const byId = new Map<string, Fragment>();
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let f: Fragment | undefined;
    try {
      f = parseFragment(JSON.parse(line), o);
    } catch {
      f = undefined;
    }
    if (!f) {
      malformed++;
      continue;
    }
    byId.delete(f.id); // keep insertion order = order of the latest version
    byId.set(f.id, f);
  }
  return { fragments: [...byId.values()].filter((f) => f.status !== 'superseded'), malformed };
}

export function loadFragments(path: string | undefined, o: DeciderOpts = {}): { fragments: Fragment[]; malformed: number } {
  if (!path || !existsSync(path)) return { fragments: [], malformed: 0 };
  return parseFragments(readFileSync(path, 'utf8'), o);
}

/**
 * Store refs are `<source>:<account>:<id>`. The contract also allows a typed shorthand
 * `meeting:<source>:<id>` (account-free — the review session may not know which account a
 * recorder filed a call under); `resolve` maps such refs onto real store refs.
 */
export function attributionRows(fragments: readonly Fragment[], resolve: (ref: string) => string[] = (r) => [r]): AttributionRow[] {
  const out: AttributionRow[] = [];
  for (const f of fragments) {
    if (f.status !== 'decided' || !f.attributions.length) continue;
    for (const raw of f.refs) {
      for (const ref of resolve(raw)) {
        for (const a of f.attributions) out.push({ ref, initiative: a.initiative, share: a.share, fragment_id: f.id, decided_by: f.decided_by });
      }
    }
  }
  return out;
}
