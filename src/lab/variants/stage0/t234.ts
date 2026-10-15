// Stage 0 for T2 (dedup), T3 (mentions) and T4 (kind, addressee) — owned by the stage-0 T2-T4 agent; index.ts
// delegates here. STUB until that lands: the same fallbacks as before (production resolution, is_bot,
// message_people 'to', every item its own cluster).

import type { DayCtx, ItemUnit, MentionUnit } from '../../types.js';
import { caseKeyOf } from '../../cases.js';
import type { Floor, SenderClass } from './index.js';

export interface T234 {
  senderClass(u: ItemUnit): SenderClass;
  family(u: ItemUnit): string; // reuse key (sender + 6-token template + host/app token), NOT a duplicate cluster
  hostsApps(u: ItemUnit): { hosts: string[]; apps: string[] };
  mention(u: MentionUnit): Floor & { split?: string[] };
  kind(u: ItemUnit): Floor;
  addressee(u: ItemUnit): Floor;
  dedup(dayUnits: ItemUnit[]): Map<string, { cluster: string; conf: number }>;
}

export function t234(_ctx: DayCtx): T234 {
  return {
    senderClass: (u) => (u.isBot ? 'bot' : 'human'),
    family: (u) => u.id,
    hostsApps: () => ({ hosts: [], apps: [] }),
    mention: (u) => ({ label: u.production, conf: u.production ? 0.99 : 0, rung: u.production ? 'production' : 'abstain', candidates: [], hint: '', case: `form:${u.raw.toLowerCase()}` }),
    kind: (u) =>
      u.isBot
        ? { label: 'noise', conf: 0.95, rung: 'sender:bot', candidates: [], hint: '', case: caseKeyOf('t4-kind', u) }
        : { label: null, conf: 0, rung: 'abstain', candidates: [], hint: '', case: caseKeyOf('t4-kind', u) },
    addressee: (u) => {
      const to = [...new Set(u.toPersons)].sort();
      return to.length
        ? { label: to.join('|'), conf: 0.95, rung: 'explicit', candidates: [], hint: '', case: caseKeyOf('t4-addressee', u) }
        : { label: null, conf: 0, rung: 'abstain', candidates: [], hint: '', case: caseKeyOf('t4-addressee', u) };
    },
    dedup: (dayUnits) => new Map(dayUnits.map((u) => [u.id, { cluster: u.id, conf: 1 }])),
  };
}
