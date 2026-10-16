// Key extraction (design §3.2): the typed keys of one unit, from the unit and what the stage-0 floor says about it.
//
// Two layers, so evidence is never lost to timing:
//   candidates  every key whose SHAPE fits the unit (a call's series title, each rare-looking title word). They are
//               stored per unit, and an answer about the unit feeds all of them — the first call of a series is
//               evidence for the series even though nobody knew yet that it was one.
//   active      the candidates that may predict or group TODAY: a series once seen on ≥2 calls, a token while it
//               stays rare (df ≤ 5% of the units seen so far). Pool statistics (PoolStats) answer that; they come
//               from the stream itself (every unit of the day, decided or not), never from labels.
// Pure: no I/O, no model.

import { alertOf, familyKey, senderKey, templateOf } from '../../../sources/fingerprint.js';
import { foldName, foldTokens } from '../../../sources/identities/attendees.js';
import { BOT_NAMES, isMailItem, parseSender } from '../../../sources/sender.js';
import type { FragmentUnit, ItemUnit, MentionUnit } from '../../types.js';
import type { SenderClass } from '../stage0/index.js';
import { cuesOf, hasMention } from './cues.js';
import { keyId, typeOf, valueOf, type KeyType } from './spec.js';

// --- vocabulary ------------------------------------------------------------------------------------------------

export interface Vocab {
  names: Set<string>; // folded name tokens of the tenant's people: a name is a person, not a topic
}

// Function words and the vocabulary of calls/runs/mail themselves (EN/DE/RU/IT): they say nothing about a topic.
const STOP = new Set(
  `about above after again against also among another anything around because been before being below between both
  could does doing down during each either else even every from further have having here hers herself himself into itself
  just like make many more most much must myself near need only other ours ourselves over same shall should some such than
  that their theirs them themselves then there these they this those through under until upon very want were what when
  where which while will with within without would your yours yourself yourselves please thanks thank hello regards
  today tomorrow yesterday week weekly daily monthly call meeting meetings sync update updates notes note chat message
  messages thread reply forward fwd document documents file files link links team weeks days time
  aber alle allem allen aller alles also andere anderen auch auf aus bei beim bitte damit dann dass dein deine dem den
  denn der des dessen die dies diese diesem diesen dieser dieses doch dort durch eine einem einen einer eines euer
  für gegen habe haben hatte hier hinter ihre ihrem ihren ihrer jede jedem jeden jeder jedes jetzt kann kein keine
  können machen mehr mein meine mich mit muss nach nicht noch nur oder ohne sehr sein seine sich sind über unser
  unter viel vom von vor wann warum weil wenn werde werden wieder wird wurde zum zur zwischen danke gruß grüße
  termin besprechung
  если чтобы потому также только когда тогда этот эта это эти того тому всех всем свой своя свои была были было
  будет может можно нужно надо очень спасибо привет сегодня завтра вчера звонок встреча
  anche ancora come con cosa dalla dalle degli della delle dello dopo essere fare grazie hanno molto nella nelle
  nostro ogni oggi perché però prima questa queste questi questo quella quelle quelli quello sono sulla sulle tutti
  tutto ciao riunione`
    .split(/\s+/)
    .filter(Boolean),
);

const letters = (s: string): number => (s.match(/\p{L}/gu) ?? []).length;
const fold = (s: string): string => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const PLACEHOLDER = /^<[a-z]+>$/;

/** The words of a title/subject that may be topic tokens: ≥4 letters, not a function word, not a person's name. */
export function topicTokens(text: string | null | undefined, vocab: Vocab): string[] {
  const out = new Set<string>();
  for (const raw of templateOf(text ?? '', { k: Infinity }).split(' ')) {
    if (!raw || PLACEHOLDER.test(raw)) continue;
    const t = fold(raw.replace(/<[a-z]+>/g, ''));
    if (letters(t) < 4 || STOP.has(t) || vocab.names.has(t) || vocab.names.has(foldName(t))) continue;
    out.add(t);
  }
  return [...out];
}

/** Folded name tokens of a roster (names and name-like identities), for `topicTokens`. */
export function nameVocab(people: readonly { person_id: string; name?: string; identities?: string[] }[]): Vocab {
  const names = new Set<string>();
  for (const p of people) {
    for (const t of p.person_id.split(/[-_.]/)) if (t) names.add(fold(t));
    for (const s of [p.name ?? '', ...(p.identities ?? [])]) for (const t of foldTokens(s.replace(/^(?:slack|msgraph):/, ''))) names.add(t);
  }
  return { names };
}

// --- shared shapes ---------------------------------------------------------------------------------------------

const REPLY_PREFIX = /^\s*(?:(?:re|fw|fwd|aw|wg|antw|sv|vs|tr|rif|ответ|отв|пересл)\s*(?:\[\d+\])?\s*:\s*)+/i;
const VALUE_TOKEN = /<(?:n|date|time|hex|id|uuid|url|email|mention|redacted|withheld)>/g;

/** A recurring call title: the part before " — <topic>", values (digits, dates, ids) dropped. '' when nothing is left. */
export function seriesOf(title: string | null | undefined): string {
  const head = (title ?? '').split(/\s+[—–]\s+/)[0] ?? '';
  return templateOf(head, { k: Infinity }).replace(VALUE_TOKEN, ' ').replace(/\s+/g, ' ').trim();
}

/** A mail subject without Re:/Fwd:/AW:/WG: prefixes, values as placeholders (an invoice number is not the subject). */
export function subjectOf(subject: string | null | undefined): string {
  return templateOf((subject ?? '').replace(REPLY_PREFIX, ''), { k: Infinity });
}

const FREE_MAIL = new Set(
  `gmail.com googlemail.com yahoo.com yahoo.de yahoo.it ymail.com outlook.com hotmail.com hotmail.de hotmail.it live.com msn.com
  icloud.com me.com mac.com aol.com gmx.de gmx.net gmx.at gmx.ch gmx.com web.de t-online.de freenet.de mail.ru bk.ru inbox.ru
  list.ru yandex.ru yandex.com ya.ru rambler.ru proton.me protonmail.com pm.me libero.it virgilio.it tiscali.it alice.it
  ukr.net i.ua tut.by zoho.com fastmail.com hey.com mail.com`.split(/\s+/).filter(Boolean),
);
export const isFreeMail = (domain: string): boolean => FREE_MAIL.has(domain.toLowerCase());

/** The other side of a mail: its author, or for the subject's own mail the first participant who is not the author. */
export function counterpartOf(u: ItemUnit): { address: string | null; domain: string | null } {
  const author = parseSender(u.author ?? '');
  const pick = u.fromSubject ? u.participants.map((p) => parseSender(p)).find((p) => p.email && p.email !== author.email) : author;
  if (!pick?.email) return { address: null, domain: null };
  return { address: pick.email, domain: pick.domain || null };
}

// Hosts that never name what an item is about: code hosts, chat, docs, CDNs, social — the platform, not the target.
const PLATFORM = `github.com githubusercontent.com gitlab.com bitbucket.org google.com googleusercontent.com gstatic.com googleapis.com
  slack.com slack-edge.com atlassian.net atlassian.com youtrack.cloud myjetbrains.com jetbrains.com sentry.io getsentry.com notion.so
  figma.com zoom.us microsoft.com office.com office365.com sharepoint.com live.com outlook.com apple.com linkedin.com twitter.com x.com
  facebook.com instagram.com youtube.com youtu.be w3.org schema.org gravatar.com cloudfront.net intercom.com intercom.io
  intercomcdn.com asana.com trello.com loom.com calendly.com mailchimp.com list-manage.com claude.ai anthropic.com`
  .split(/\s+/)
  .filter(Boolean);
const URL_HOST_G = /\bhttps?:\/\/([^/\s:?#<>|*"'`)\]]+)/gi;

const registrable = (host: string): string => {
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const sld = parts[parts.length - 2]!;
  const tld = parts[parts.length - 1]!;
  return tld.length === 2 && /^(?:co|com|org|net|gov|ac|edu)$/.test(sld) ? parts.slice(-3).join('.') : parts.slice(-2).join('.');
};
const under = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

/** Hostnames an item links to (lower-case, www./port/path stripped), minus platforms and the sender's own domain. */
export function hostsOf(u: Pick<ItemUnit, 'text' | 'subject' | 'keys' | 'author'>): string[] {
  const own = parseSender(u.author ?? '').domain;
  const ownReg = own ? registrable(own) : '';
  const out = new Set<string>();
  for (const s of [u.subject ?? '', u.text ?? '', ...(u.keys ?? [])]) {
    for (const m of s.matchAll(URL_HOST_G)) {
      const host = m[1]!.toLowerCase().replace(/^www\./, '').replace(/\.+$/, '');
      if (!host.includes('.') || /\[redacted/i.test(host)) continue;
      if (ownReg && under(host, ownReg)) continue;
      if (PLATFORM.some((p) => under(host, p))) continue;
      out.add(host);
    }
  }
  return [...out].sort();
}

// Deploy notices name the app: "Deploying shop-api@3f2a9c1 to production", "shop-api@3f2a9c1 deployed to staging",
// "deploy finished: shop-api (production)".
const DEPLOY_APP_G = /\b([a-z][\w.-]{1,40})@(?=[0-9a-f]{0,39}\d)[0-9a-f]{6,40}\b(?![.@])|\bdeploy(?:ment)?\s+(?:finished|failed|started|succeeded)\s*:\s*([a-z][\w.-]{1,40})/gi;
// A bracketed head that is a state or a tool, not an app: "[WARNING] …", "[RESOLVED] …", "[YouTrack] …".
const NOT_APP = new Set([
  ...['firing', 'resolved', 'warning', 'warn', 'critical', 'crit', 'error', 'alert', 'alarm', 'ok', 'info', 'notice', 'recovered', 'triggered', 'down', 'up', 'test'],
  ...[...BOT_NAMES].map((n) => n.replace(/\s+/g, '')),
]);

/**
 * App/project tokens: a code host's "[org/repo] …" and a deploy notice's app. A bare bracketed head ("[shop-api] …")
 * counts too, unless it names an alert state or the tool itself.
 */
export function appsOf(u: Pick<ItemUnit, 'text' | 'subject'>): string[] {
  const out = new Set<string>();
  for (const s of [u.subject ?? '', u.text ?? '']) {
    const m = /^\s*\[(?:[\w.-]+\/)?([\w.-]{2,40})\]/.exec(s);
    if (m && !NOT_APP.has(m[1]!.toLowerCase().replace(/[\s._-]+/g, ''))) out.add(m[1]!.toLowerCase());
    for (const d of s.matchAll(DEPLOY_APP_G)) out.add((d[1] ?? d[2])!.toLowerCase());
  }
  return [...out].sort();
}

/**
 * A family when the floor has none: sender + the 6-token template of the head + the first app/host token. An alert's
 * identity (rule + target, hosts kept — fingerprint.ts alertOf) replaces the template, firing and resolved alike: both
 * are about the same target.
 */
export function ownFamily(u: ItemUnit, hosts: string[], apps: string[]): string {
  const alert = alertOf(u.text ?? '');
  if (alert) return JSON.stringify([u.source, senderKey(u.author ?? ''), 'alert', alert.key]);
  return `${familyKey({ source: u.source, sender: u.author ?? '', subject: u.subject, text: u.text ?? '' })}|${apps[0] ?? hosts[0] ?? ''}`;
}

// --- pool statistics ---------------------------------------------------------------------------------------------

export interface PoolStats {
  seen: number; // units counted (for token df)
  df: Map<string, number>; // token → units carrying it
  series: Map<string, Set<string>>; // series title → the calls (case keys) it was seen on
  counted: Set<string>; // unit ids already counted
}

export const newPoolStats = (): PoolStats => ({ seen: 0, df: new Map(), series: new Map(), counted: new Set() });

/** Count a unit's candidate keys into the pool statistics, once per unit. */
export function notePool(stats: PoolStats, id: string, candidates: readonly string[], caseKey: string): void {
  if (stats.counted.has(id)) return;
  stats.counted.add(id);
  stats.seen++;
  for (const k of candidates) {
    const t = typeOf(k);
    if (t === 'token') stats.df.set(valueOf(k), (stats.df.get(valueOf(k)) ?? 0) + 1);
    else if (t === 'series') {
      const calls = stats.series.get(valueOf(k)) ?? new Set<string>();
      calls.add(caseKey);
      stats.series.set(valueOf(k), calls);
    }
  }
}

export const TOKEN_MAX_DF = 0.05;
export const SERIES_MIN_CALLS = 2;

/** May this candidate predict or group today? A series seen on ≥2 calls; a token still rare. */
export function isActive(stats: PoolStats, key: string): boolean {
  const t = typeOf(key);
  if (t === 'series') return (stats.series.get(valueOf(key))?.size ?? 0) >= SERIES_MIN_CALLS;
  if (t === 'token') return (stats.df.get(valueOf(key)) ?? 0) <= TOKEN_MAX_DF * Math.max(1, stats.seen);
  return true;
}

// --- per unit kind ---------------------------------------------------------------------------------------------

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');
const push = (out: string[], type: KeyType, value: string | null | undefined): void => {
  if (value) out.push(keyId(type, value));
};

export interface FragmentFloorView {
  participants: string[];
  cowork: string[]; // labels of work blocks decided by structure next to this fragment
}

/** t1-fragment: series (calls), run (threads), cpset (calls/threads), token (titles), cowork (calls/threads). */
export function fragmentKeys(u: FragmentUnit, fl: FragmentFloorView, subject: string | undefined, vocab: Vocab): string[] {
  const out: string[] = [];
  if (u.kind === 'call') push(out, 'series', seriesOf(u.title));
  if (u.kind === 'thread') push(out, 'run', u.container ? norm(u.container) : null);
  if (u.kind !== 'work') {
    const cps = [...new Set((fl.participants.length ? fl.participants : u.participants).filter((p) => p && p !== subject))].sort();
    push(out, 'cpset', cps.join(','));
    for (const l of [...new Set(fl.cowork)].sort()) push(out, 'cowork', l);
  }
  for (const t of topicTokens(u.title, vocab)) push(out, 'token', t);
  return out;
}

/** Work blocks next to a fragment (±slack minutes) that structure decided at ≥ minConf: their labels (the timelog signal). */
export function coworkOf(u: FragmentUnit, decidedWork: readonly { start: string; end: string; label: string }[], slackMin = 45): string[] {
  if (u.kind === 'work') return [];
  const s = Date.parse(u.start);
  const e = Date.parse(u.end);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return [];
  const pad = slackMin * 60_000;
  const out = new Set<string>();
  for (const w of decidedWork) {
    const ws = Date.parse(w.start);
    const we = Date.parse(w.end);
    if (Number.isFinite(ws) && Number.isFinite(we) && ws <= e + pad && we >= s - pad) out.add(w.label);
  }
  return [...out].sort();
}

export interface ItemFloorView {
  senderClass: SenderClass;
  family: string;
  hosts: string[];
  apps: string[];
}

/** The integration-side facts of an item: the floor's when it has them, else our own (a stub floor knows nothing). */
export function itemFacts(u: ItemUnit, fl: ItemFloorView): { family: string; hosts: string[]; apps: string[] } {
  // The sender's own domain is the tool, not the target (a tracker's notification links to the tracker).
  const own = parseSender(u.author ?? '').domain;
  const ownReg = own ? registrable(own) : '';
  const hosts = (fl.hosts.length ? fl.hosts : hostsOf(u)).filter((h) => !ownReg || !under(h, ownReg));
  const apps = [...new Set([...fl.apps, ...appsOf(u)])].sort();
  const family = fl.family && fl.family !== u.id ? fl.family : ownFamily(u, hosts, apps);
  return { family, hosts, apps };
}

/** t1-item: thread, family/host/app (integrations), subject/domain (mail), container/sender (people), token. */
export function itemKeys(u: ItemUnit, fl: ItemFloorView, vocab: Vocab): string[] {
  const out: string[] = [];
  const mail = isMailItem(u.source, u.container);
  const cls = fl.senderClass;
  push(out, 'thread', u.thread);
  if (cls === 'bot' || cls === 'bulk') {
    const f = itemFacts(u, fl);
    push(out, 'family', f.family);
    if (cls === 'bot') {
      for (const h of f.hosts) push(out, 'host', h);
      for (const a of f.apps) push(out, 'app', a);
    }
  }
  if (mail) {
    const cp = counterpartOf(u);
    const s = subjectOf(u.subject);
    if (s && cp.domain) push(out, 'subject', `${s}|${isFreeMail(cp.domain) ? cp.address : cp.domain}`);
    if (cp.domain && !isFreeMail(cp.domain)) push(out, 'domain', cp.domain);
  }
  if (cls === 'human') {
    if (!mail) push(out, 'container', channelIdOf(u.id) ?? (u.container ? norm(u.container) : null));
    push(out, 'sender', u.authorPerson ?? (u.author ? senderKey(u.author) : null));
  }
  for (const t of topicTokens(u.subject, vocab)) push(out, 'token', t);
  return out;
}

/** The channel id inside a Slack ref (`slack:<team>:<channel>:<ts>`): rename-proof, unlike the channel's name. */
export function channelIdOf(ref: string): string | null {
  const p = ref.split(':');
  return p[0] === 'slack' && p.length >= 4 && /^[CDG][A-Z0-9]{6,}$/.test(p[2]!) ? p[2]! : null;
}

const isReply = (u: ItemUnit): boolean => (u.context?.length ?? 0) > 0 || REPLY_PREFIX.test(u.subject ?? '') || u.type === 'comment';

/**
 * t4-kind: the family of an integration item; the cue signature of a person's item. `cues` are the floor's when it
 * fires them (the lexicon shared with J's cite check), else ours (cues.ts).
 */
export function kindKeys(u: ItemUnit, fl: ItemFloorView, floorCues?: readonly string[]): string[] {
  const out: string[] = [];
  if (fl.senderClass === 'bot' || fl.senderClass === 'bulk') push(out, 'family', itemFacts(u, fl).family);
  if (fl.senderClass === 'human') {
    const cues = floorCues ? [...new Set(floorCues)].sort() : cuesOf([u.subject ?? '', u.text ?? ''].filter(Boolean).join('\n'));
    push(out, 'cue', `${cues.join(',') || '-'}|${isReply(u) ? 'reply' : 'top'}|${hasMention(u.text) ? 'mention' : 'plain'}`);
  }
  return out;
}

/** t4-addressee: the container's usual addressee, for items the floor cannot address explicitly. */
export function addresseeKeys(u: ItemUnit, explicit: boolean): string[] {
  return explicit || !u.container ? [] : [keyId('cont→to', norm(u.container))];
}

/** t3: the folded surface form — a bare address lower-cased, anything else name-folded (accents, case, "| Company"). */
export function formOf(u: Pick<MentionUnit, 'raw'>): string {
  const raw = u.raw.trim();
  return /^[^\s@<>]+@[^\s@<>]+$/.test(raw) ? raw.toLowerCase() : foldName(raw) || norm(raw);
}

export const mentionKeys = (u: MentionUnit): string[] => [keyId('form', formOf(u))];
