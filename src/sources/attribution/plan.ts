// The plan for a horizon: every fragment with its effective decision, plus rule proposals.
//   decided   — the tenant ledger (annotations/fragments.jsonl) has a live decision for it (whoever made it),
//               or the platform pinned a rule decision once its day closed (pins.ts)
//   escalated — the ledger has an open question for it (a human answers)
//   rule      — the ledger has nothing; the ladder decides it now (deterministic, from tenant data)
//   open      — the ledger has nothing and the ladder only narrows: candidates + hint for a judgment
// The ledger wins: the ladder never re-decides what is recorded. A fragment is covered by a record with its
// id or — for message runs — by a record whose refs overlap (a review window that cut a run elsewhere
// produced another id for the same messages), and a call also by a record or pin under the id one of its other
// recorder copies would have given it (fragment.ts aliases: a copy that lands later may rename the call). Rule
// proposals: ported from the owen-ops CLI (plan.ts).
import type { FragmentDraft } from './fragment.js';
import { attribute, type Attribution, type LadderCtx, type RuleRecord } from './ladder.js';
import type { Pin } from './pins.js';

export type DecidedBy = 'rule' | 'model' | 'owen';
export interface LedgerRecord {
  id: string;
  kind: string;
  refs: string[];
  attributions: Attribution[];
  decided_by: DecidedBy;
  rule_id?: string | null;
  rationale?: string;
  status: 'decided' | 'escalated' | 'superseded';
}

export type State = 'decided' | 'escalated' | 'rule' | 'open';
export const STATES: readonly State[] = ['decided', 'escalated', 'rule', 'open'];

export interface Planned {
  draft: FragmentDraft;
  state: State;
  decided_by: DecidedBy | null;
  attributions: Attribution[];
  rule_id: string | null;
  rationale: string;
  candidates: string[];
  hint: string;
  /** The ledger record covering this fragment (its own id, an overlapping run's, or a call's alias). */
  ledger_id: string | null;
  /** Set when a pinned rule decision is in effect (no ledger record covers the fragment). */
  pinned_at?: string;
  rules_version?: string;
}

export interface Proposal {
  id: string;
  question: string;
  options: string[];
  refs: string[];
}

/** Last line per id already applied by the caller; superseded records are not decisions. */
function live(ledger: ReadonlyMap<string, LedgerRecord>): Map<string, LedgerRecord> {
  return new Map([...ledger].filter(([, r]) => r.status !== 'superseded'));
}

/** Precedence: the ledger, then a pin, then the ladder. */
export function planFragments(drafts: FragmentDraft[], ledger: ReadonlyMap<string, LedgerRecord>, ctx: LadderCtx, pins: ReadonlyMap<string, Pin> = new Map()): Planned[] {
  const records = live(ledger);
  const threadByRef = new Map<string, LedgerRecord>();
  for (const r of records.values()) if (r.kind === 'thread') for (const ref of r.refs) threadByRef.set(ref, r);
  return drafts.map((d) => {
    // A call answers to its own id, then to the ids its other recorder copies would have given it: a copy that lands after
    // the review but started earlier renames the call (fragment.ts copyOrder), and the judgment or pin under the old name
    // must not detach — else the ladder re-decides a judged call and, its day closed, pins that over the person's answer.
    const ids = d.kind === 'call' && d.aliases?.length ? [d.id, ...d.aliases] : [d.id];
    const rec = ids.map((id) => records.get(id)).find((r) => !!r) ?? (d.kind === 'thread' ? d.refs.map((ref) => threadByRef.get(ref)).find((r) => !!r) : undefined);
    if (rec) {
      return {
        draft: d,
        state: rec.status === 'escalated' ? 'escalated' : 'decided',
        decided_by: rec.decided_by,
        attributions: rec.attributions,
        rule_id: rec.rule_id ?? null,
        rationale: rec.rationale ?? '',
        candidates: [],
        hint: '',
        ledger_id: rec.id,
      } satisfies Planned;
    }
    const pin = ids.map((id) => pins.get(id)).find((p) => !!p);
    if (pin) {
      return { draft: d, state: 'decided', decided_by: 'rule', attributions: pin.attributions, rule_id: pin.rule_id, rationale: pin.rationale, candidates: [], hint: '', ledger_id: null, pinned_at: pin.pinned_at, rules_version: pin.rules_version } satisfies Planned;
    }
    const r = attribute(d, ctx);
    if (r.decided) return { draft: d, state: 'rule', decided_by: 'rule', attributions: r.decided.attributions, rule_id: r.decided.rule_id, rationale: `${d.title}: ${r.decided.rationale}`, candidates: r.candidates, hint: r.hint, ledger_id: null } satisfies Planned;
    return { draft: d, state: 'open', decided_by: null, attributions: [], rule_id: null, rationale: '', candidates: r.candidates, hint: r.hint, ledger_id: null } satisfies Planned;
  });
}

export const PROPOSAL_MIN = 3;
/** The winning initiative must hold this share of the subject's single-initiative judgments. */
export const PROPOSAL_PURITY = 0.9;
/** A competing initiative with more fragments than this blocks a proposal even when purity holds. */
export const PROPOSAL_MAX_COMPETING = 1;

/**
 * Rule proposals from recorded judgments (model/owen) joined with the fragments' context: a person (not a broad
 * marker) or a container whose judged fragments are ≥ 90 % one initiative, at least three of them, no competitor
 * with two, and no existing rule on the same subject. Initiatives are counted after alias resolution.
 */
export function proposeRules(drafts: FragmentDraft[], ledger: ReadonlyMap<string, LedgerRecord>, ctx: LadderCtx): Proposal[] {
  const resolve = (i: string) => ctx.reg.resolveAlias(i);
  const bySubject = new Map<string, { label: string; when: RuleRecord['when']; counts: Map<string, string[]> }>();
  for (const d of drafts) {
    const rec = ledger.get(d.id);
    if (!rec || rec.status !== 'decided' || (rec.decided_by !== 'model' && rec.decided_by !== 'owen')) continue;
    const inis = [...new Set(rec.attributions.map((a) => resolve(a.initiative)))];
    if (inis.length !== 1) continue;
    const ini = inis[0]!;
    const subjects: [string, string, RuleRecord['when']][] = [];
    for (const pid of d.participants) {
      if (pid === ctx.self) continue;
      const person = ctx.people.get(pid);
      if (!person || person.marker.type === 'broad') continue;
      subjects.push([`person:${pid}`, person.name || pid, { person: pid }]);
    }
    if (d.container) subjects.push([`container:${d.container}`, d.container, { container: d.container }]);
    for (const [key, label, when] of subjects) {
      const s = bySubject.get(key) ?? { label, when, counts: new Map<string, string[]>() };
      const ids = s.counts.get(ini) ?? [];
      if (!ids.includes(d.id)) ids.push(d.id);
      s.counts.set(ini, ids);
      bySubject.set(key, s);
    }
  }
  const conflicts = (when: RuleRecord['when']) => ctx.rules.some((r) => (when.person && r.when?.person === when.person) || (when.container && r.when?.container === when.container));
  const out: Proposal[] = [];
  for (const [key, s] of bySubject) {
    const ranked = [...s.counts.entries()].sort((a, b) => b[1].length - a[1].length);
    const [ini, refs] = ranked[0]!;
    const total = ranked.reduce((n, [, r]) => n + r.length, 0);
    if (refs.length < PROPOSAL_MIN) continue;
    if (refs.length / total < PROPOSAL_PURITY) continue;
    if (ranked.slice(1).some(([, r]) => r.length > PROPOSAL_MAX_COMPETING)) continue;
    if (conflicts(s.when)) continue;
    const k = `${key}→${ini}`;
    out.push({
      id: `esc-rule-${k.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase().slice(0, 80)}`,
      question: `${refs.length} of ${total} fragments with ${s.label} were ${ini}. Make it a rule?`,
      options: [`yes: ${JSON.stringify(s.when)} → ${ini}`, 'no'],
      refs: refs.slice(0, 10),
    });
  }
  return out;
}
