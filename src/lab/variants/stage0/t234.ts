// Stage 0 for T2 (dedup), T3 (mentions) and T4 (kind, addressee) — design notes/10-design.md §2.1 F4/F8–F11, §2.2.
// index.ts delegates here; the pure parts live beside it (t234-text, t234-people, t234-dedup, t234-t4) and this file
// wires them to one dataset: the tenant's people.json (the roster as given) and read-only SQL on the frozen
// store.sqlite for what a single unit does not carry (who mails how often and who answers, who speaks in a
// container, the record behind a mention). Everything is loaded once per run and cached in ctx.state — the union-find
// of the duplicate clusters lives there too, so a family that started yesterday keeps its name today.
//
//   senderClass(u)  F8: sources/sender.ts (is_bot ∪ isSystem lists, Slack B… ids, the mail regexes, tracker relays)
//                   plus the one-way bulk rule — an unresolved mail sender with ≥ 3 mails so far, none of them ever
//                   answered by the subject, in a thread the subject never wrote in → bulk. Meetings are people's.
//   family(u)       the reuse key: source + sender + 6-token template (sources/fingerprint.ts) + first host/app token
//   hostsApps(u)    hostnames and app tokens (t234-text)
//   dedup(day)      F10 clusters (t234-dedup) — call once per day, in day order
//   mention(u)      T3 rungs (t234-people), then `system` from the sender class of the string itself → 'system' .95;
//                   a campaign from a personal-looking mailbox only .85 (a CEO's newsletter still comes from somebody)
//   kind(u)         F11 kind floor (t234-t4) + the cue classes (`cues`) for K's cue keys and J's cite check
//   addressee(u)    F11 addressee floor (t234-t4): mentions, DM owner, first To, assignee, vocative, reply → author
// Causality: the one-way rule and a container's people count only what was there by the end of the unit's local day
// (what a nightly build knows); the clusters only ever see earlier days.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openReadOnly } from '../../../sources/store.js';
import { loadPeople, type Person } from '../../../sources/people.js';
import { AUTOMATED_LOCAL, BULK_LOCAL, ROLE_LOCAL, senderClass as baseSenderClass, isMailItem, parseSender, type SenderClass as BaseClass } from '../../../sources/sender.js';
import { alertOf, headOf, senderKey, templateOf } from '../../../sources/fingerprint.js';
import type { DayCtx, ItemUnit, MentionUnit } from '../../types.js';
import { caseKeyOf } from '../../cases.js';
import { opt } from '../index.js';
import type { Floor, SenderClass } from './index.js';
import { alertIdentity, roleLike, cuesOf, exactKey, exactTokens, FORWARD_PREFIX, hostsApps as textHostsApps, isSmallTalk, normBody, stripSubject, type Cue } from './t234-text.js';
import { formKey, resolveMention, roster, translit, type Resolved, type Roster } from './t234-people.js';
import { Dedup, type DedupFeat, type EdgeType } from './t234-dedup.js';
import { addresseeOf, containerKind, kindOf, openingName } from './t234-t4.js';

export interface T234 {
  senderClass(u: ItemUnit): SenderClass;
  family(u: ItemUnit): string; // reuse key (sender + 6-token template + host/app token), NOT a duplicate cluster
  hostsApps(u: ItemUnit): { hosts: string[]; apps: string[] };
  mention(u: MentionUnit): Floor & { split?: string[] };
  kind(u: ItemUnit): Floor & { cues: Cue[] }; // cues: the Q/R/C/I classes the text fires (never a decision alone)
  addressee(u: ItemUnit): Floor;
  dedup(dayUnits: ItemUnit[]): Map<string, { cluster: string; conf: number }>;
  // Optional extras for the bench and the learners:
  dedupVia?(id: string): EdgeType | 'single'; // the edge that joined a unit to its cluster
  resolve?(raw: string): Resolved; // the T3 resolver on any raw string (rungs above `system`)
}

const KEY = 't234';
const TRACKER_KEY = /^[A-Z][A-Z0-9]{1,9}-\d+$/;
const TRACKER_MAIL_DOMAIN = /(?:^|\.)(?:youtrack\.cloud|myjetbrains\.com|atlassian\.net|asana\.com|linear\.app)$/i;
const TRACKER_SUBJECT = /^\s*\[(?:youtrack|jira|asana|linear)\b/i;
// A notice that announces the ticket itself — not a comment, an assignment or a state change.
const TRACKER_CREATED = /\b(?:created|new (?:issue|ticket|task|work item)|reported|opened|erstellt|neu(?:es|er)? (?:ticket|vorgang)|создал[аи]?|создана?|creat[oa]|nuovo ticket)\b/i;

/** One instance per run: every caller (stage0's floor, K, J) shares the roster, the store stats and the clusters. */
export function t234(ctx: DayCtx): T234 {
  const cached = ctx.state.get(KEY) as T234 | undefined;
  if (cached) return cached;
  const made = build(ctx);
  ctx.state.set(KEY, made);
  return made;
}

// --- time ----------------------------------------------------------------------------------------------------

function offsetMs(tz: string, at: number): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(at));
  } catch {
    return 0; // an unknown zone reads as UTC
  }
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour! % 24, +p.minute!, +p.second!) - at;
}

/** The UTC instant a local day ends (the next local midnight). */
export function dayEndMs(day: string, tz: string): number {
  const next = Date.parse(`${day}T00:00:00Z`) + 86_400_000;
  if (!Number.isFinite(next)) return NaN;
  let t = next - offsetMs(tz, next);
  t = next - offsetMs(tz, t);
  return t;
}

// --- store-backed stats ----------------------------------------------------------------------------------------

export interface MailRow {
  thread: string;
  t: number;
  sender: string; // senderKey of the author
  subjectWrote: boolean; // the subject authored this message
}

/** Who mails how often, and which threads the subject ever wrote in — the one-way bulk rule's evidence. */
export class MailStats {
  private bySender = new Map<string, { t: number; thread: string }[]>();
  private subjectFirst = new Map<string, number>(); // thread → first time the subject wrote in it

  constructor(rows: readonly MailRow[]) {
    for (const r of rows) {
      if (!Number.isFinite(r.t)) continue;
      if (r.subjectWrote) {
        const cur = this.subjectFirst.get(r.thread);
        if (cur === undefined || r.t < cur) this.subjectFirst.set(r.thread, r.t);
        continue;
      }
      if (!r.sender) continue;
      const list = this.bySender.get(r.sender) ?? [];
      list.push({ t: r.t, thread: r.thread });
      this.bySender.set(r.sender, list);
    }
    for (const list of this.bySender.values()) list.sort((a, b) => a.t - b.t);
  }

  subjectWroteIn(thread: string, at: number): boolean {
    const t = this.subjectFirst.get(thread);
    return t !== undefined && t <= at;
  }

  /** ≥ 3 mails from the sender up to `at`, and the subject wrote in none of their threads by then. */
  oneWay(sender: string, at: number, min = 3): boolean {
    const list = this.bySender.get(sender);
    if (!list) return false;
    let n = 0;
    for (const m of list) {
      if (m.t > at) break;
      n++;
      if (m.thread && this.subjectWroteIn(m.thread, at)) return false;
    }
    return n >= min;
  }
}

interface Store {
  mail: MailStats;
  members: Map<string, Map<string, number>>; // container → person → first time they wrote there (or own a ticket of it)
  record(ref: string): { source: string; container: string; thread: string; author: string; subject: string; text: string; isBot: boolean; ts: string } | null;
}

function openStore(dir: string, subject: string | undefined, log: (m: string) => void): Store | null {
  const path = join(dir, 'store.sqlite');
  if (!existsSync(path)) return null;
  let db: DatabaseSync;
  try {
    db = openReadOnly(path);
  } catch (e) {
    log(`t234: cannot open ${path}: ${(e as Error).message}`);
    return null;
  }
  const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const rows: MailRow[] = [];
  for (const r of db.prepare('SELECT source, container, thread_id, ts, author_raw, author_person FROM messages WHERE deleted = 0').all() as Record<string, unknown>[]) {
    const source = str(r.source);
    const container = str(r.container);
    if (!isMailItem(source, container)) continue;
    rows.push({ thread: str(r.thread_id), t: Date.parse(str(r.ts)), sender: senderKey(str(r.author_raw)), subjectWrote: !!subject && str(r.author_person) === subject });
  }
  const members = new Map<string, Map<string, number>>();
  const add = (c: string, p: string, ts: string) => {
    const t = Date.parse(ts);
    if (!c || !p || !Number.isFinite(t)) return;
    const m = members.get(c) ?? new Map<string, number>();
    m.set(p, Math.min(m.get(p) ?? Infinity, t));
    members.set(c, m);
  };
  for (const r of db.prepare("SELECT container, author_person, MIN(ts) AS ts FROM messages WHERE deleted = 0 AND is_bot = 0 AND author_person IS NOT NULL AND author_person != '' GROUP BY container, author_person").all() as Record<string, unknown>[]) add(str(r.container), str(r.author_person), str(r.ts));
  try {
    for (const r of db.prepare('SELECT project, reporter_person, assignee_person, created FROM tasks WHERE deleted = 0').all() as Record<string, unknown>[]) {
      add(str(r.project), str(r.reporter_person), str(r.created));
      add(str(r.project), str(r.assignee_person), str(r.created));
    }
  } catch {
    /* a store without tasks */
  }
  const byRef = db.prepare('SELECT source, container, thread_id, author_raw, subject, text, is_bot, ts FROM messages WHERE ref = ?');
  return {
    mail: new MailStats(rows),
    members,
    record(ref) {
      const r = byRef.get(ref) as Record<string, unknown> | undefined;
      return r ? { source: str(r.source), container: str(r.container), thread: str(r.thread_id), author: str(r.author_raw), subject: str(r.subject), text: str(r.text), isBot: Number(r.is_bot) === 1, ts: str(r.ts) } : null;
    },
  };
}

// --- the floor ---------------------------------------------------------------------------------------------------

const isSlackReply = (u: ItemUnit): boolean => {
  if (u.source !== 'slack' || !u.thread) return false;
  const own = u.id.split(':').at(-1) ?? '';
  return !u.thread.endsWith(`/${own}`) && !u.thread.endsWith(`:${own}`);
};

function build(ctx: DayCtx): T234 {
  const tz = ctx.dataset.tz || 'UTC';
  const subject = ctx.dataset.subject || null;
  const peopleFile = join(ctx.dir, 'tenant', 'annotations', 'people.json');
  let people: Person[] = [];
  try {
    if (existsSync(peopleFile)) people = loadPeople(peopleFile);
  } catch (e) {
    ctx.log(`t234: people.json unreadable (${(e as Error).message}); resolving with an empty roster`);
  }
  const R: Roster = roster(people);
  const store = openStore(ctx.dir, subject ?? undefined, ctx.log);
  // Ablations: --opt dedupMin=.9 drops the duplicate edges below that confidence before they join anything;
  // --opt dedupExactDays=7 restores the design's window for an integration's exact repeats (default: a day).
  const engine = new Dedup({ minConf: opt('dedupMin', 0), exactDays: opt('dedupExactDays', 1) });

  const dayEnds = new Map<string, number>();
  const dayEnd = (day: string): number => {
    let t = dayEnds.get(day);
    if (t === undefined) dayEnds.set(day, (t = dayEndMs(day, tz)));
    return t;
  };

  // The context-free resolution of a raw string (no co-presence), cached: authors, participants, attendees, speakers.
  const resolved = new Map<string, Resolved>();
  const resolve = (raw: string): Resolved => {
    let r = resolved.get(raw);
    if (!r) resolved.set(raw, (r = resolveMention(R, raw)));
    return r;
  };
  /** A raw string as a person id, only when a rung ≥ .95 says so ('' otherwise). */
  const personOf = (raw: string | null | undefined): string => {
    if (!raw) return '';
    const r = resolve(raw);
    return r.label && r.conf >= 0.95 && !r.label.includes('+') ? r.label : '';
  };
  const authorOf = (u: ItemUnit): string => u.authorPerson || personOf(u.author);

  const classes = new Map<string, SenderClass>();
  const senderClass = (u: ItemUnit): SenderClass => {
    const hit = classes.get(u.id);
    if (hit) return hit;
    let c: BaseClass;
    if (u.type === 'meeting' || u.type === 'event') c = 'human';
    else {
      const mail = isMailItem(u.source, u.container);
      const author = authorOf(u);
      const at = dayEnd(u.day);
      const wrote = mail && !!u.thread && !!store?.mail.subjectWroteIn(u.thread, at);
      c = baseSenderClass({ source: u.source, author: u.author, container: u.container, isBotFlag: u.isBot, subject: u.subject, text: u.text, subjectWroteInThread: wrote, authorResolved: !!author });
      if (c === 'human' && mail && !author && !wrote && store?.mail.oneWay(senderKey(u.author ?? ''), at)) c = 'bulk';
    }
    classes.set(u.id, c);
    return c;
  };

  const hostsAppsOf = (u: ItemUnit) => textHostsApps(u);
  const family = (u: ItemUnit): string => {
    const ha = hostsAppsOf(u);
    return JSON.stringify([u.source, senderKey(u.author ?? ''), templateOf(headOf({ subject: isMailItem(u.source, u.container) ? u.subject : null, text: u.text })), ha.hosts[0] ?? ha.apps[0] ?? '']);
  };
  const caseOf = (task: 't4-kind' | 't4-addressee', u: ItemUnit): string => (senderClass(u) !== 'human' && u.type === 'message' ? `family:${family(u)}:${u.day}` : caseKeyOf(task, u));

  // --- T2 -------------------------------------------------------------------------------------------------
  const featOf = (u: ItemUnit): DedupFeat => {
    const human = senderClass(u) === 'human';
    const mail = isMailItem(u.source, u.container);
    const medium: DedupFeat['medium'] = u.type === 'meeting' || u.type === 'event' ? 'meeting' : u.type === 'task' || u.type === 'comment' ? 'tracker' : mail ? 'mail' : u.container ? 'chat' : 'other';
    const keys = u.keys ?? [];
    const trackerKeys = keys.filter((k) => TRACKER_KEY.test(k));
    const urls = keys.filter((k) => /^https?:\/\//i.test(k) && !/\[redacted/i.test(k) && !k.endsWith('…'));
    const domain = (senderKey(u.author ?? '').split('@')[1] ?? '').toLowerCase();
    return {
      id: u.id,
      t: Date.parse(u.ts),
      human,
      task: u.type === 'task',
      medium,
      sender: human ? authorOf(u) || senderKey(u.author ?? '') : senderKey(u.author ?? ''),
      container: u.container ?? '',
      thread: u.thread ?? '',
      reply: isSlackReply(u),
      exact: exactKey(u, mail),
      clipped: (u.text ?? '').length >= 1000 && (u.text ?? '').endsWith('…'),
      norm: normBody(u.text),
      words: exactTokens(u.text),
      subject: mail ? normBody(stripSubject(u.subject)) : '',
      forward: mail && FORWARD_PREFIX.test(u.subject ?? ''),
      alert: human ? null : alertOf(u.text),
      alertId: human ? '' : alertIdentity(u.text),
      targets: human ? [] : (() => {
        const ha = hostsAppsOf(u);
        return [...ha.hosts, ...ha.apps].sort();
      })(),
      links: [...urls, ...trackerKeys],
      trackerKeys,
      trackerMail: mail && !human && (TRACKER_MAIL_DOMAIN.test(domain) || TRACKER_SUBJECT.test(u.subject ?? '')),
      trackerCreated: TRACKER_CREATED.test(`${u.subject ?? ''}\n${(u.text ?? '').slice(0, 400)}`),
      ownKey: u.type === 'task' && keys[0] && TRACKER_KEY.test(keys[0]) ? keys[0] : '',
      callId: u.type === 'meeting' && u.thread && u.thread !== u.id ? u.thread : '',
      family: human ? '' : family(u),
    };
  };

  // --- T3 -------------------------------------------------------------------------------------------------
  // The class of the string itself. Only an AUTHOR carries its record: the mail's content, folder and thread say
  // what its sender is. A recipient of a spam campaign is a person on a bought list, not the campaign — for every
  // other field only the address speaks (role/automated mailbox, integration names and relays).
  const mentionClass = (u: MentionUnit): BaseClass => {
    const author = u.field === 'author';
    const rec = author && store ? store.record(u.ref) : null;
    const container = author ? (u.context.container ?? rec?.container ?? null) : null;
    const mail = isMailItem(u.source, u.context.container ?? rec?.container ?? null);
    const at = dayEnd(u.day);
    const wrote = mail && !!rec?.thread && !!store?.mail.subjectWroteIn(rec.thread, at);
    let c = baseSenderClass({
      source: u.source,
      author: u.raw,
      container,
      isBotFlag: rec?.isBot ?? false,
      subject: rec?.subject ?? null,
      text: rec?.text ?? '',
      subjectWroteInThread: wrote,
      authorResolved: false,
    });
    if (c === 'human' && mail && author && !wrote && store?.mail.oneWay(senderKey(u.raw), at)) c = 'bulk';
    return c;
  };
  // A campaign from a personal-looking mailbox (jane@, a CEO's "quick note") is still somebody: bulk decides
  // `system` only from a role/automated/campaign mailbox; otherwise it is a strong guess (.85), not a decision.
  // Domains the roster's people have addresses at, free-mail providers aside.
  const FREEMAIL = /^(?:gmail|googlemail|outlook|hotmail|live|msn|yahoo|ymail|icloud|me|mac|aol|gmx|web|t-online|freenet|proton|protonmail|mail|yandex|ya|rambler|bk|list|inbox|tut|zoho|fastmail|hey|posteo|libero|virgilio|tiscali|orange|free|laposte|seznam|wp|o2|interia|onet)\./i;
  const rosterDomains = new Set([...R.domains.values()].flatMap((d) => [...d]).filter((d) => !FREEMAIL.test(d)));
  const ownDomain = (raw: string): boolean => {
    const p = parseSender(raw);
    return !!p.domain && [...rosterDomains].some((d) => p.domain === d || p.domain.endsWith(`.${d}`));
  };
  const roleMailbox = (raw: string): boolean => {
    const p = parseSender(raw);
    return !!p.email && (ROLE_LOCAL.test(p.local) || AUTOMATED_LOCAL.test(p.local) || BULK_LOCAL.test(p.local));
  };

  const mention = (u: MentionUnit): Floor & { split?: string[] } => {
    const kase = `form:${formKey(u.raw)}`;
    const eventPeople = new Set((u.context.linkedEvent?.attendees ?? []).map((a) => personOf(a)).filter(Boolean));
    const coPresent = new Set<string>(eventPeople);
    for (const s of u.context.speakers ?? []) {
      const p = personOf(s);
      if (p) coPresent.add(p);
    }
    for (const m of u.context.coMentions ?? []) {
      const p = personOf(m);
      if (p) coPresent.add(p);
    }
    const r = resolveMention(R, u.raw, { eventPeople, coPresent });
    if (r.label) return { label: r.label, conf: r.conf, rung: r.rung, candidates: r.candidates, hint: '', case: kase, ...(r.split ? { split: r.split } : {}) };
    // Nobody in the roster (no candidate at all): is the string a person at all?
    const nobody = r.rung === 'abstain' || (r.rung === 'glued:partial' && !r.candidates.length);
    const cls = nobody ? mentionClass(u) : 'human';
    if (cls === 'bulk' && !roleMailbox(u.raw)) return { label: 'system', conf: 0.85, rung: 'sender:bulk~', candidates: ['system'], hint: 'campaign from a personal-looking mailbox', case: kase };
    // A role mailbox of an organisation the roster works at (office@, support@ of a known company) may be read by one
    // of its people: a question ("who reads it?"), not a decision.
    if (cls === 'system' && ownDomain(u.raw)) return { label: 'system', conf: 0.8, rung: 'sender:system~', candidates: ['system'], hint: 'a shared mailbox of a known organisation', case: kase };
    if (cls !== 'human') return { label: 'system', conf: 0.95, rung: `sender:${cls}`, candidates: ['system'], hint: `${cls} sender`, case: kase };
    if (nobody && roleLike(u.raw)) return { label: 'system', conf: 0.9, rung: 'sender:role~', candidates: ['system'], hint: 'a shared or functional mailbox', case: kase };
    return { label: null, conf: 0, rung: r.rung, candidates: r.candidates, hint: r.candidates.length ? `maybe ${r.candidates.join(' / ')}` : '', case: kase };
  };

  // --- T4 -------------------------------------------------------------------------------------------------
  const textForCues = (u: ItemUnit): string => (isMailItem(u.source, u.container) || u.type === 'task' ? `${u.subject ?? ''}\n${u.text ?? ''}` : (u.text ?? ''));
  // Small talk is a chat/comment thing: a mail or a ticket with "Thanks!" as its body still has a subject.
  const smallTalk = (u: ItemUnit): boolean => (u.type === 'message' || u.type === 'comment') && !isMailItem(u.source, u.container) && isSmallTalk(u.text);
  const RELAYED = /^\s*\*[^*\n]{2,60}\*:\s*\n/;

  // A role mailbox that writes a ticket or a comment is a client's shared account typing: people's words.
  const writtenByPeople = (u: ItemUnit, cls: SenderClass): boolean => cls === 'human' || (cls === 'system' && (u.type === 'task' || u.type === 'comment'));

  const kind = (u: ItemUnit): Floor & { cues: Cue[] } => {
    const cls = senderClass(u);
    const human = writtenByPeople(u, cls);
    const relay = !human && (isSlackReply(u) || RELAYED.test(u.text ?? ''));
    const k = kindOf({ cls, human, cues: cuesOf(textForCues(u)), alert: human ? null : alertOf(u.text), smallTalk: human && smallTalk(u), relay });
    return { ...k, case: caseOf('t4-kind', u) };
  };

  // The container's people as of the end of the unit's day (who wrote there or owns one of its tickets) plus the
  // item's own participants.
  const membersOf = (u: ItemUnit): Set<string> => {
    const at = dayEnd(u.day);
    const s = new Set<string>([...(store?.members.get(u.container ?? '') ?? [])].filter(([, t]) => t <= at).map(([p]) => p));
    for (const p of u.participants) {
      const id = personOf(p);
      if (id) s.add(id);
    }
    for (const p of u.toPersons) s.add(p);
    return s;
  };

  const HANDLE_G = /(?<![\p{L}\p{N}_.@])@([\p{L}\p{N}][\p{L}\p{N}_.-]{1,40})/gu;
  const mentionsOf = (u: ItemUnit, present: ReadonlySet<string>): { pid: string; conf: number }[] => {
    const text = u.text ?? '';
    const out = new Map<string, number>();
    const put = (pid: string, conf: number) => out.set(pid, Math.max(out.get(pid) ?? 0, conf));
    // A participant label written as @Label in the text (Slack flattens <@U…> to @<label>; labels may hold spaces).
    for (const p of u.participants) {
      if (!p || p === u.author || !text.includes(`@${p}`)) continue;
      const id = personOf(p);
      if (id) put(id, 0.95);
    }
    for (const m of text.matchAll(HANDLE_G)) {
      const h = m[1]!.replace(/[._-]+$/, '');
      if (/^(?:here|channel|everyone|all|admin|team)$/i.test(h)) continue;
      const r = resolveMention(R, h, { coPresent: present });
      if (r.label && !r.label.includes('+') && r.conf >= 0.95) put(r.label, 0.95);
      else if (r.label && !r.label.includes('+')) put(r.label, 0.9);
      else {
        // A first-name handle (@ana): one roster person with that first name, present or not.
        if (r.rung === 'first:absent' && r.candidates.length === 1) put(r.candidates[0]!, 0.9);
      }
    }
    return [...out].map(([pid, conf]) => ({ pid, conf }));
  };

  const addressee = (u: ItemUnit): Floor => {
    const cls = senderClass(u);
    const human = writtenByPeople(u, cls);
    const mail = isMailItem(u.source, u.container);
    const where = containerKind(u.source, u.container, mail, u.type);
    const author = authorOf(u) || null;
    const present = membersOf(u);
    let members: string[];
    if (where === 'mail') {
      // Header order (sender, To…, Cc…, Bcc…) with the sender dropped; an unresolved recipient keeps its place as ''.
      const list = u.participants.filter((p) => p !== u.author);
      members = list.map((p) => personOf(p));
    } else members = [...new Set([...u.participants.map((p) => personOf(p)).filter(Boolean), ...u.toPersons])];
    // "Ana, …": the one container member called Ana (.85), else the one roster person called Ana (.80).
    let vocative: { pid: string; conf: number } | null = null;
    const name = human ? openingName(translit(u.text ?? '')) : null;
    if (name) {
      const want = formKey(name.word).split(' ')[0] ?? '';
      const named = (p: string) => p !== author && (name.surname ? R.tokens.get(p)?.at(-1) : R.tokens.get(p)?.[0]) === want;
      const near = [...present].filter(named);
      const far = near.length ? [] : [...R.tokens.keys()].filter(named);
      if (near.length === 1) vocative = { pid: near[0]!, conf: 0.85 };
      else if (far.length === 1) vocative = { pid: far[0]!, conf: 0.8 };
    }
    // The message this one answers: the latest earlier message of the thread by someone else.
    let parent: string | null = null;
    for (const c of [...(u.context ?? [])].reverse()) {
      const p = personOf(c.author);
      if (p && p !== author) {
        parent = p;
        break;
      }
      if (!p && c.author && c.author !== u.author) break; // answers someone we cannot name
    }
    const a = addresseeOf({
      human,
      type: u.type,
      author,
      subject,
      where,
      asks: cuesOf(textForCues(u)).includes('R'),
      mentions: human ? mentionsOf(u, present) : [],
      members,
      assignee: u.type === 'task' ? (u.toPersons[0] ?? null) : null,
      vocative,
      parent,
      smallTalk: human && smallTalk(u),
    });
    return { ...a, case: caseOf('t4-addressee', u) };
  };

  return {
    senderClass,
    family,
    hostsApps: hostsAppsOf,
    mention,
    kind,
    addressee,
    dedup(dayUnits) {
      const sorted = [...dayUnits].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (const u of sorted) engine.add(featOf(u));
      const out = new Map<string, { cluster: string; conf: number }>();
      for (const u of dayUnits) out.set(u.id, engine.label(u.id));
      return out;
    },
    dedupVia: (id) => engine.joined.get(id) ?? 'single',
    resolve: (raw) => resolve(raw),
  };
}
