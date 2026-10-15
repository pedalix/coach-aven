// Item mode (attribution/items.ts), T2: duplicate edges and their clusters — design F9/F10, ported from the bench's
// stage-0 floor (src/lab/variants/stage0/t234-dedup.ts). The store dedups raw lines, identical tracker rows and recorder
// copies only; this links two items when one repeats the other for triage — deciding the first decides the second —
// by typed edges with a graded confidence:
//   exact      the same text (values kept; case, spacing, edge punctuation and scrub placeholders aside) from the same
//              sender: a person within 7 days in the same conversation (ticket, chat container; any mailbox for mail,
//              so a sent copy meets its inbox copy); an integration within a day (7 days merged a month of identical
//              daily reminders on the synthetic tenant: pairwise precision 49% → 64% at a day), a bot's thread reply
//              only in its thread, an alert only inside its episode                                             .99
//              (a text the reader clipped is only an equal prefix: .80; a person's text under 20 chars repeats only
//              inside one reply thread within 10 minutes — "ok" twice is two answers)
//   recorder   two recordings of one call (calls.ts call_id)                                                     .99
//   flap       a firing and its resolve, same sender + rule + target (fingerprint.ts alertOf), ≤ 30 min        .95
//              ≤ 4 h: .90 (the real stores' warning→resolved pairs run to 200 min); a resolve and the next firing
//              only ≤ 30 min (flapping) — later it is the next episode
//   refire     the same monitor alert firing again inside its episode, rule + target with values and links kept   .90
//   companion  a second bot in the same channel within 120 s sharing a link or tracker key with the first, or the
//              same bot posting the same issue twice into one thread                                            .90
//   crosspost  the same 200 normalised chars (≥ 40) in another container within a day (a person: the same one)  .90
//   forward    a forwarded mail whose subject and body carry an earlier one                                      .90
//   tracker    a tracker's notification announcing a ticket (created / new issue) and the ticket, by key       .85
//   bump       the same sender in the same thread (a person: or chat container within a day) re-sending an
//              earlier text with at most 3 new words and no changed value                                       .80
// Clusters are the connected components of these edges (union-find, items added in time order); a cluster is named
// by its earliest member, so a name once given never changes. A unit's confidence is the WEAKEST edge holding its
// component together; an item alone is .97, or .90 when its family (sender + template) recurred within 7 days and it
// still matched nothing. A person's item never shares a component with an integration's (bot, bulk, system) — the
// one exception is a ticket record joining its own announcement mail. Scrub placeholders never make two items equal.
// Pure: features in, labels out.

import type { AlertState } from '../fingerprint.js';

export const EDGE_CONF = {
  exact: 0.99,
  recorder: 0.99,
  flap: 0.95,
  'flap-late': 0.9,
  refire: 0.9,
  companion: 0.9,
  crosspost: 0.9,
  forward: 0.9,
  tracker: 0.85,
  'exact-clipped': 0.8,
  bump: 0.8,
} as const;
export type EdgeType = keyof typeof EDGE_CONF;

export const SINGLE_CONF = 0.97; // matched nothing, and nothing like it was seen
export const SINGLE_FAMILY_CONF = 0.9; // matched nothing, but its family recurred: a missed near-duplicate is possible

const MIN = 60_000;
const DAY = 1440 * MIN;
const WINDOWS = { exact: 7 * DAY, clipped: DAY, shortHuman: 10 * MIN, flap: 30 * MIN, flapLate: 240 * MIN, episode: 240 * MIN, companion: 2 * MIN, crosspost: DAY, forward: 30 * DAY, tracker: 30 * DAY, bump: 7 * DAY, bumpChat: DAY, family: 7 * DAY };

export interface DedupFeat {
  id: string;
  t: number; // ms since epoch; NaN never matches anything
  human: boolean; // a person's item (meetings and tickets are people's records)
  task: boolean; // a tracker ticket record (may join its own announcement mail)
  medium: 'mail' | 'chat' | 'tracker' | 'meeting' | 'other';
  sender: string; // a person id when the author resolves, else the sender key (address or label)
  container: string;
  thread: string; // '' for none
  reply: boolean; // a chat thread reply (its thread has an earlier root)
  exact: { key: string; chars: number } | null; // items-text exactKey; null = placeholders only
  clipped: boolean; // the reader cut the text: an exact match is only an equal prefix
  norm: string; // F9-normalised body
  words: string[]; // value-preserving body tokens — bumps compare these
  subject: string; // a mail's subject without prefixes, normalised ('' otherwise)
  forward: boolean; // a mail forwarding another
  alert: AlertState | null;
  alertId: string; // the alert's identity with values kept — re-fires meet on it
  targets: string[]; // hosts and apps the item names, sorted — a flap's target
  links: string[]; // full URLs and tracker keys (companions share one)
  trackerKeys: string[]; // tracker keys named in a notification mail
  trackerMail: boolean; // a tracker's notification mail
  trackerCreated: boolean; // … announcing the ticket itself, not a comment or a change
  ownKey: string; // a ticket's own key ('' otherwise)
  callId: string; // a recording's call id ('' otherwise)
  family: string; // the reuse key (sender + template + host/app), for the singleton confidence
}

interface Root {
  first: string; // earliest member: the cluster's name
  firstT: number;
  weakest: number; // 1 = no edge yet
  humans: number;
  machines: number;
  taskOnly: boolean; // its only human member is a ticket record
  size: number;
}

const VALUE = /\d/; // a token carrying a number, id, hash or date
const LINK = /^(?:https?:\/\/|www\.)|\.[a-z]{2,}\//i;

/**
 * B re-sends A: it carries A (all but a tenth of its tokens) with at most 3 new tokens, or it is a shortened copy of A
 * (no new token). Either way 4+ tokens are shared: "Perfect, thanks a lot" twice is two thank-yous. A substitution
 * ("staging" → "production") is another event, and so is any changed VALUE: no token with a digit may be added or
 * dropped, except a link.
 */
export function isBump(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  let shared = 0;
  const fresh: string[] = [];
  for (const x of b) (a.has(x) ? shared++ : fresh.push(x));
  const dropped = [...a].filter((x) => !b.has(x));
  if (shared < 4 || [...fresh, ...dropped].some((x) => VALUE.test(x) && !LINK.test(x))) return false;
  const carries = shared >= Math.ceil(0.9 * a.size) && fresh.length <= 3;
  const shortened = fresh.length === 0;
  return (carries || shortened) && !(fresh.length === 0 && dropped.length === 0);
}

export class Dedup {
  private parent = new Map<string, string>();
  private roots = new Map<string, Root>();
  private exactIx = new Map<string, { id: string; t: number }>();
  private alertIx = new Map<string, { id: string; t: number; state: AlertState['state'] }>();
  private refireIx = new Map<string, { id: string; t: number }>();
  private recorderIx = new Map<string, string>();
  private crossIx = new Map<string, { id: string; t: number; container: string }>();
  private companionIx = new Map<string, { id: string; t: number; sender: string; thread: string; links: Set<string> }[]>();
  private subjectIx = new Map<string, { id: string; t: number; head: string; human: boolean }[]>();
  private mailByKey = new Map<string, { id: string; t: number }[]>();
  private taskByKey = new Map<string, { id: string; t: number }>();
  private ticketLinked = new Set<string>(); // tickets that already have their one announcement mail
  private bumpIx = new Map<string, { id: string; t: number; toks: Set<string> }[]>();
  private familyIx = new Map<string, number>(); // family → last time seen
  private familyHit = new Set<string>(); // ids whose family recurred within the window
  readonly joined = new Map<string, EdgeType>(); // item → the edge that first joined it to an earlier item

  /** minConf drops weaker edges before they join anything; exactDays is an integration's exact-repeat window. */
  constructor(private readonly opts: { minConf?: number; exactDays?: number } = {}) {}

  private find(id: string): string {
    let r = id;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    let x = id;
    while (this.parent.get(x) !== r) {
      const next = this.parent.get(x)!;
      this.parent.set(x, r);
      x = next;
    }
    return r;
  }

  /** The cluster of an item (its earliest member) and the weakest edge of its component (the singleton rule if none). */
  label(id: string): { cluster: string; conf: number } {
    if (!this.parent.has(id)) return { cluster: id, conf: SINGLE_CONF };
    const root = this.roots.get(this.find(id))!;
    if (root.size === 1) return { cluster: id, conf: this.familyHit.has(id) ? SINGLE_FAMILY_CONF : SINGLE_CONF };
    return { cluster: root.first, conf: root.weakest };
  }

  private link(a: string, b: string, type: EdgeType): boolean {
    const conf = EDGE_CONF[type];
    if (conf < (this.opts.minConf ?? 0)) return false;
    const ra = this.find(a);
    const rb = this.find(b);
    const A = this.roots.get(ra)!;
    const B = this.roots.get(rb)!;
    // Already one component: a parallel edge adds no reach and takes no confidence away.
    if (ra === rb) return true;
    // A person's item never joins an integration's component; a ticket record may join its announcement mail.
    if ((A.humans && B.machines) || (A.machines && B.humans)) {
      const ok = type === 'tracker' && (A.humans === 0 || (A.humans === 1 && A.taskOnly)) && (B.humans === 0 || (B.humans === 1 && B.taskOnly));
      if (!ok) return false;
    }
    const [keep, drop] = A.firstT < B.firstT || (A.firstT === B.firstT && A.first < B.first) ? [ra, rb] : [rb, ra];
    const K = this.roots.get(keep)!;
    const D = this.roots.get(drop)!;
    this.parent.set(drop, keep);
    K.first = K.firstT <= D.firstT ? K.first : D.first;
    K.weakest = Math.min(K.weakest, D.weakest, conf);
    K.taskOnly = (K.humans === 0 || K.taskOnly) && (D.humans === 0 || D.taskOnly) && K.humans + D.humans <= 1;
    K.humans += D.humans;
    K.machines += D.machines;
    K.size += D.size;
    this.roots.delete(drop);
    if (!this.joined.has(b)) this.joined.set(b, type);
    return true;
  }

  /** Add one item (in time order) and link it to what it repeats. */
  add(f: DedupFeat): void {
    if (this.parent.has(f.id)) return;
    this.parent.set(f.id, f.id);
    this.roots.set(f.id, { first: f.id, firstT: f.t, weakest: 1, humans: f.human ? 1 : 0, machines: f.human ? 0 : 1, taskOnly: f.human && f.task, size: 1 });
    if (!Number.isFinite(f.t)) return;
    const within = (t: number, w: number) => f.t - t >= 0 && f.t - t <= w;
    const who = f.human ? 'h' : 'm';

    // family recurrence (singleton confidence only)
    if (f.family) {
      const last = this.familyIx.get(f.family);
      if (last !== undefined && within(last, WINDOWS.family)) this.familyHit.add(f.id);
      this.familyIx.set(f.family, f.t);
    }

    // recorder copies
    if (f.callId) {
      const other = this.recorderIx.get(f.callId);
      if (other) this.link(other, f.id, 'recorder');
      else this.recorderIx.set(f.callId, f.id);
    }

    // An alert is an EVENT with an episode: it opens with a firing, may fire again, and closes with its resolve. The same
    // text after the resolve is the next episode (the site went down again), not a copy — unless it re-opens within
    // the flap window. Grouping episodes across days is what the family (a reuse key) is for.
    const alertish = !f.human && !!f.alert;
    let alertKey = '';
    let lastAlert: { id: string; t: number; state: AlertState['state'] } | undefined;
    if (alertish && f.alert) {
      // The same sender, rule (its first two words) and targets when it names any, else the same identity: a resolve
      // is often worded unlike its firing ("CPU load above 90% on db1" → "CPU load back to normal on db1").
      const rule = f.alert.key.split(' ').slice(0, 2).join(' ');
      alertKey = f.targets.length ? JSON.stringify([f.sender, rule, f.targets]) : JSON.stringify([f.sender, f.alert.key]);
      lastAlert = this.alertIx.get(alertKey);
    }
    const samePhase = !!lastAlert && !!f.alert && lastAlert.state === f.alert.state && within(lastAlert.t, WINDOWS.episode);

    // exact
    if (f.exact && f.medium !== 'meeting') {
      const short = f.human && f.exact.chars < 20;
      const scope = f.human ? (f.medium === 'tracker' ? f.thread : f.medium === 'chat' ? (short ? f.thread : f.container) : '') : f.reply ? f.thread : '';
      if (!short || f.reply) {
        const key = JSON.stringify([who, f.medium, f.sender, scope, f.exact.key]);
        const prev = this.exactIx.get(key);
        const w = short ? WINDOWS.shortHuman : alertish ? WINDOWS.episode : f.clipped ? WINDOWS.clipped : f.human ? WINDOWS.exact : (this.opts.exactDays ?? 1) * DAY;
        if (prev && within(prev.t, w) && (!alertish || samePhase)) this.link(prev.id, f.id, f.clipped ? 'exact-clipped' : 'exact');
        this.exactIx.set(key, { id: f.id, t: f.t });
      }
    }

    if (alertish && f.alert) {
      // flap: a firing → its resolve (≤ 30 min .95, ≤ 4 h .90); a resolve → a new firing only within 30 min (flapping)
      if (lastAlert && lastAlert.state !== f.alert.state) {
        if (within(lastAlert.t, WINDOWS.flap)) this.link(lastAlert.id, f.id, 'flap');
        else if (lastAlert.state === 'firing' && within(lastAlert.t, WINDOWS.flapLate)) this.link(lastAlert.id, f.id, 'flap-late');
      }
      // re-fire: the same alert (rule + target, values kept), same state, again inside the episode
      const rk = f.alertId ? JSON.stringify([f.sender, f.alert.state, f.alertId, f.links.filter((l) => /^https?:/i.test(l)).sort()]) : '';
      if (rk && samePhase) {
        const r = this.refireIx.get(rk);
        if (r && within(r.t, WINDOWS.episode)) this.link(r.id, f.id, 'refire');
      }
      if (rk) this.refireIx.set(rk, { id: f.id, t: f.t });
      this.alertIx.set(alertKey, { id: f.id, t: f.t, state: f.alert.state });
    }

    // companion: another bot in the same channel within 120 s, sharing a link or key
    if (!f.human && f.medium === 'chat' && f.container) {
      const recent = (this.companionIx.get(f.container) ?? []).filter((p) => within(p.t, WINDOWS.companion));
      const links = new Set(f.links);
      // A second bot answering the first, or the same bot posting the same issue twice into one thread.
      const leader = [...recent].reverse().find((p) => (p.sender !== f.sender || (!!f.thread && p.thread === f.thread)) && [...p.links].some((l) => links.has(l)));
      if (leader) this.link(leader.id, f.id, 'companion');
      if (links.size) recent.push({ id: f.id, t: f.t, sender: f.sender, thread: f.thread, links });
      this.companionIx.set(f.container, recent);
    }

    // cross-post: the same 200 normalised chars in another container
    if (f.norm.length >= 40) {
      const key = JSON.stringify([who, f.human ? f.sender : '', f.norm.slice(0, 200)]);
      const prev = this.crossIx.get(key);
      if (prev && prev.container !== f.container && within(prev.t, WINDOWS.crosspost)) this.link(prev.id, f.id, 'crosspost');
      if (!prev || prev.container !== f.container || !within(prev.t, WINDOWS.crosspost)) this.crossIx.set(key, { id: f.id, t: f.t, container: f.container });
    }

    // forward: a mail whose subject (prefixes off) and body carry an earlier mail
    if (f.medium === 'mail' && f.subject) {
      const list = (this.subjectIx.get(f.subject) ?? []).filter((p) => within(p.t, WINDOWS.forward));
      if (f.forward) {
        const src = [...list].reverse().find((p) => p.human === f.human && p.head.length >= 40 && f.norm.includes(p.head));
        if (src) this.link(src.id, f.id, 'forward');
      }
      list.push({ id: f.id, t: f.t, head: f.norm.slice(0, 120), human: f.human });
      this.subjectIx.set(f.subject, list.slice(-20));
    }

    // tracker: the notification that ANNOUNCES a ticket ↔ the ticket. Only that one, once: a comment or change notice is
    // another event of the ticket, and two of them must never meet through it.
    if (f.trackerMail && f.trackerCreated && f.trackerKeys.length === 1) {
      const k = f.trackerKeys[0]!;
      if (!this.ticketLinked.has(k)) {
        const task = this.taskByKey.get(k);
        if (task && Math.abs(f.t - task.t) <= WINDOWS.tracker) {
          if (this.link(task.id, f.id, 'tracker')) this.ticketLinked.add(k);
        } else if (!this.mailByKey.has(k)) this.mailByKey.set(k, [{ id: f.id, t: f.t }]);
      }
    }
    if (f.task && f.ownKey) {
      this.taskByKey.set(f.ownKey, { id: f.id, t: f.t });
      const m = this.mailByKey.get(f.ownKey)?.[0];
      if (m && !this.ticketLinked.has(f.ownKey) && within(m.t, WINDOWS.tracker) && this.link(m.id, f.id, 'tracker')) this.ticketLinked.add(f.ownKey);
    }

    // bump: the same sender re-sending an earlier text in the same thread with ≤ 3 new tokens. Tokens keep their values:
    // a changed number, id or hash is a new event, never a bump — only words and links may be added or dropped.
    const toks = new Set(f.words);
    if (toks.size >= 2) {
      const scopes: { key: string; w: number }[] = [];
      if (f.thread) scopes.push({ key: JSON.stringify(['t', who, f.sender, f.thread]), w: WINDOWS.bump });
      if (f.human && f.medium === 'chat' && f.container) scopes.push({ key: JSON.stringify(['c', who, f.sender, f.container]), w: WINDOWS.bumpChat });
      let done = false;
      for (const s of scopes) {
        const list = (this.bumpIx.get(s.key) ?? []).filter((p) => within(p.t, s.w));
        if (!done) {
          for (let i = list.length - 1; i >= 0; i--) {
            const p = list[i]!;
            if (isBump(p.toks, toks)) {
              done = this.link(p.id, f.id, 'bump');
              break;
            }
          }
        }
        list.push({ id: f.id, t: f.t, toks });
        this.bumpIx.set(s.key, list.slice(-8));
      }
    }
  }
}
