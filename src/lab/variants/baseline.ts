// Baseline: what production decides TODAY, with no model and no memory — the bar every variant must
// clear, and the no-regression check for the deterministic rungs.
//
//   t1-fragment  the production ladder alone, as the exporter froze it per fragment (no ledger, no pins):
//                a 'rule' state decides, anything else is a question
//   t1-item      production has no item mode; the closest it gets is the ladder (attribute()) run over the
//                item as if it were a one-message thread run — tenant rules, admin chatter, exclusive
//                markers, registry routing by channel and tracker key
//   t2-dedup     production folds no content at all; the generous reading is exact repeats only (same
//                source, same author, same text after case and whitespace)
//   t3-identity  the store's own resolution at freeze (unresolved = a question)
//   t4-kind      no kind exists; the only signal is is_bot → noise
//   t4-addressee message_people role='to' (DM members, mentions, To/Cc) — what `unanswered` reads today
//
// Confidences are fixed per rung: the baseline has no scores, and a fixed value keeps its operating point
// honest (it decides everything it can or nothing).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readAttributionInputs } from '../../sources/attribution/build.js';
import { keys as trackerPrefixes, type FragmentDraft } from '../../sources/attribution/fragment.js';
import { attribute, type LadderCtx, type MarkedPerson, type RuleRecord } from '../../sources/attribution/ladder.js';
import { parseRegistry, Registry, type RegistryData } from '../../sources/attribution/registry.js';
import { loadPeople } from '../../sources/people.js';
import { setKey } from '../metrics.js';
import type { DayCtx, FragmentUnit, ItemUnit, MentionUnit, Prediction, TaskId, Unit, Variant } from '../types.js';

const abstain = (id: string, rung = 'abstain'): Prediction => ({ id, label: null, conf: 0, rung });

// Same filter as build.ts parseRules (not exported): rules come as an array or {rules: [...]}; anything
// without an id, a `when` and a `then` is dropped silently, exactly as the build drops it.
function parseRules(raw: unknown): RuleRecord[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? (raw as { rules?: unknown }).rules : undefined;
  if (!Array.isArray(list)) return [];
  return list.filter((r): r is RuleRecord => !!r && typeof r === 'object' && typeof (r as RuleRecord).id === 'string' && !!(r as RuleRecord).when && !!(r as RuleRecord).then);
}

const readJson = (path: string, fallback: unknown): unknown => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback);

// The ladder's context from a dataset's tenant/ copy, built the way the store build builds it. A tenant
// without annotations/attribution.json (the layer is off — a team tenant today) still has a registry, rules and
// people: the ladder runs on those, with no subject and no admin rung (both come from that file).
export function tenantLadder(tenantDir: string, tz: string, subject?: string): LadderCtx {
  const annotationsDir = join(tenantDir, 'annotations');
  const peopleFile = join(annotationsDir, 'people.json');
  const people = existsSync(peopleFile) ? loadPeople(peopleFile) : [];
  const read = readAttributionInputs({ tenantRoot: tenantDir, annotationsDir, timezone: tz });
  let registry: RegistryData;
  let rules: RuleRecord[];
  let self = subject ?? '';
  let admin: Record<string, string> | undefined;
  if (read) {
    ({ registry, rules } = read.inputs);
    self = read.inputs.config.subject;
    admin = read.inputs.config.admin;
  } else {
    registry = parseRegistry(readJson(join(tenantDir, 'initiatives.json'), []));
    rules = parseRules(readJson(join(annotationsDir, 'rules.json'), []));
  }
  const marked = new Map<string, MarkedPerson>(
    people.map((p) => [p.person_id, { person_id: p.person_id, name: p.name, marker: p.marker ? { type: p.marker.type, initiatives: [...p.marker.initiatives] } : { type: 'broad', initiatives: [] } }]),
  );
  return { rules, people: marked, reg: new Registry(registry), self, ...(admin ? { admin } : {}) };
}

// An item as the ladder would see a one-message thread run. Keys are tracker PREFIXES, as the production
// fragmenter extracts them (rules' project_key and the registry's jira_keys/youtrack_prefixes are prefixes),
// read from the item's keys, subject and text the way a thread run reads its texts — plus a ticket's own id.
// The text rides along because the admin rung reads a thread's text.
export function itemDraft(u: ItemUnit): FragmentDraft {
  const own = u.type === 'task' || u.type === 'comment' ? u.id : '';
  return {
    id: u.id,
    kind: 'thread',
    start: u.ts,
    end: u.ts,
    refs: [u.id],
    title: u.subject ?? '',
    source: u.source,
    container: u.container,
    participants: [...new Set([u.authorPerson, ...u.toPersons].filter((x): x is string => !!x))],
    projectKeys: trackerPrefixes([...u.keys, u.subject ?? '', u.text, own].join('\n')),
    repo: null,
    weight: 1,
    text: [u.subject ?? '', u.text].filter(Boolean).join('\n'),
  };
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
const byTime = (a: ItemUnit, b: ItemUnit): number => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id);

export const baseline: Variant = {
  name: 'baseline',
  description: "today's production behaviour: the ladder, exact repeats, the store's resolution, is_bot, role='to' — no model",
  tasks: ['t1-fragment', 't1-item', 't2-dedup', 't3-identity', 't4-kind', 't4-addressee'],

  async decide(task: TaskId, units: Unit[], ctx: DayCtx): Promise<Prediction[]> {
    switch (task) {
      case 't1-fragment':
        return (units as FragmentUnit[]).map((u) => {
          const l = u.ladder;
          if (l?.state !== 'rule' || !l.initiative) return abstain(u.id, l ? `ladder:${l.state}` : 'abstain');
          // Gold is alias-resolved; production's timelog resolves aliases too, so the ladder's answer is read the same way.
          return { id: u.id, label: ladderOf(ctx).reg.resolveAlias(l.initiative), conf: 1, rung: `rule:${l.rule ?? 'ladder'}` };
        });
      case 't1-item': {
        const lad = ladderOf(ctx);
        return (units as ItemUnit[]).map((u) => {
          const r = attribute(itemDraft(u), lad);
          const a = r.decided?.attributions[0];
          if (!r.decided || !a) return abstain(u.id, r.candidates.length ? 'ladder:open' : 'abstain');
          return { id: u.id, label: lad.reg.resolveAlias(a.initiative), conf: 1, rung: `rule:${r.decided.rule_id}` };
        });
      }
      case 't2-dedup': {
        // Families span days: the first member seen (in day order, then time) names the family.
        const first = (ctx.state.get('families') as Map<string, string> | undefined) ?? new Map<string, string>();
        ctx.state.set('families', first);
        const out = new Map<string, Prediction>();
        for (const u of [...(units as ItemUnit[])].sort(byTime)) {
          const text = norm(u.text ?? '');
          // An empty body (a file, a reaction-only post) is no evidence of a repeat.
          if (!text) {
            out.set(u.id, { id: u.id, label: u.id, conf: 1, rung: 'singleton' });
            continue;
          }
          const key = `${u.source}\u0000${u.author ?? ''}\u0000${text}`;
          const fam = first.get(key);
          if (!fam) first.set(key, u.id);
          out.set(u.id, { id: u.id, label: fam ?? u.id, conf: 1, rung: fam ? 'exact-repeat' : 'singleton' });
        }
        return units.map((u) => out.get(u.id)!);
      }
      case 't3-identity':
        return (units as MentionUnit[]).map((u) => (u.production ? { id: u.id, label: u.production, conf: 1, rung: 'production' } : abstain(u.id, 'unresolved')));
      case 't4-kind':
        return (units as ItemUnit[]).map((u) => (u.isBot ? { id: u.id, label: 'noise', conf: 0.99, rung: 'rule:is_bot' } : abstain(u.id)));
      case 't4-addressee':
        return (units as ItemUnit[]).map((u) => (u.toPersons.length ? { id: u.id, label: setKey(u.toPersons), conf: 0.9, rung: "rule:role='to'" } : abstain(u.id)));
    }
  },
};

// One ladder context per run (ctx.state lives exactly that long): the tenant files are read once.
function ladderOf(ctx: DayCtx): LadderCtx {
  let lad = ctx.state.get('ladder') as LadderCtx | undefined;
  if (!lad) {
    lad = tenantLadder(join(ctx.dir, 'tenant'), ctx.dataset.tz, ctx.dataset.subject);
    ctx.state.set('ladder', lad);
  }
  return lad;
}
