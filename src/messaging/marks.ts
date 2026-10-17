// Marks (OpenSpec `agent-messaging`, design D14): data from one domain does not reach another without a
// person. Pure: the domain of a tenant, how a conversation's marks grow when content arrives and when a
// message goes out, and the rule a message must pass. The store keeps the marks per conversation key
// (state.ts getMarks/setMarks); they end with the conversation's record or a fresh session.
//
// A domain is one tenant of one installation: the installation id for its home tenant (and for a
// single-workspace installation), `<installation>~<tag>` for another tenant, the tag being the first 8
// hex of the SHA-256 of the tenant id — tenant ids never leave their installation. A conversation's marks
// map each OTHER domain whose content reached it to the domains that already have that content.
import { createHash } from 'node:crypto';
import type { Marks } from './protocol.js';

/** The domain of a tenant of `installation` (`tenantId` undefined = its home tenant). */
export function domainOf(installation: string, tenantId: string | undefined): string {
  return tenantId ? `${installation}~${createHash('sha256').update(tenantId).digest('hex').slice(0, 8)}` : installation;
}

const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])].sort();
const copy = (m: Marks): Marks => Object.fromEntries(Object.entries(m).map(([d, h]) => [d, [...h]]));

/**
 * Content arrived (a task's question, an answer, an `input-required` question, a reply — states and fixed
 * reasons are not content) from domain `from`, carrying its conversation's marks. The source marks the
 * conversation (unless it is the own domain), and every mark it carried comes along with its holders plus
 * the source. A message from the own domain adds only what it carries: a local hop launders nothing.
 */
export function markArrival(marks: Marks, o: { own: string; from: string; carried: Marks }): Marks {
  const next = copy(marks);
  const add = (m: string, holders: readonly string[]): void => {
    if (m === o.own) return;
    next[m] = union(next[m] ?? [], holders);
  };
  if (o.from !== o.own) add(o.from, [o.from]);
  for (const [m, h] of Object.entries(o.carried)) add(m, [...h, o.from]);
  return next;
}

/** A message went out to domain `to` (the rule let it, or a person released it): `to` has every mark's data now. */
export function markSent(marks: Marks, to: string): Marks {
  return Object.fromEntries(Object.entries(marks).map(([m, h]) => [m, union(h, [to])]));
}

export type Verdict = { go: true } | { go: false; blocking: string[] };

/**
 * The rule (D14): a message from a conversation of domain `own` to an agent of domain `to` goes out only
 * when, for every mark, the mark is `to` or `to` already has its data. The own domain always passes (the
 * message carries the marks). A target whose domain is not known yet (`to` undefined) has nothing: in a
 * marked conversation its first message is held. An unmarked conversation always passes.
 */
export function mayGo(marks: Marks, o: { own: string; to: string | undefined }): Verdict {
  if (o.to !== undefined && o.to === o.own) return { go: true };
  const blocking = Object.entries(marks)
    .filter(([m, holders]) => o.to === undefined || (m !== o.to && !holders.includes(o.to)))
    .map(([m]) => m)
    .sort();
  return blocking.length ? { go: false, blocking } : { go: true };
}

/** Why a message is held, in words for the card and the tool's reply. */
export function heldWhy(blocking: readonly string[], to: string | undefined): string {
  const what = blocking.length === 1 ? `data from ${blocking[0]}` : `data from ${blocking.join(', ')}`;
  return `this conversation holds ${what}, and ${to ?? 'the target'} ${to ? 'does not have it' : 'is an agent whose domain is not known yet'}`;
}
