// The tenant's decisions as the store reads them (owen-ops docs/PLAN.md → "Contracts"). The
// tenant's review session — running in the sandbox — decides which FRAGMENT of Owen's day belongs
// to which initiative and commits that to its repo; the bot only INDEXES those decisions at build
// time so `search(initiative=…)` can filter by them. Interpretation never happens here.
//
//   annotations/fragments.jsonl   append-only; the last line per `id` wins; `superseded` is ignored
//   annotations/people.json       people + identities + markers (people.ts)
//
// Who decided: `rule` | `model` | `owen` (the owner, the CLI's literal) | `human:<person_id>` (a person, any tenant).
// A `human:<id>` line keeps parsing as `model` for the plan, exactly as before; its decider rides in `decider`, which
// only the learning loop reads (attribution/learn-load.ts) — as it reads what the machine said BEFORE the answer
// (`guess`, `conf`, `rung`), the question's `answer` id (lines of one answer are one observation) and `audit: true`
// (a re-asked auto-decision). Without those fields a line parses exactly as before.
//
// Pure: parse + validate + flatten into attribution rows. A malformed line is skipped and
// counted (a tenant mistake must not take the bot's build down), a malformed people file is not
// (people.ts throws — identity resolution silently going wrong is worse than a visible failure).
import { existsSync, readFileSync } from 'node:fs';

export type FragmentKind = 'call' | 'thread' | 'work';
export type DecidedBy = 'rule' | 'model' | 'owen';
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
const DECIDERS: readonly string[] = ['rule', 'model', 'owen'];
const STATUSES: readonly string[] = ['decided', 'escalated', 'superseded'];
/** A person as decider: `human:<person_id>` (people.json's id shape). */
const HUMAN_DECIDER = /^human:[a-z0-9][a-z0-9._-]{0,63}$/;

/** Is this decider a person — the owner (`owen`) or `human:<id>`? Only a person's lines are evidence for the learning loop. */
export const isHumanDecider = (d: string | null | undefined): boolean => d === 'owen' || HUMAN_DECIDER.test(d ?? '');

/** Did a person decide this ledger line? */
export const isHumanLine = (f: Pick<Fragment, 'decided_by' | 'decider'>): boolean => isHumanDecider(f.decider ?? f.decided_by);

export function parseFragment(raw: unknown): Fragment | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
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
    decided_by: typeof r.decided_by === 'string' && DECIDERS.includes(r.decided_by) ? (r.decided_by as DecidedBy) : 'model',
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
export function parseFragments(text: string): { fragments: Fragment[]; malformed: number } {
  const byId = new Map<string, Fragment>();
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let f: Fragment | undefined;
    try {
      f = parseFragment(JSON.parse(line));
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

export function loadFragments(path: string | undefined): { fragments: Fragment[]; malformed: number } {
  if (!path || !existsSync(path)) return { fragments: [], malformed: 0 };
  return parseFragments(readFileSync(path, 'utf8'));
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
