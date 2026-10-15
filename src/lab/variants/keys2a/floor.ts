// K2a (notes/20-iter2.md §K2a) — the trusted floor: stage 0 as K sees it in K2a. Every call goes to the real floor
// (stage0/index.ts, untouched); fragment() and item() then pass each STRUCTURAL decision through the sibling check
// (trust.ts) before K reads it. K is composed unchanged (makeKeys' `floor` option): when the check holds a unit below
// τ, K's own keys decide or guess as they always do.
//
// Per unit the wrapper records what K2a needs later (TrustMeta): the rung instance and its label X, the client, the
// client confidence, the branch, the ctx key. The questions grouping (groups.ts) and the nightly pass read it.
//
// Two confidences per structural unit:
//   initiative  the floor's own — the rung instance calibrated on answers and audits (stage0 §2.5: Beta(20c, 20(1−c)),
//               human rows only, one count per answer id), then capped by trust.ts
//   client      "the umbrella at the rung's confidence": the SAME rung instance calibrated the same way, but on the
//               client question (is the answer one of X's client's initiatives?). The floor's calibration counts an
//               erp-sync answer on a key:VN unit as a miss, which is right for the initiative and wrong for the client
//               — iteration 1 found every such error inside the umbrella — so the client keeps its own count.
// Both move only on human rows (Calibration ignores machine and seed rows): the floor never grades its own homework.
//
// Ablations (`--opt`): siblingScope=umbrella (siblings.ts); ownRouteCues=off — X's own ROUTE cues (its key prefixes and
// channels) stop counting as own cues (they still count against X as a sibling's): a route cannot corroborate another
// route of the same registry entry. The spec counts them (default on).

import { join } from 'node:path';
import type { DayCtx, FragmentUnit, ItemUnit, MemoryRow } from '../../types.js';
import { nameVocab } from '../keys/extract.js';
import { TAU } from '../keys/spec.js';
import { opt } from '../index.js';
import { Calibration } from '../stage0/calibrate.js';
import type { Floor, Stage0 } from '../stage0/index.js';
import type { Reg } from '../stage0/registry.js';
import { loadTenant, type Rule } from '../stage0/tenant.js';
import { cueText, distinctive, hits, initiativeCues, partyTokens, triggerCues, type Cue, type CueVocab } from './cues.js';
import { CtxKeys, CTX_SPEC } from './ctxkeys.js';
import { clientOfLabel, siblingIndex, type Scope, type SiblingScope } from './siblings.js';
import { STRUCTURAL, trust, type Branch } from './trust.js';

export interface TrustMeta {
  instance: string; // the floor's rung instance (what both calibrations charge)
  label: string; // X, the floor's label
  client: string;
  umbrella: string;
  umbrellaConf: number; // the instance's confidence on the client question, at decide time
  branch: Branch;
  ctxKey: string;
  why: string;
}

export interface TenantFacts {
  reg: Reg;
  excluded: Set<string>; // admin buckets and personal labels: never siblings
  rules: Map<string, Rule>;
  vocab: CueVocab;
}

/** The registry facts K2a reads from a dataset's tenant/ (GIVEN data: the registry, rules, people — never gold). */
export function tenantFacts(dir: string, subject: string | null, tz: string): TenantFacts {
  const t = loadTenant(join(dir, 'tenant'), { subject, tz });
  const excluded = new Set<string>([...Object.values(t.admin), ...t.personal]);
  return {
    reg: t.reg,
    excluded,
    rules: new Map(t.rules.map((r) => [r.id, r])),
    vocab: { parties: partyTokens(t.reg), names: nameVocab(t.people).names },
  };
}

export class Trusted {
  readonly floor: Stage0;
  readonly meta = new Map<string, TrustMeta>();
  readonly ctxKeys: CtxKeys;
  readonly client = new Calibration();
  private readonly scopes: Map<string, Scope>;
  private readonly by: SiblingScope;
  private readonly ownRoutes: boolean;
  private readonly cueCache = new Map<string, Map<string, Cue[]>>();
  private readonly memo = new Map<string, Floor>();

  constructor(
    readonly inner: Stage0,
    readonly facts: TenantFacts,
  ) {
    this.by = opt('siblingScope', 'client') === 'umbrella' ? 'umbrella' : 'client';
    this.ownRoutes = opt('ownRouteCues', 'on') !== 'off';
    this.scopes = siblingIndex(facts.reg, facts.excluded, this.by);
    this.ctxKeys = new CtxKeys({ a: opt('ctxA', CTX_SPEC.a), b: opt('ctxB', CTX_SPEC.b), k: opt('ctxK', CTX_SPEC.k) });
    const self = this;
    this.floor = {
      fragment(u: FragmentUnit, pool: FragmentUnit[]) {
        const f = inner.fragment(u, pool);
        return { ...f, ...self.adjust(u.id, u.day, f, cueText(u)) };
      },
      item(u: ItemUnit, pool: ItemUnit[]) {
        const f = inner.item(u, pool);
        return { ...f, ...self.adjust(u.id, u.day, f, cueText(u)) };
      },
      mention: (u) => inner.mention(u),
      kind: (u) => inner.kind(u),
      addressee: (u) => inner.addressee(u),
      dedup: (units) => inner.dedup(units),
      labelSpace: (task) => inner.labelSpace(task),
      cards: () => inner.cards(),
      calibrate: (rows, decided) => inner.calibrate(rows, decided),
      ...(inner.said ? { said: (id: string) => inner.said!(id) } : {}),
      ...(inner.instances ? { instances: () => inner.instances!() } : {}),
    };
  }

  scope(label: string): Scope | undefined {
    return this.scopes.get(label);
  }

  /** X and its siblings' cues, distinctive within the client (cached per X). */
  cues(label: string): Map<string, Cue[]> {
    let c = this.cueCache.get(label);
    if (!c) {
      const sc = this.scopes.get(label);
      const ids = [label, ...(sc?.siblings ?? [])];
      const raw = new Map(ids.map((id) => [id, initiativeCues(this.facts.reg, id, this.facts.vocab)]));
      c = distinctive(raw, ids);
      this.cueCache.set(label, c);
    }
    return c;
  }

  /** The floor's decision after the sibling check (memoised: a unit is decided on its own day only). */
  adjust(id: string, day: string, f: Floor, folded: string): Floor {
    const hit = this.memo.get(id);
    if (hit) return hit;
    const out = this.check(id, day, f, folded);
    this.memo.set(id, out);
    return out;
  }

  private check(id: string, day: string, f: Floor, folded: string): Floor {
    if (!f.label || !STRUCTURAL.test(f.rung)) return f;
    const sc = this.scopes.get(f.label);
    if (!sc || !sc.siblings.length) return f;
    const tau = opt('tau', TAU);
    const cues = this.cues(f.label);
    const ownCues = (cues.get(f.label) ?? []).filter((c) => this.ownRoutes || (c.kind !== 'key' && c.kind !== 'channel'));
    const own = hits(ownCues, folded, triggerCues(f.rung, this.facts.rules));
    const sib = new Map(sc.siblings.map((s) => [s, hits(cues.get(s) ?? [], folded)]));
    const ctxKey = this.ctxKeys.attach(id, f.rung, day);
    const p = this.ctxKeys.predict(id, ctxKey);
    const t = trust({ label: f.label, conf: f.conf, rung: f.rung, siblings: sc.siblings, own, sib, earned: !!p && p.label === f.label && p.conf >= tau });
    const umbrellaConf = this.client.mean(f.rung, f.prior ?? f.conf);
    this.meta.set(id, { instance: f.rung, label: f.label, client: sc.scope, umbrella: sc.umbrella, umbrellaConf, branch: t.branch, ctxKey, why: t.why });
    if (t.label === f.label && t.conf === f.conf && t.rung === f.rung) return { ...f, umbrella: sc.umbrella };
    return {
      ...f,
      label: t.label,
      conf: t.conf,
      rung: t.rung,
      candidates: [...new Set([f.label, ...sc.siblings, ...f.candidates])],
      hint: [f.hint, t.why].filter(Boolean).join('; '),
      umbrella: sc.umbrella,
    };
  }

  /** The nightly pass of K2a's own state: the client calibration and the ctx keys. Human rows only (seed/machine: see each). */
  nightly(memory: readonly MemoryRow[], task: MemoryRow['task'], machineWeight: number): { client: number; ctx: ReturnType<CtxKeys['nightly']> } {
    const reg = this.facts.reg;
    const rows = memory.filter((r) => r.task === task && r.source === 'human' && this.meta.has(r.id)).map((r) => ({ ...r, label: clientOfLabel(reg, r.label, this.by) }));
    this.client.update(rows, (id) => {
      const m = this.meta.get(id);
      return m ? { instance: m.instance, label: m.client } : undefined;
    });
    return { client: rows.length, ctx: this.ctxKeys.nightly(memory, task, machineWeight) };
  }
}

const KEY = 'k2a:trusted';

/** One trusted floor per run, over the run's stage-0 floor (or a test's fake one, with its own tenant facts). */
export function trustedOf(ctx: DayCtx, inner: (ctx: DayCtx) => Stage0, facts?: (ctx: DayCtx) => TenantFacts): Trusted {
  const cached = ctx.state.get(KEY) as Trusted | undefined;
  if (cached) return cached;
  const t = new Trusted(inner(ctx), (facts ?? ((c) => tenantFacts(c.dir, c.dataset.subject ?? null, c.dataset.tz)))(ctx));
  ctx.state.set(KEY, t);
  return t;
}
