// Stage 0 — the shared deterministic floor both iteration-1 concepts stand on (design notes/10-design.md §2).
// This file is the API K (keys.ts) and J (judge.ts) code against. Until the real floor lands it is a STUB that
// falls back to what production already computed at export time (unit.ladder, production, isBot, toPersons),
// so every consumer runs end to end from minute one; the stage-0 agent replaces the internals, not the shape.
//
// Every rung carries a graded confidence (F12): a single title hit is not a repo route, and an operating point
// must be able to drop the weak one.

import type { DayCtx, FragmentUnit, ItemUnit, MemoryRow, MentionUnit, TaskId } from '../../types.js';
import { NONE, UNREGISTERED } from '../../types.js';
import { caseKeyOf } from '../../cases.js';

export type SenderClass = 'human' | 'bot' | 'bulk' | 'system';

export interface Floor {
  label: string | null; // null = the floor does not decide
  conf: number; // graded rung confidence (§2.2); 0 when label is null
  rung: string; // 'rule:<id>' | 'repo' | 'channel:<c>' | 'key:<k>' | 'title:<p>' | 'admin' | 'excl:<person>' | …
  candidates: string[]; // narrowed choice set (never a closed list — the closed list is labelSpace())
  hint: string; // human-readable weak prior ('' when none)
  case: string; // the question unit (§2.3)
  umbrella?: string; // umbrella prior when the floor only knows the billing frame
}

export interface RegistryCard {
  id: string; // alias-resolved initiative id
  umbrella: string;
  name: string;
  done: boolean;
  code?: string; // billing code
  cues: string[]; // title patterns, channels, key prefixes, repo basenames, hosts/apps, company
  people: string[]; // display names of people whose marker holds this initiative
}

export interface Stage0 {
  fragment(u: FragmentUnit, pool: FragmentUnit[]): Floor & { participants: string[]; cowork: string[] };
  item(u: ItemUnit, pool: ItemUnit[]): Floor & { senderClass: SenderClass; family: string; hosts: string[]; apps: string[] };
  mention(u: MentionUnit): Floor & { split?: string[] };
  kind(u: ItemUnit): Floor;
  addressee(u: ItemUnit): Floor;
  dedup(dayUnits: ItemUnit[]): Map<string, { cluster: string; conf: number }>; // union-find state survives across days
  labelSpace(task: TaskId): string[]; // the closed list: registry ∪ admin ∪ personal ∪ none ∪ unregistered (alias-resolved)
  cards(): RegistryCard[];
  calibrate(rows: MemoryRow[], decided: Map<string, string>): void; // rung-instance calibration (§2.5)
}

const KEY = 'stage0';

// One floor per run (ctx.state survives across the days of one variant × task run).
export function stage0(ctx: DayCtx): Stage0 {
  const cached = ctx.state.get(KEY) as Stage0 | undefined;
  if (cached) return cached;
  const s = stub(ctx);
  ctx.state.set(KEY, s);
  return s;
}

function stub(ctx: DayCtx): Stage0 {
  const space = ctx.dataset.labelSpace;
  const umbrellaOf = (id: string) => space.umbrellas[id] ?? id;
  return {
    fragment(u) {
      const l = u.ladder;
      const decided = l?.state === 'rule' && !!l.initiative;
      return {
        label: decided ? l!.initiative! : null,
        conf: decided ? 0.97 : 0,
        rung: decided ? `ladder:${l!.rule ?? 'rule'}` : 'abstain',
        candidates: l?.candidates ?? [],
        hint: l?.hint ?? '',
        case: caseKeyOf('t1-fragment', u),
        umbrella: decided ? umbrellaOf(l!.initiative!) : undefined,
        participants: u.participants,
        cowork: [],
      };
    },
    item(u) {
      return { label: null, conf: 0, rung: 'abstain', candidates: [], hint: '', case: caseKeyOf('t1-item', u), senderClass: u.isBot ? 'bot' : 'human', family: u.id, hosts: [], apps: [] };
    },
    mention(u) {
      return { label: u.production, conf: u.production ? 0.99 : 0, rung: u.production ? 'production' : 'abstain', candidates: [], hint: '', case: `form:${u.raw.toLowerCase()}` };
    },
    kind(u) {
      return u.isBot
        ? { label: 'noise', conf: 0.95, rung: 'sender:bot', candidates: [], hint: '', case: caseKeyOf('t4-kind', u) }
        : { label: null, conf: 0, rung: 'abstain', candidates: [], hint: '', case: caseKeyOf('t4-kind', u) };
    },
    addressee(u) {
      const to = [...new Set(u.toPersons)].sort();
      return to.length
        ? { label: to.join('|'), conf: 0.95, rung: 'explicit', candidates: [], hint: '', case: caseKeyOf('t4-addressee', u) }
        : { label: null, conf: 0, rung: 'abstain', candidates: [], hint: '', case: caseKeyOf('t4-addressee', u) };
    },
    dedup(dayUnits) {
      return new Map(dayUnits.map((u) => [u.id, { cluster: u.id, conf: 1 }]));
    },
    labelSpace(task) {
      if (task === 't1-fragment' || task === 't1-item') return [...space.initiatives, NONE, UNREGISTERED];
      return [];
    },
    cards() {
      return space.initiatives.map((id) => ({ id, umbrella: umbrellaOf(id), name: id, done: false, cues: [], people: [] }));
    },
    calibrate() {},
  };
}
