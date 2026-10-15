// The pre-model repeat key. Integration items are 76–97% of a tenant's stream, and most of them say the same thing
// again: an alert and its "resolved", a webhook per sign-up, a nightly digest, the analyzer bot that answers every
// alert. Before anything reads the stream (a review, a classifier, the "nothing new?" check), fold the repeats into
// families and look at one representative per family. Three layers:
//   templateOf(text)  the shape of a text: lower-case, values (links, addresses, ids, numbers, dates, scrubbed
//                     secrets) as typed placeholders, punctuation gone, the first k tokens
//   familyKey(item)   source + sender + the template of the head (a mail's subject without Re:/Fwd:, else the text)
//   fold(items)       the families of a batch, each with its canonical (first) item and why every member is in it
// No content dedup exists today: the store dedups raw lines, identical tracker rows and recorder copies only. Pure,
// deterministic, no model; not wired yet (the store or a whole-store pass adopts it behind a rollout flag).

import { isMailItem } from './sender.js';

// --- templates ---------------------------------------------------------------------------------------------

export interface TemplateOptions {
  k?: number; // tokens kept (default 6; Infinity = the whole template)
}

export const DEFAULT_K = 6;

// Typed placeholders are written with private-use brackets while the text is cut up, so the punctuation pass cannot
// touch them and a literal "<b>" in the text never looks like one; they become <name> at the end.
const ph = (name: string): string => `\uE000${name}\uE001`;

const WITHHELD_G = /\[body withheld[^\]]*\]/g; // scrub.ts withheldMarker: a whole body replaced
const REDACTED_G = /\[redacted:[^\]\s]*\]/g; // scrub.ts tag(): [REDACTED:<kind>:<hash6>]
const SLACK_LINK_G = /<(?:https?|mailto|ftp):[^>|\s]+(?:\|[^>]*)?>/g; // <https://x|label>
const SLACK_MENTION_G = /<[@#!][^>\s]*>/g; // <@U0…>, <#C0…|general>, <!here>
const URL_G = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/g; // takes an embedded [REDACTED:…] with it (332 card tags sit in URLs)
const EMAIL_G = /[a-z0-9._%+=-]+@[a-z0-9.-]+\.[a-z]{2,}/g;
const UUID_G = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
const DATETIME_G = /\b\d{4}-\d{2}-\d{2}[t ]\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:z|[+-]\d{2}:?\d{2})?\b/g;
// ISO, 15.10.2026 and 10/15/26 — not 1.2.10, which is a version and stays a number.
const DATE_G = /\b(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}\.\d{1,2}\.\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/g;
const TIME_G = /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]\.?m\b\.?)?/g;
const HEX_G = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{6,}\b/g; // a digit AND a letter: "facade" is a word, "123456" a number
// Other machine ids (base36/62 tokens, Slack ids): letters and digits interleaved. "server12" or "4xx" are a word and a
// number — the number rule makes them "server<n>", which keeps the word.
const ID_G = /\b(?=[a-z0-9]*(?:[a-z]\d+[a-z]|\d[a-z]+\d))[a-z0-9]{8,}\b/g;
const NUM_G = /\d+(?:[.,:/-]\d+)*/g; // in place: "server12" → "server<n>", one token
const NOT_WORD_G = /[^\p{L}\p{M}\p{N}\s\uE000\uE001]/gu;

/** The shape of a text: what stays when the values are taken out. */
export function templateOf(text: string, opts: TemplateOptions = {}): string {
  const k = opts.k ?? DEFAULT_K;
  const s = (text ?? '')
    .replace(/№/g, ' ') // NFKC would turn it into "No", glued to the number it marks
    .normalize('NFKC')
    .toLowerCase()
    .replace(WITHHELD_G, ` ${ph('withheld')} `)
    .replace(SLACK_LINK_G, ` ${ph('url')} `)
    .replace(SLACK_MENTION_G, ` ${ph('mention')} `)
    .replace(URL_G, ` ${ph('url')} `)
    .replace(REDACTED_G, ` ${ph('redacted')} `)
    .replace(EMAIL_G, ` ${ph('email')} `)
    .replace(UUID_G, ` ${ph('uuid')} `)
    .replace(DATETIME_G, ` ${ph('date')} `)
    .replace(DATE_G, ` ${ph('date')} `)
    .replace(TIME_G, ` ${ph('time')} `)
    .replace(HEX_G, ` ${ph('hex')} `)
    .replace(ID_G, ` ${ph('id')} `)
    .replace(NUM_G, ph('n'))
    .replace(NOT_WORD_G, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const toks = s ? s.split(' ') : [];
  return (Number.isFinite(k) ? toks.slice(0, Math.max(0, k)) : toks).join(' ').replace(/\uE000/g, '<').replace(/\uE001/g, '>');
}

const SCRUB_TOKEN = /^<(?:withheld|redacted)>$/;
/** A template made of scrub placeholders only says nothing: two such items are never "the same". */
const hasContent = (template: string): boolean => template.split(' ').some((t) => t && !SCRUB_TOKEN.test(t));

// --- family keys -------------------------------------------------------------------------------------------

export interface FamilyItem {
  source: string;
  sender: string;
  subject?: string | null;
  text: string;
}

const REPLY_PREFIX = /^\s*(?:(?:re|fw|fwd|aw|wg|antw|sv|vs|tr|rif|ответ|отв|пересл)\s*(?:\[\d+\])?\s*:\s*)+/i;

/** The part of an item that names it: a mail's subject without reply/forward prefixes, otherwise the text. */
export function headOf(item: { subject?: string | null; text: string }): string {
  const subject = (item.subject ?? '').replace(REPLY_PREFIX, '').trim();
  return subject || item.text || '';
}

/** One spelling per sender: the (last) address when there is one — display names vary per mail — else the label. */
export function senderKey(sender: string): string {
  const s = (sender ?? '').trim().toLowerCase();
  const all = s.match(EMAIL_G);
  return all ? all[all.length - 1]! : s.replace(/\s+/g, ' ');
}

export function familyKey(item: FamilyItem, opts: TemplateOptions = {}): string {
  return JSON.stringify([item.source, senderKey(item.sender), templateOf(headOf(item), opts)]);
}

// --- alert states ------------------------------------------------------------------------------------------

const FIRING = new Set(['warning', 'warn', 'critical', 'crit', 'error', 'alert', 'alarm', 'firing', 'triggered', 'problem', 'down', 'failing', 'failed', 'failure', 'high', 'major', 'severe', 'emergency', 'disaster', 'incident']);
const RESOLVED = new Set(['resolved', 'recovered', 'recovery', 'ok', 'okay', 'cleared', 'normal', 'up', 'fixed']);
const FIRING_EMOJI = /🚨|🔥|🔴|❗|❌|⛔|⚠|:rotating_light:|:fire:|:red_circle:|:x:|:warning:|:exclamation:|:bangbang:|:boom:|:sos:|:no_entry:/u;
const RESOLVED_EMOJI = /✅|🟢|✔|☑|:white_check_mark:|:heavy_check_mark:|:large_green_circle:|:green_circle:|:ballot_box_with_check:/u;
const EDGE_PUNCT = /^[*_`~[\](){}<>:;,.|"'!?]+|[*_`~[\](){}<>:;,.|"'!?]+$/g;
export const ALERT_KEY_TOKENS = 8;
// A token that is only a value (a number, a time, a date, a uuid, a hex id): it varies between a firing and its resolve.
const VOLATILE_TOKEN = /^(?:[\d.,:%+-]+|\d{4}-\d{2}-\d{2}t[\d:.]+z?|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{6,})$/;

export interface AlertState {
  state: 'firing' | 'resolved';
  key: string; // the alert's identity: rule + target, values as typed by the sender (hosts and alarm names kept)
}

/**
 * An alert's state and identity from its first line. The state is a leading emoji (🚨/✅) or else the first state word
 * among the first three ("WARNING: Rule: …", ":rotating_light: Monitor triggered: …", "[RESOLVED] …"); the identity is
 * the next ALERT_KEY_TOKENS tokens with those state words removed — hosts, URLs and alarm names verbatim (unlike a template, which
 * would make every host the same <url>), bare numbers as <n> (a resolved message often reports a different value).
 */
export function alertOf(text: string): AlertState | null {
  const line = ((text ?? '').replace(/<((?:https?|mailto):[^>|\s]+)(?:\|[^>]*)?>/g, '$1').split('\n').find((l) => l.trim()) ?? '').trim();
  if (!line) return null;
  const raw = line.split(/\s+/);
  const lead = raw.slice(0, 2).join(' ');
  let state: AlertState['state'] | null = RESOLVED_EMOJI.test(lead) ? 'resolved' : FIRING_EMOJI.test(lead) ? 'firing' : null;
  const toks = raw
    .filter((w) => !/^:[a-z0-9_+-]+:$/i.test(w))
    .map((w) => w.toLowerCase().replace(EDGE_PUNCT, ''))
    .filter((w) => /[\p{L}\p{N}]/u.test(w));
  // Every state word among the first three goes, whichever decided: "🚨 CloudWatch Alarm" and "✅ CloudWatch Alarm",
  // or ":rotating_light: Monitor triggered" and ":sunglasses: Monitor resolved", must leave the same identity.
  for (let i = 0; i < Math.min(3, toks.length); ) {
    const w = toks[i]!.replace(/:\d+$/, ''); // "[FIRING:2]"
    const s = FIRING.has(w) ? 'firing' : RESOLVED.has(w) ? 'resolved' : null;
    if (!s) {
      i++;
      continue;
    }
    state ??= s;
    toks.splice(i, 1);
  }
  if (!state) return null;
  const key = toks
    .slice(0, ALERT_KEY_TOKENS)
    .map((t) => (VOLATILE_TOKEN.test(t) ? '<n>' : t))
    .join(' ');
  return key ? { state, key } : null;
}

// --- folding -----------------------------------------------------------------------------------------------

export interface FoldItem {
  id: string;
  ts: string; // ISO; an unparseable ts never folds
  source: string;
  container: string | null;
  sender: string;
  subject?: string | null;
  text: string;
  isBot: boolean; // not a person (sender.ts: bot, bulk or system)
  human?: boolean; // overrides !isBot when given
}

export interface FoldOptions {
  windowMinutes?: number; // a family spans at most this long from its first item (1440: "the same thing today")
  flapMinutes?: number; // a resolved within this of its firing (and the next firing within this of the resolved) (120)
  companionSeconds?: number; // a habitual follower bot within this of its leader (120)
  crosspostMinutes?: number; // the same long text in another container within this (10)
  // Backwards-compatible additions beyond the bench contract's four windows:
  k?: number; // template tokens (6)
  minCrosspostChars?: number; // cross-posts need this much text besides scrub placeholders (40)
  minHumanChars?: number; // a person's repeat folds only from this length on — "ok" twice is two answers (20)
  companionMinShare?: number; // follower posts that come within companionSeconds of the leader, of all its posts there (0.25)
  companionMinCount?: number; // … and at least this many of them (2)
}

export type FoldReason = 'exact' | 'template' | 'flap' | 'companion' | 'crosspost' | 'single';

export interface Folded {
  family: Map<string, string>; // item id → family id (`fam:<canonical id>`)
  canonical: Map<string, string>; // item id → the family's first item — its representative
  // item id → why it is in its family. A canonical carries the reason its family formed (its second member's), so
  // families can be counted by reason; an item alone is 'single'.
  reason: Map<string, FoldReason>;
}

export const FOLD_DEFAULTS: Required<FoldOptions> = {
  windowMinutes: 1440,
  flapMinutes: 120,
  companionSeconds: 120,
  crosspostMinutes: 10,
  k: DEFAULT_K,
  minCrosspostChars: 40,
  minHumanChars: 20,
  companionMinShare: 0.25,
  companionMinCount: 2,
};

interface Fam {
  id: string;
  canon: string;
  start: number;
  size: number;
}

interface Row {
  it: FoldItem;
  t: number;
  human: boolean;
  sender: string;
  container: string;
  chat: boolean; // a channel/DM with a container, where bots answer each other — not a mail inbox
}

/** The value-preserving text (only case and spacing normalised) and how much of it is not a scrub placeholder. */
function exactOf(it: FoldItem): { key: string; len: number } | null {
  const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const body = norm(it.text ?? '');
  const len = body.replace(WITHHELD_G, ' ').replace(REDACTED_G, ' ').replace(/\s+/g, ' ').trim().length;
  if (!/[\p{L}\p{N}]/u.test(body.replace(WITHHELD_G, ' ').replace(REDACTED_G, ' '))) return null; // a placeholder alone
  const subject = norm((it.subject ?? '').replace(REPLY_PREFIX, ''));
  return { key: subject ? `${subject}\n${body}` : body, len };
}

/**
 * Which bots follow which in a container: follower F of leader L when at least companionMinCount of F's posts there
 * come within companionSeconds after a post of L, and that is at least companionMinShare of F's posts there. A
 * reaction is a habit (an analyzer answers every alert: 40% of its posts within 2 minutes; the reverse order is 7%),
 * while two busy bots in one channel are not each other's companions.
 */
function companionHabits(rows: readonly Row[], o: Required<FoldOptions>): Set<string> {
  const span = o.companionSeconds * 1000;
  const byContainer = new Map<string, Row[]>();
  for (const r of rows) if (!r.human && r.chat && Number.isFinite(r.t)) byContainer.set(r.container, [...(byContainer.get(r.container) ?? []), r]);
  const posts = new Map<string, number>();
  const follows = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const [c, list] of byContainer) {
    let j = 0;
    for (let i = 0; i < list.length; i++) {
      const { t, sender } = list[i]!;
      bump(posts, `${c}\u0000${sender}`);
      while (list[j]!.t < t - span) j++;
      const leaders = new Set<string>();
      for (let x = j; x < i; x++) if (list[x]!.sender !== sender) leaders.add(list[x]!.sender);
      for (const l of leaders) bump(follows, `${c}\u0000${l}\u0000${sender}`);
    }
  }
  const out = new Set<string>();
  for (const [key, n] of follows) {
    const [c, , f] = key.split('\u0000');
    if (n >= o.companionMinCount && n / posts.get(`${c}\u0000${f}`)! >= o.companionMinShare) out.add(key);
  }
  return out;
}

/**
 * Fold a batch into repeat families. Items are taken in time order; each joins at most one earlier family, by the
 * first rule that matches (a family never spans more than windowMinutes from its first item):
 *   1. exact      the same text (case/spacing aside) from the same sender — for a person also in the same container
 *                 and at least minHumanChars long; from an integration in another container within crosspostMinutes
 *                 it is a cross-post
 *   2. crosspost  the same text, minCrosspostChars+, in another container within crosspostMinutes: any integration,
 *                 or the same person
 *   3. companion  (integrations, chat only) a habitual follower bot within companionSeconds of its leader joins the
 *                 leader's family — the analyzer's answer belongs with the alert it answers. Not in mail: an inbox is
 *                 not a channel, and next to a sender of 25 notifications a day anything looks like a follower
 *   4. flap       (integrations) a resolved within flapMinutes of the same alert's firing — or the next firing within
 *                 flapMinutes of the resolved — joins it: one family per flapping alert, not two
 *   5. template   (integrations) the same familyKey (source + sender + k-token template of the head); for an alert
 *                 the same alert identity and state instead (rule + target, alertOf), so hosts never share a family
 * People fold only by 1–2: a human item never joins an integration's family, nor the reverse. A scrub placeholder
 * alone never makes two items equal: a withheld body has no exact key, and a template of placeholders only no
 * template key. Deterministic: ties in time are broken by id.
 */
export function fold(items: readonly FoldItem[], opts: FoldOptions = {}): Folded {
  const o: Required<FoldOptions> = { ...FOLD_DEFAULTS };
  for (const [k, v] of Object.entries(opts) as [keyof FoldOptions, number | undefined][]) if (v !== undefined) o[k] = v;
  const W = o.windowMinutes * 60_000;
  const FLAP = o.flapMinutes * 60_000;
  const COMP = o.companionSeconds * 1000;
  const XP = o.crosspostMinutes * 60_000;
  const rows: Row[] = items
    .map((it) => {
      const t = Date.parse(it.ts);
      return { it, t: Number.isFinite(t) ? t : Infinity, human: it.human ?? !it.isBot, sender: senderKey(it.sender), container: it.container ?? '', chat: !!it.container && !isMailItem(it.source, it.container) };
    })
    .sort((a, b) => (a.t === b.t ? (a.it.id < b.it.id ? -1 : a.it.id > b.it.id ? 1 : 0) : a.t < b.t ? -1 : 1));
  const habits = companionHabits(rows, o);

  const live = (f: Fam, t: number) => t - f.start <= W; // false for an unparseable ts (Infinity − x, NaN)
  const exactIx = new Map<string, { fam: Fam; last: number; containers: Set<string> }>();
  const crossIx = new Map<string, { fam: Fam; last: number; container: string }>();
  const tplIx = new Map<string, Fam>();
  const alertIx = new Map<string, { fam: Fam; state: AlertState['state']; last: number }>();
  const recent = new Map<string, { t: number; sender: string; fam: Fam }[]>();
  const out: Folded = { family: new Map(), canonical: new Map(), reason: new Map() };

  for (const r of rows) {
    const { it, t, human, sender, container, chat } = r;
    const who = human ? 'h' : 'm';
    const ex = exactOf(it);
    const exKey = ex && (!human || ex.len >= o.minHumanChars) ? JSON.stringify([who, it.source, sender, human ? container : '', ex.key]) : null;
    const xKey = ex && ex.len >= o.minCrosspostChars ? JSON.stringify([who, human ? sender : '', ex.key]) : null;
    // An alert repeats per rule AND target AND state: its identity (hosts kept) plus firing/resolved is its template, so
    // one rule firing for three hosts makes three families, not one <url> family, and a resolve joins its firing only
    // through the flap rule (within flapMinutes). Everything else repeats by the k-token template of its head.
    const alert = human ? null : alertOf(it.text);
    const aKey = alert ? JSON.stringify([it.source, sender, alert.key]) : null;
    const tpl = human || alert ? '' : templateOf(headOf(it), { k: o.k });
    const tplKey = alert ? JSON.stringify([it.source, sender, alert.state, alert.key]) : tpl && hasContent(tpl) ? JSON.stringify([it.source, sender, tpl]) : null;

    // The first rule that finds a live family wins.
    const tryJoin = (f: Fam | undefined, why: FoldReason): { f: Fam; why: FoldReason } | null => (f && live(f, t) ? { f, why } : null);
    let pick: { f: Fam; why: FoldReason } | null = null;
    const e = exKey ? exactIx.get(exKey) : undefined;
    if (e) pick = tryJoin(e.fam, !e.containers.has(container) && t - e.last <= XP ? 'crosspost' : 'exact');
    if (!pick && xKey) {
      const x = crossIx.get(xKey);
      if (x && x.container !== container && t - x.last <= XP) pick = tryJoin(x.fam, 'crosspost');
    }
    if (!pick && !human && chat) {
      const leaders = (recent.get(container) ?? []).filter((p) => t - p.t <= COMP && p.sender !== sender && habits.has(`${container}\u0000${p.sender}\u0000${sender}`));
      if (leaders.length) pick = tryJoin(leaders[leaders.length - 1]!.fam, 'companion');
    }
    if (!pick && aKey) {
      const a = alertIx.get(aKey);
      if (a && a.state !== alert!.state && t - a.last <= FLAP) pick = tryJoin(a.fam, 'flap');
    }
    if (!pick && tplKey) pick = tryJoin(tplIx.get(tplKey), 'template');

    const f: Fam = pick?.f ?? { id: `fam:${it.id}`, canon: it.id, start: t, size: 0 };
    const why: FoldReason = pick?.why ?? 'single';
    if (f.size === 1) out.reason.set(f.canon, why); // the family forms: its canonical takes the reason it formed by
    f.size++;
    out.family.set(it.id, f.id);
    out.canonical.set(it.id, f.canon);
    out.reason.set(it.id, f.canon === it.id ? 'single' : why);

    // Register this item's keys. An index keeps the first family still live for the key, so later repeats join it.
    if (exKey) {
      const cur = exactIx.get(exKey);
      if (cur && cur.fam === f) {
        cur.last = t;
        cur.containers.add(container);
      } else if (!cur || !live(cur.fam, t)) exactIx.set(exKey, { fam: f, last: t, containers: new Set([container]) });
    }
    if (xKey) {
      const cur = crossIx.get(xKey);
      if (!cur || cur.fam === f || !live(cur.fam, t)) crossIx.set(xKey, { fam: f, last: t, container });
    }
    if (tplKey) {
      const cur = tplIx.get(tplKey);
      if (!cur || !live(cur, t)) tplIx.set(tplKey, f);
    }
    if (aKey) alertIx.set(aKey, { fam: f, state: alert!.state, last: t });
    if (!human && chat && Number.isFinite(t)) {
      const list = (recent.get(container) ?? []).filter((p) => t - p.t <= COMP);
      list.push({ t, sender, fam: f });
      recent.set(container, list);
    }
  }
  return out;
}
