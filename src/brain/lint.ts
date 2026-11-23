// Company brain: the lint — what code can find wrong in a project's records (design D6). Pure, from the index
// alone; the one input from outside the mirror is the list of tickets a tracker reports resolved, gathered by the
// caller once a night and passed in as data. What code cannot find (two records that contradict each other, a
// surname) is the dream's; the lint narrows where it looks.

import type { BrainIndex, IndexedRecord } from './index.js';

export const OPEN_STALE_DAYS = 30;
export const DREAM_FINDINGS = 15;

export type FindingCode =
  | 'no-kind'
  | 'no-status'
  | 'open-stale'
  | 'same-ticket'
  | 'not-linked' // a file MEMORY.md does not link
  | 'no-file' // a MEMORY.md link without a file
  | 'personal-data'
  | 'ticket-resolved';

export interface Finding {
  code: FindingCode;
  records: string[]; // file names; for `no-file`, the missing one
  text: string; // one line for a person and for the dream
  since: string; // ISO — the oldest record involved was first seen then; orders the dream's share
}

const DAY = 24 * 60 * 60 * 1000;
const ticketKey = (t: string): string => t.trim().toUpperCase();

export function lint(index: BrainIndex, o: { now: Date; resolvedTickets?: readonly string[] }): Finding[] {
  const out: Finding[] = [];
  const one = (code: FindingCode, r: IndexedRecord, text: string): void => {
    out.push({ code, records: [r.name], text: `${r.name}: ${text}`, since: r.firstSeen });
  };
  const resolved = new Set((o.resolvedTickets ?? []).map(ticketKey));
  const byTicket = new Map<string, IndexedRecord[]>();
  for (const r of index.records) {
    if (!r.kind) one('no-kind', r, 'no `kind` (investigation, domain, method or decision)');
    if (r.kind === 'investigation' && !r.status) one('no-status', r, 'an investigation without a `status`');
    if (r.kind === 'investigation' && r.status === 'open') {
      const days = Math.floor((o.now.getTime() - Date.parse(r.firstSeen)) / DAY);
      if (days > OPEN_STALE_DAYS) one('open-stale', r, `\`open\` for ${days} days`);
      if (r.ticket && resolved.has(ticketKey(r.ticket)))
        one('ticket-resolved', r, `\`open\`, but the tracker has resolved ${r.ticket}`);
    }
    if (r.personal) {
      const what = [r.personal.email ? `e-mail address ×${r.personal.email}` : '', r.personal.phone ? `phone number ×${r.personal.phone}` : ''];
      one('personal-data', r, `personal data pattern: ${what.filter(Boolean).join(', ')}`);
    }
    if (r.ticket) byTicket.set(ticketKey(r.ticket), [...(byTicket.get(ticketKey(r.ticket)) ?? []), r]);
  }
  for (const [ticket, rs] of byTicket) {
    if (rs.length < 2) continue;
    const names = rs.map((r) => r.name);
    out.push({
      code: 'same-ticket',
      records: names,
      text: `${names.join(', ')}: ${rs.length} records for ${ticket}`,
      since: rs.map((r) => r.firstSeen).sort()[0],
    });
  }
  const have = new Set(index.records.map((r) => r.name));
  const linked = new Set(index.linked);
  for (const r of index.records) if (!linked.has(r.name)) one('not-linked', r, 'not linked from MEMORY.md');
  for (const name of index.linked)
    if (!have.has(name)) out.push({ code: 'no-file', records: [name], text: `${name}: linked from MEMORY.md, no such file`, since: index.builtAt });
  return out;
}

// The dream's share: at most DREAM_FINDINGS, oldest first (ties by text, so the order is stable), so an existing
// project's backlog drains over nights instead of in one expensive run.
export function dreamShare(findings: readonly Finding[], cap = DREAM_FINDINGS): Finding[] {
  return [...findings].sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : a.text < b.text ? -1 : a.text > b.text ? 1 : 0)).slice(0, cap);
}
