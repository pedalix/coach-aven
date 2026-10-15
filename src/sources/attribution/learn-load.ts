// The learning loop's IO half, shadow only (design notes 10 §2.5, §3, §8–§9; iteration 2's K2a in notes 20): on every
// build whose tenant says `"learn": {"mode": "shadow"}` in attribution.json, gather what the pure learner (learn.ts)
// reads, run it, and store what it WOULD do. Everything is re-derived from scratch each build — deleting the store and
// rebuilding from raw plus the tenant reproduces it; nothing is learned in a model, in agent memory or in the store:
//
//   units        every fragment of the horizon with the ladder's OWN say re-derived — label, graded confidence, rung
//                instance (att_fragments shows the ledger's decision where one exists, so the floor's is recomputed from
//                the same drafts) — and every item of the item window with its floor decision (att_items); each with its
//                typed keys (ported from the bench's K, src/lab/variants/keys/extract.ts, so the measured priors hold),
//                its case key, its text (cue matching) and minutes
//   evidence     the contract (docs/sources.md → "Learning loop (shadow)"): a fragment's ledger line a PERSON decided
//                ('owen' or 'human:<id>', status decided) and an item's annotations/labels.jsonl line by a person. Never
//                the machine's own output — rule/model lines, pins, the floor, the learner's decisions, a model's guess:
//                fed back as evidence it froze its own errors in (poisoning test: weekly precision 100% → 81%)
//   initiatives  the registry as the sibling-aware rungs read it: umbrella, company, whether it can be a sibling, cues
//
// Out: att_learn (one row per unit: label, conf, rung, ask, audit) and the `att:learn` meta (calibration, key types,
// today's ranked questions, the audit sample, rule candidates, counts) — the `attribution` tool shows them on
// `learn: true`. Shadow: the plan, the pins and the timelog never read either.
import type { DatabaseSync } from 'node:sqlite';
import { attribute, type Attribution, type RuleRecord } from './ladder.js';
import { channelIdOf, normaliseRepo, normChannel, Registry, titleMatcher, type RegistryData } from './registry.js';
import { loadAttributionDrafts, localDay, type AttributionDrafts, type AttributionInputs } from './build.js';
import { topics, type FragmentDraft } from './fragment.js';
import { loadItems, type ItemIn } from './items-load.js';
import { hostsApps } from './items-text.js';
import { itemWindow } from './items.js';
import { isHumanDecider, isHumanLine, type Fragment } from '../annotations.js';
import type { Person } from '../people.js';
import { senderKey, templateOf } from '../fingerprint.js';
import { BOT_NAMES, isMailItem, parseSender, type SenderClass } from '../sender.js';
import { foldName, foldTokens } from '../identities/attendees.js';
import { learn, type Evidence, type InitiativeInfo, type LearnOpts, type LearnResult, type LearnUnit } from './learn.js';

/** The decide/ask cut (design §0): a unit decides at or above it, below it is a question. */
export const TAU = 0.95;
const TEXT_FRAGMENT = 3000;
const TEXT_ITEM = 2000;
const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const uniq = <T>(xs: readonly T[]): T[] => [...new Set(xs)];
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : []);
type Row = Record<string, unknown>;
const str = (v: unknown): string => (v == null ? '' : String(v));
const json = <T>(v: unknown, fallback: T): T => {
  try {
    return (JSON.parse(str(v)) as T) ?? fallback;
  } catch {
    return fallback;
  }
};

// --- labels: alias-resolved, splits spread (the bench's gold rule) --------------------------------------------

function spread(id: string, reg: Registry, depth = 0): [string, number][] {
  const r = reg.resolveAlias(id);
  const split = reg.get(r)?.split_into;
  if (!split || typeof split !== 'object' || depth > 3) return [[r, 1]];
  const sum = Object.values(split).reduce((a, b) => a + (b > 0 ? b : 0), 0) || 1;
  return Object.entries(split).flatMap(([t, w]) => spread(t, reg, depth + 1).map(([x, v]): [string, number] => [x, (Math.max(0, w) / sum) * v]));
}

/** An id as labels: alias followed, a split spread into its targets (largest share first). */
export const labelsOf = (id: string, reg: Registry): string[] => spread(id, reg).sort((a, b) => b[1] - a[1]).map(([x]) => x);

/**
 * Attributions → ONE label: shares made relative, aliases followed, splits spread; the top share wins (the bench scored
 * against this rule, so a person's split answer and the floor's decision compare as the bench compared them).
 */
export function labelOf(atts: readonly Attribution[], reg: Registry): string | null {
  const total = atts.reduce((a, x) => a + (x.share > 0 ? x.share : 0), 0);
  const acc = new Map<string, number>();
  for (const a of atts) {
    const frac = total > 0 ? Math.max(0, a.share) / total : 1 / atts.length;
    for (const [id, w] of spread(a.initiative, reg)) acc.set(id, (acc.get(id) ?? 0) + frac * w);
  }
  return [...acc].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null; // stable: ties keep the decider's order
}

// --- rung instances --------------------------------------------------------------------------------------------

/**
 * Rungs that map a key, a place or a person to ONE initiative — over-trusted wherever the client has sibling
 * initiatives (iteration 1: key:VN 52%, key:BKR 54%, client channels 17–68%). The sibling-aware learner (K2a) lets them
 * decide the umbrella, not the initiative, unless content or an earned key confirms it. Repo/path, host/app, admin and
 * the bulk rule are not: their errors were not sibling errors.
 */
const STRUCTURAL = new Set(['rule', 'excl', 'channel', 'key', 'title']);
export const isStructural = (rung: string): boolean => {
  const i = rung.indexOf(':');
  return i > 0 && STRUCTURAL.has(rung.slice(0, i));
};

/**
 * The fragment ladder's rule_id as a rung INSTANCE — the unit the calibration counts on (design §2.5), named as the
 * item floor names its own: rule:<id>, excl:<person>, repo:<org/repo>, path:<dir>, channel:<id|name>, key:<PREFIX>,
 * title:<pattern>, admin. The ladder says only which rung (registry:channel); the instance is which channel.
 */
export function fragmentRung(ruleId: string, d: Pick<FragmentDraft, 'kind' | 'title' | 'container' | 'refs' | 'projectKeys' | 'route'>, reg: Registry): string {
  if (ruleId === 'admin') return 'admin';
  if (ruleId.startsWith('marker:')) return `excl:${ruleId.slice('marker:'.length)}`;
  if (ruleId === 'registry:repo/path') return d.route?.reason.startsWith('path ') ? `path:${d.container ?? ''}` : `repo:${normaliseRepo(d.container ?? '')}`;
  if (ruleId === 'registry:channel') {
    const id = d.kind === 'thread' ? (d.refs.map(channelIdOf).find((x) => !!x) ?? null) : null;
    const listed = !!id && reg.data.initiatives.some((i) => reg.channels(i).some((c) => c.id === id));
    return `channel:${listed ? id : normChannel(d.container ?? '')}`;
  }
  if (ruleId === 'registry:key') {
    const k = d.projectKeys.find((p) => reg.data.initiatives.some((i) => reg.keysOf(i).includes(p)));
    return `key:${k ?? d.projectKeys[0] ?? ''}`;
  }
  if (ruleId === 'registry:title') {
    const head = d.title.split(' — ')[0] ?? '';
    const hit = reg.data.initiatives.flatMap((i) => strs(i.sources.calendar_title_patterns)).find((p) => titleMatcher(p)(head));
    return `title:${hit ?? head}`;
  }
  return `rule:${ruleId}`;
}

// --- keys (the bench's K, src/lab/variants/keys/extract.ts — same shapes, so its priors and results carry over) ----

/** A key id is "<type>=<value>"; the value may hold anything, the type never holds '='. */
export const keyId = (type: string, value: string): string => `${type}=${value}`;
export const typeOf = (key: string): string => key.slice(0, key.indexOf('='));
export const valueOf = (key: string): string => key.slice(key.indexOf('=') + 1);

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
const fold = (s: string): string => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const PLACEHOLDER = /^<[a-z]+>$/;

/** The words of a title/subject that may be topic tokens: ≥ 4 letters, not a function word, not a person's name. */
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

/** Folded name tokens of the roster (ids, names, name-like identities), for `topicTokens`. */
export function nameVocab(people: readonly { person_id: string; name?: string; identities?: readonly string[] }[]): Vocab {
  const names = new Set<string>();
  for (const p of people) {
    for (const t of p.person_id.split(/[-_.]/)) if (t) names.add(fold(t));
    for (const s of [p.name ?? '', ...(p.identities ?? [])]) for (const t of foldTokens(s.replace(/^(?:slack|msgraph):/, ''))) names.add(t);
  }
  return { names };
}

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
export function counterpartOf(u: Pick<ItemIn, 'author' | 'participants' | 'fromSubject'>): { address: string | null; domain: string | null } {
  const author = parseSender(u.author ?? '');
  const pick = u.fromSubject ? u.participants.map((p) => parseSender(p)).find((p) => p.email && p.email !== author.email) : author;
  if (!pick?.email) return { address: null, domain: null };
  return { address: pick.email, domain: pick.domain || null };
}

const registrable = (host: string): string => {
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const sld = parts[parts.length - 2]!;
  const tld = parts[parts.length - 1]!;
  return tld.length === 2 && /^(?:co|com|org|net|gov|ac|edu)$/.test(sld) ? parts.slice(-3).join('.') : parts.slice(-2).join('.');
};
const under = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

// Deploy notices name the app: "Deploying shop-api@3f2a9c1 to production", "deploy finished: shop-api (production)".
const DEPLOY_APP_G = /\b([a-z][\w.-]{1,40})@(?=[0-9a-f]{0,39}\d)[0-9a-f]{6,40}\b(?![.@])|\bdeploy(?:ment)?\s+(?:finished|failed|started|succeeded)\s*:\s*([a-z][\w.-]{1,40})/gi;
// A bracketed head that is a state or a tool, not an app: "[WARNING] …", "[RESOLVED] …", "[YouTrack] …".
const NOT_APP = new Set([
  ...['firing', 'resolved', 'warning', 'warn', 'critical', 'crit', 'error', 'alert', 'alarm', 'ok', 'info', 'notice', 'recovered', 'triggered', 'down', 'up', 'test'],
  ...[...BOT_NAMES].map((n) => n.replace(/\s+/g, '')),
]);

/** K's app tokens: a code host's "[org/repo] …", a deploy notice's app, a bracketed head that is not a state or a tool. */
export function appsOf(u: { text?: string | null; subject?: string | null }): string[] {
  const out = new Set<string>();
  for (const s of [u.subject ?? '', u.text ?? '']) {
    const m = /^\s*\[(?:[\w.-]+\/)?([\w.-]{2,40})\]/.exec(s);
    if (m && !NOT_APP.has(m[1]!.toLowerCase().replace(/[\s._-]+/g, ''))) out.add(m[1]!.toLowerCase());
    for (const d of s.matchAll(DEPLOY_APP_G)) out.add((d[1] ?? d[2])!.toLowerCase());
  }
  return [...out].sort();
}

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');
const push = (out: string[], type: string, value: string | null | undefined): void => {
  if (value) out.push(keyId(type, value));
};

/** t1-fragment: series (calls), run (threads), cpset (calls/threads), cowork (calls/threads), token (titles). */
export function fragmentKeys(d: Pick<FragmentDraft, 'kind' | 'title' | 'container' | 'participants'>, cowork: readonly string[], subject: string | null, vocab: Vocab): string[] {
  const out: string[] = [];
  if (d.kind === 'call') push(out, 'series', seriesOf(d.title));
  if (d.kind === 'thread') push(out, 'run', d.container ? norm(d.container) : null);
  if (d.kind !== 'work') {
    push(out, 'cpset', uniq(d.participants.filter((p) => p && p !== subject)).sort().join(','));
    for (const l of uniq(cowork).sort()) push(out, 'cowork', l);
  }
  for (const t of topicTokens(d.title, vocab)) push(out, 'token', t);
  return out;
}

/**
 * The timelog as a unit signal (`cowork`): labels of work blocks the floor decided at ≥ .97 within ±45 min of a call or
 * a run. Weak on the bench (parallel work is the norm: 4/13 at initiative level on the owner's data) — its type starts at
 * .50 and must earn the right to decide like any other.
 */
export function coworkOf(d: Pick<FragmentDraft, 'kind' | 'start' | 'end'>, decidedWork: readonly { start: string; end: string; label: string }[], slackMin = 45): string[] {
  if (d.kind === 'work') return [];
  const s = Date.parse(d.start);
  const e = Date.parse(d.end);
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

/** t1-item: thread, family/host/app (integrations), subject/domain (mail), container/sender (people), token (subjects). */
export function itemKeys(u: ItemIn, floor: { senderClass: SenderClass; family: string }, vocab: Vocab): string[] {
  const out: string[] = [];
  const mail = isMailItem(u.source, u.container);
  const cls = floor.senderClass;
  push(out, 'thread', u.thread);
  if (cls === 'bot' || cls === 'bulk') {
    push(out, 'family', floor.family);
    if (cls === 'bot') {
      // The sender's own domain is the tool, not the target (a tracker's notification links to the tracker).
      const own = parseSender(u.author ?? '').domain;
      const ownReg = own ? registrable(own) : '';
      const ha = hostsApps(u);
      for (const h of ha.hosts) if (!ownReg || !under(h, ownReg)) push(out, 'host', h);
      for (const a of uniq([...ha.apps, ...appsOf(u)]).sort()) push(out, 'app', a);
    }
  }
  if (mail) {
    const cp = counterpartOf(u);
    const s = subjectOf(u.subject);
    if (s && cp.domain) push(out, 'subject', `${s}|${isFreeMail(cp.domain) ? cp.address : cp.domain}`);
    if (cp.domain && !isFreeMail(cp.domain)) push(out, 'domain', cp.domain);
  }
  if (cls === 'human') {
    if (!mail) push(out, 'container', channelIdOf(u.ref) ?? (u.container ? norm(u.container) : null));
    push(out, 'sender', u.authorPerson || (u.author ? senderKey(u.author) : null));
  }
  for (const t of topicTokens(u.subject, vocab)) push(out, 'token', t);
  return out;
}

// Which candidate keys may predict and group: a series seen on ≥ 2 calls, a token carried by ≤ 5% of the units. The
// bench counted the stream so far; a build re-derives over its whole window, which is the same thing on its last day.
export const TOKEN_MAX_DF = 0.05;
export const SERIES_MIN_CALLS = 2;

/** The candidate keys of a pool of units → the active ones per unit, in the units' order. */
export function activeKeys(pool: readonly { keys: readonly string[]; caseKey: string }[]): string[][] {
  const df = new Map<string, number>();
  const series = new Map<string, Set<string>>();
  for (const u of pool) {
    for (const k of uniq(u.keys)) {
      const t = typeOf(k);
      if (t === 'token') df.set(k, (df.get(k) ?? 0) + 1);
      else if (t === 'series') series.set(k, (series.get(k) ?? new Set<string>()).add(u.caseKey));
    }
  }
  const max = TOKEN_MAX_DF * Math.max(1, pool.length);
  return pool.map((u) =>
    uniq(u.keys).filter((k) => {
      const t = typeOf(k);
      if (t === 'series') return (series.get(k)?.size ?? 0) >= SERIES_MIN_CALLS;
      if (t === 'token') return (df.get(k) ?? 0) <= max;
      return true;
    }),
  );
}

/**
 * Key ids → the unit's `keys` record as the learner reads it (learn.ts LearnUnit): type → value, a second value of one
 * type under `type#2`, a third under `type#3` … (tokens, hosts, apps, cowork labels) — the type is the name up to '#'.
 */
export function keyRecord(ids: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const seen = new Map<string, number>();
  for (const k of ids) {
    const t = typeOf(k);
    const n = (seen.get(t) ?? 0) + 1;
    seen.set(t, n);
    out[n === 1 ? t : `${t}#${n}`] = valueOf(k);
  }
  return out;
}

/**
 * What a rule rung rests on beyond its name (learn.ts LearnUnit.trigger): its container and project key — a route
 * cannot corroborate itself, so the learner never counts these as content cues of the rule's initiative.
 */
export function ruleTrigger(rung: string, rules: readonly RuleRecord[]): string[] {
  if (!rung.startsWith('rule:')) return [];
  const w = rules.find((r) => r.id === rung.slice('rule:'.length))?.when;
  if (!w) return [];
  return [...(w.container ? [`channel:${w.container}`] : []), ...(w.project_key ? [`key:${w.project_key}`] : []), ...(w.repo ? [`repo:${w.repo}`] : [])];
}

// --- units ------------------------------------------------------------------------------------------------------

/** The summary section of topic #n (1-based), as topics() numbers them — a topic fragment's own text. */
export function topicSection(summary: string, n: number): string {
  const sections: { heading: string; lines: string[]; length: number }[] = [];
  for (const line of (summary ?? '').split('\n')) {
    const m = line.match(/^#{1,2}\s+(.+?)\s*#*\s*$/);
    if (m) sections.push({ heading: m[1]!.replace(/\*+/g, '').trim(), lines: [line], length: 0 });
    else if (sections.length) {
      const cur = sections[sections.length - 1]!;
      cur.lines.push(line);
      cur.length += line.trim().length;
    }
  }
  const want = topics(summary);
  let j = 0;
  for (const s of sections) {
    if (j >= want.length) break;
    if (s.length > 0 && s.heading === want[j]!.heading && ++j === n) return s.lines.join('\n').trim();
  }
  return summary ?? '';
}

// A work block that decides a cowork key: the floor decided it this sure (repo .99; a ticket key or a rule .97).
const COWORK_MIN_CONF = 0.97;

/**
 * The horizon's fragments as learner units: the ladder ALONE over the build's drafts (no ledger, no pins — what the rules
 * decide today: the calibration measures today's rules against every answer), plus case keys, texts, minutes and keys.
 */
export function fragmentUnits(db: DatabaseSync, loaded: Pick<AttributionDrafts, 'drafts' | 'meetings' | 'ctx'>, subject: string | null, vocab: Vocab, tz: string): LearnUnit[] {
  const reg = loaded.ctx.reg;
  const calls = new Map<string, { callId?: string; summary: string }>();
  for (const m of loaded.meetings) for (const r of [`meeting:${m.source}:${m.id}`, ...(m.twins ?? [])]) calls.set(r, { ...(m.callId ? { callId: m.callId } : {}), summary: m.summary });
  const msg = db.prepare('SELECT author_raw, ts, subject, text FROM messages WHERE ref = ?');
  const act = db.prepare('SELECT title, items_text FROM activity WHERE source = ? AND id = ? AND deleted = 0');
  const textOf = (d: FragmentDraft): string => {
    if (d.kind === 'call') {
      const n = /#(\d+)$/.exec(d.id);
      const summary = calls.get(d.refs[0] ?? '')?.summary ?? '';
      return `${d.title}\n${n ? topicSection(summary, Number(n[1])) : summary}`.trim();
    }
    if (d.kind === 'work') {
      const m = /^activity:([^:]+):(.+)$/.exec(d.refs[0] ?? '');
      const r = m ? (act.get(m[1]!, m[2]!) as Row | undefined) : undefined;
      return `${d.title}\n${str(r?.items_text)}`.trim();
    }
    // A run is the subject's own messages; a call's attached greeting refs are not part of its text.
    const lines = d.refs
      .map((ref) => msg.get(ref) as Row | undefined)
      .filter((r): r is Row => !!r)
      .sort((a, b) => str(a.ts).localeCompare(str(b.ts)))
      .map((r) => `${str(r.author_raw)}: ${str(r.subject) ? `${str(r.subject)} — ` : ''}${str(r.text)}`);
    return [d.title, ...lines].join('\n');
  };
  const said = loaded.drafts.map((d) => {
    const r = attribute(d, loaded.ctx);
    const label = r.decided ? labelOf(r.decided.attributions, reg) : null;
    return { d, r, label, conf: label && r.decided ? (r.decided.conf ?? 0.5) : 0, rung: label && r.decided ? fragmentRung(r.decided.rule_id, d, reg) : 'abstain' };
  });
  const work = said.filter((x) => x.d.kind === 'work' && x.label && x.conf >= COWORK_MIN_CONF).map((x) => ({ start: x.d.start, end: x.d.end, label: x.label! }));
  const base = said.map(({ d, r, label, conf, rung }) => {
    const day = localDay(d.start, tz);
    // A call's case is the store's call cluster (calls.ts ids read `call:<ref>`), as the item floor keys a recording.
    const callId = calls.get(d.refs[0] ?? '')?.callId ?? d.id.replace(/#\d+$/, '');
    const caseKey = d.kind === 'call' ? (callId.startsWith('call:') ? callId : `call:${callId}`) : d.kind === 'thread' ? `run:${d.container ?? ''}:${day}` : `work:${d.container ?? d.repo ?? ''}:${day}`;
    const wall = Math.max(0, Date.parse(d.end) - Date.parse(d.start)) / 60_000;
    return {
      id: d.id,
      unit: 'fragment' as const,
      day,
      label,
      conf,
      rung,
      structural: !!label && isStructural(rung),
      candidates: uniq(r.candidates.flatMap((c) => labelsOf(c, reg))),
      caseKey,
      minutes: Math.round((Number.isFinite(wall) ? wall : 0) * d.weight * 10) / 10,
      keys: fragmentKeys(d, coworkOf(d, work), subject, vocab),
      text: clip(textOf(d), TEXT_FRAGMENT),
      trigger: ruleTrigger(rung, loaded.ctx.rules),
    };
  });
  const active = activeKeys(base);
  return base.map(({ trigger, ...u }, i) => ({ ...u, keys: keyRecord(active[i]!), ...(trigger.length ? { trigger } : {}) }));
}

/**
 * The item window's units: the floor's decision as att_items holds it (initiative, conf, rung instance, case key), the
 * item's facts re-read with the floor's own loader (items-load.ts) for its keys and text. [] when item mode is off.
 */
export function itemUnits(db: DatabaseSync, inputs: AttributionInputs, vocab: Vocab, now: Date): LearnUnit[] {
  const w = itemWindow(inputs, now);
  if (!w) return [];
  const rows = db.prepare('SELECT ref, day, sender_class, family, initiative, conf, rung, candidates, case_key FROM att_items ORDER BY ts, ref').all() as Row[];
  if (!rows.length) return [];
  const load = loadItems(db, { since: w.since, until: w.until, tz: inputs.timezone }, inputs.config.subject || null);
  const byRef = new Map(load.items.map((u) => [u.ref, u]));
  const base = rows.flatMap((r) => {
    const u = byRef.get(str(r.ref));
    if (!u) return [];
    const label = r.initiative == null ? null : str(r.initiative);
    const rung = str(r.rung) || 'abstain';
    return [
      {
        id: u.ref,
        unit: 'item' as const,
        day: str(r.day),
        label,
        conf: label ? Number(r.conf) || 0 : 0,
        rung,
        structural: !!label && isStructural(rung),
        candidates: json<string[]>(r.candidates, []),
        caseKey: str(r.case_key),
        keys: itemKeys(u, { senderClass: str(r.sender_class) as SenderClass, family: str(r.family) }, vocab),
        text: clip(`${u.subject ? `${u.subject}\n` : ''}${u.text}`, TEXT_ITEM),
        trigger: ruleTrigger(rung, inputs.rules),
      },
    ];
  });
  const active = activeKeys(base);
  return base.map(({ trigger, ...u }, i) => ({ ...u, keys: keyRecord(active[i]!), ...(trigger.length ? { trigger } : {}) }));
}

// --- evidence ---------------------------------------------------------------------------------------------------

/** One line of annotations/labels.jsonl: a person's answer about one item (or, later, another task's unit). */
export interface LabelLine {
  ref: string;
  task: string; // 't1-item' — the only task the loop reads so far
  label: string;
  by: string; // 'human:<id>' | 'owen' — anything else is recorded but never evidence
  answer?: string;
  audit?: boolean;
  guess?: string | null;
  conf?: number;
  rung?: string;
  at: string;
}

/** labels.jsonl → the live lines: the last line per (task, ref) wins, `status: "superseded"` withdraws it; junk is counted. */
export function parseLabels(text: string): { labels: LabelLine[]; malformed: number } {
  const byKey = new Map<string, LabelLine>();
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r: Row;
    try {
      r = JSON.parse(line) as Row;
    } catch {
      malformed++;
      continue;
    }
    const ok = !!r && typeof r === 'object' && !Array.isArray(r) && typeof r.ref === 'string' && !!r.ref && typeof r.at === 'string' && !!r.at;
    const task = ok && typeof r.task === 'string' && r.task ? r.task : 't1-item';
    if (!ok) {
      malformed++;
      continue;
    }
    const key = `${task}\0${r.ref}`;
    if (r.status === 'superseded') {
      byKey.delete(key);
      continue;
    }
    if (typeof r.label !== 'string' || !r.label || typeof r.by !== 'string' || !r.by) {
      malformed++; // junk never withdraws the line before it
      continue;
    }
    byKey.delete(key); // keep insertion order = order of the latest version
    byKey.set(key, {
      ref: r.ref as string,
      task,
      label: r.label,
      by: r.by,
      at: r.at as string,
      ...(typeof r.answer === 'string' && r.answer ? { answer: r.answer } : {}),
      ...(r.audit === true ? { audit: true } : {}),
      ...(typeof r.guess === 'string' || r.guess === null ? { guess: r.guess as string | null } : {}),
      ...(typeof r.conf === 'number' && Number.isFinite(r.conf) ? { conf: r.conf } : {}),
      ...(typeof r.rung === 'string' && r.rung ? { rung: r.rung } : {}),
    });
  }
  return { labels: [...byKey.values()], malformed };
}

const dayOrElse = (iso: string | undefined, tz: string, fallback: string): string => (iso && Number.isFinite(Date.parse(iso)) ? localDay(iso, tz) : fallback);

/**
 * Fragments' evidence: the ledger lines a person decided (status decided), on the unit each covers — by its own id or,
 * for a message run, by overlapping refs (att_fragments.ledger_id says which). The answer id is the line's `answer`;
 * without one, a call's topic lines decided together are ONE answer (the id without `#n` + decided_at: one override
 * of a call is one observation, not one per topic), any other line its own.
 */
export function fragmentEvidence(cover: readonly { id: string; ledger_id: string; day: string }[], ledger: readonly Fragment[], reg: Registry, tz: string): { evidence: Evidence[]; outside: number } {
  const human = new Map(ledger.filter((f) => f.status === 'decided' && isHumanLine(f)).map((f) => [f.id, f]));
  const used = new Set<string>();
  const evidence: Evidence[] = [];
  for (const c of cover) {
    const f = human.get(c.ledger_id);
    const label = f ? labelOf(f.attributions, reg) : null;
    if (!f || !label) continue;
    used.add(f.id);
    evidence.push({
      id: c.id,
      day: dayOrElse(f.decided_at, tz, c.day),
      label,
      source: 'human',
      answer: f.answer ?? `${f.id.replace(/#\d+$/, '')}@${f.decided_at ?? ''}`,
      ...(f.audit ? { audit: true } : {}),
      ...(f.guess !== undefined ? { guess: f.guess } : {}),
    });
  }
  return { evidence, outside: [...human.keys()].filter((id) => !used.has(id)).length };
}

/** Items' evidence: a person's t1-item lines (labels.jsonl) on units of the item window; labels alias-resolved. */
export function itemEvidence(labels: readonly LabelLine[], units: ReadonlyMap<string, { day: string }>, reg: Registry, tz: string): { evidence: Evidence[]; outside: number } {
  const evidence: Evidence[] = [];
  let outside = 0;
  for (const l of labels) {
    if (l.task !== 't1-item' || !isHumanDecider(l.by)) continue;
    const u = units.get(l.ref);
    if (!u) {
      outside++;
      continue;
    }
    evidence.push({
      id: l.ref,
      day: dayOrElse(l.at, tz, u.day),
      label: labelsOf(l.label, reg)[0] ?? l.label,
      source: 'human',
      answer: l.answer ?? `${l.ref}@${l.at}`,
      ...(l.audit ? { audit: true } : {}),
      ...(l.guess !== undefined ? { guess: l.guess } : {}),
    });
  }
  return { evidence, outside };
}

// --- initiatives --------------------------------------------------------------------------------------------------

// Statuses that end an initiative's life: it is no sibling anymore (a done relaunch does not split a client's traffic).
const ENDED = new Set(['done', 'dormant', 'archived', 'closed', 'inactive', 'cancelled', 'canceled', 'paused', 'alias']);
// Words of a name as written: the learner folds a cue itself (a person-name fold would bend "Aerospace" to "arospace").
const nameTokens = (s: string): string[] => s.split(/[^\p{L}\p{N}]+/u).filter((t) => letters(t) >= 3 && !STOP.has(t.toLowerCase()));

/**
 * The registry as the sibling-aware learner reads it (notes 20, K2a): one entry per label id (a plain alias folds into
 * its target, cues included), with
 *   umbrella  the initiative's umbrella (else its id's first segment); company when the registry names one
 *   active    still running: not done, dormant, archived … — an ended initiative is no sibling (a done relaunch does
 *             not split a client's traffic)
 *   admin     the umbrella's admin bucket (attribution.json `admin`): neither has nor is a sibling (`personal` the
 *             learner recognises itself)
 *   cues      typed where the type matters, so the learner matches each its own way (learn-trust.ts parseCue): name
 *             tokens as words, `title:<pattern>`, `#<channel>` and channel ids, `key:<PREFIX>` (matches `VN-12`, never
 *             the bare letters), `repo:`/`path:` (their basename), `host:`, `app:`. The id's last segment split on '-'
 *             (K2a's last cue) the learner adds itself.
 */
export function initiativesOf(data: RegistryData, admin: Readonly<Record<string, string>> = {}): InitiativeInfo[] {
  const reg = new Registry(data);
  const buckets = new Set(Object.values(admin).map((b) => reg.resolveAlias(b)));
  const cues = new Map<string, Map<string, string>>(); // id → lower-cased cue → the cue as written (first spelling wins)
  const add = (id: string, xs: readonly string[]) => {
    const m = cues.get(id) ?? new Map<string, string>();
    for (const x of xs) {
      const c = x.normalize('NFC').trim();
      if (c.length >= 2 && !/^\d+$/.test(c) && !m.has(c.toLowerCase())) m.set(c.toLowerCase(), c);
    }
    cues.set(id, m);
  };
  for (const i of data.initiatives) {
    const s = i.sources;
    add(i.alias_of && !i.split_into ? reg.resolveAlias(i.id) : i.id, [
      ...(typeof i.name === 'string' ? nameTokens(i.name) : []),
      ...strs(s.calendar_title_patterns).map((p) => `title:${p}`),
      ...reg.channels(i).flatMap((c) => [c.name ? `#${c.name}` : '', c.id ?? '']),
      // Tracker key prefixes are ROUTES, not content cues: registries share them across sibling initiatives (one
      // project for a client's shop and its ERP sync), so a `VN-24` in the text would only repeat the registry's guess.
      ...strs(s.repos).map((r) => `repo:${r}`),
      ...strs(s.local_paths).map((p) => `path:${p}`),
      ...strs(s.hosts).map((h) => `host:${h}`),
      ...strs(s.apps).map((a) => `app:${a}`),
    ]);
  }
  return data.initiatives
    .filter((i) => !(i.alias_of && !i.split_into))
    .map((i) => {
      const umbrella = typeof i.umbrella === 'string' && i.umbrella ? i.umbrella : i.id.split('/')[0]!;
      const status = typeof i.status === 'string' ? i.status.toLowerCase() : '';
      return {
        id: i.id,
        umbrella,
        ...(typeof i.company === 'string' && i.company ? { company: i.company } : {}),
        active: !ENDED.has(status),
        cues: [...(cues.get(i.id)?.values() ?? [])],
        ...(buckets.has(i.id) ? { admin: true } : {}),
      };
    });
}

// --- the build's side -----------------------------------------------------------------------------------------------

export type Learner = (units: LearnUnit[], evidence: Evidence[], opts: LearnOpts) => LearnResult;

/** Everything the learner reads for one build — read-only; recomputeLearn adds the run and the writes. */
export interface LearnInputs {
  units: LearnUnit[];
  evidence: Evidence[];
  opts: LearnOpts;
  /** A person's ledger/label lines whose unit is outside the horizon or the item window (counted, not used). */
  outside: number;
  /** labels.jsonl lines that could not be read. */
  malformed: number;
}

export function loadLearnInputs(db: DatabaseSync, inputs: AttributionInputs, people: readonly Person[], ledger: readonly Fragment[], now: Date = new Date(), drafts?: AttributionDrafts): LearnInputs {
  const cfg = inputs.config.learn ?? { mode: 'shadow' as const, questionsPerDay: 3, auditShare: 0.15, siblingAware: true };
  const tz = inputs.timezone;
  const loaded = drafts ?? loadAttributionDrafts(db, inputs, people, now);
  const vocab = nameVocab(people);
  const units = [...fragmentUnits(db, loaded, inputs.config.subject || null, vocab, tz), ...itemUnits(db, inputs, vocab, now)];
  const byId = new Map(units.map((u) => [u.id, u]));
  const reg = loaded.ctx.reg;
  // A ledger line reaches its unit through the plan (att_fragments.ledger_id): by id, or a run by overlapping refs.
  const cover = (db.prepare('SELECT id, ledger_id FROM att_fragments WHERE ledger_id IS NOT NULL ORDER BY start, id').all() as Row[])
    .filter((r) => byId.has(str(r.id)))
    .map((r) => ({ id: str(r.id), ledger_id: str(r.ledger_id), day: byId.get(str(r.id))!.day }));
  const frag = fragmentEvidence(cover, ledger, reg, tz);
  const { labels, malformed } = parseLabels(inputs.labelsText ?? '');
  const items = itemEvidence(labels, new Map(units.filter((u) => u.unit === 'item').map((u) => [u.id, u])), reg, tz);
  const today = localDay(now.toISOString(), tz);
  return {
    units,
    evidence: [...frag.evidence, ...items.evidence],
    opts: {
      tau: TAU,
      today,
      questionsPerDay: cfg.questionsPerDay,
      auditShare: cfg.auditShare,
      // The learner draws the day's audit sample by a hash of (seed, today, unit): every build of a day draws the same.
      seed: `att:${inputs.config.subject}`,
      initiatives: initiativesOf(inputs.registry, inputs.config.admin),
      siblingAware: cfg.siblingAware,
    },
    outside: frag.outside + items.outside,
    malformed,
  };
}

/** What the build reports (the daemon logs it) and the readout's counts. */
export interface LearnSummary {
  mode: 'shadow';
  today: string;
  units: { fragment: number; item: number };
  /**
   * The floor alone at τ; the loop at τ; units the loop would decide that the floor does not (`promoted`: an earned
   * key), units the floor decides that the loop would ask instead (`held`: a demoted rung instance, a sibling doubt),
   * units both decide differently (`relabelled`: a sibling's cue).
   */
  floor_decided: number;
  would_decide: number;
  promoted: number;
  held: number;
  relabelled: number;
  /** Rows handed to the learner, distinct answers, audits; a person's lines outside the window; unreadable label lines. */
  evidence: { units: number; answers: number; audits: number; outside: number; malformed: number };
  /**
   * On units a person answered: how many the floor / the loop would decide and how many of those carry the answer —
   * the loop's side as it stood BEFORE that answer (learn.ts replays the evidence in day order), the honest check.
   */
  agreement: { answered: number; floor: { decided: number; agree: number }; loop: { decided: number; agree: number } };
  /** Trials the key types ran (a consistent key predicted a unit a person then labelled), when the learner reports them. */
  trials?: { success: number; failure: number };
  asked: number;
  questions: number;
  audits: number;
  calibration: { instances: number; demoted: number };
  key_types: { deciding: number };
  rule_candidates: number;
}

/** The meta the readout shows next to the per-unit rows: the learner's tables, capped so a big tenant stays readable. */
const META_LIST_MAX = 100;

/** Compute, run and store the loop for one build (shadow). The one call the build makes when `learn` is on. */
export function recomputeLearn(db: DatabaseSync, inputs: AttributionInputs, people: readonly Person[], ledger: readonly Fragment[], now: Date = new Date(), o: { drafts?: AttributionDrafts; learner?: Learner } = {}): LearnSummary {
  const li = loadLearnInputs(db, inputs, people, ledger, now, o.drafts);
  const result = (o.learner ?? learn)(li.units, li.evidence, li.opts);
  return writeLearn(db, li, result, now);
}

/** Replace att_learn and the `att:learn` meta (one transaction) with one run's result; returns the summary. */
export function writeLearn(db: DatabaseSync, li: LearnInputs, result: LearnResult, now: Date = new Date()): LearnSummary {
  const tau = li.opts.tau;
  const unitById = new Map(li.units.map((u) => [u.id, u]));
  const audits = new Set(result.audits);
  let floorDecided = 0;
  let would = 0;
  let promoted = 0;
  let held = 0;
  let relabelled = 0;
  let asked = 0;
  const agreement = { answered: 0, floor: { decided: 0, agree: 0 }, loop: { decided: 0, agree: 0 } };
  for (const u of li.units) if (u.label !== null && u.conf >= tau) floorDecided++;
  for (const l of result.units) {
    const u = unitById.get(l.id);
    if (!u) continue;
    const fl = u.label !== null && u.conf >= tau;
    const lp = l.label !== null && l.conf >= tau;
    if (lp) would++;
    if (lp && !fl) promoted++;
    if (fl && !lp) held++;
    if (fl && lp && l.label !== u.label) relabelled++;
    if (l.ask) asked++;
    const answer = l.answered;
    if (answer !== undefined) {
      agreement.answered++;
      if (fl) {
        agreement.floor.decided++;
        if (u.label === answer) agreement.floor.agree++;
      }
      if (lp) {
        agreement.loop.decided++;
        if (l.label === answer) agreement.loop.agree++;
      }
    }
  }
  const summary: LearnSummary = {
    mode: 'shadow',
    today: li.opts.today,
    units: { fragment: li.units.filter((u) => u.unit === 'fragment').length, item: li.units.filter((u) => u.unit === 'item').length },
    floor_decided: floorDecided,
    would_decide: would,
    promoted,
    held,
    relabelled,
    evidence: { units: li.evidence.length, answers: new Set(li.evidence.map((e) => e.answer)).size, audits: li.evidence.filter((e) => e.audit).length, outside: li.outside, malformed: li.malformed },
    agreement,
    ...(result.stats ? { trials: { ...result.stats.trials } } : {}),
    asked,
    questions: result.questions.length,
    audits: audits.size,
    calibration: { instances: result.calibration.length, demoted: result.calibration.filter((c) => c.demoted).length },
    key_types: { deciding: result.keyTypes.filter((k) => k.deciding).length },
    rule_candidates: result.ruleCandidates.length,
  };
  const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
  const meta = {
    ...summary,
    computed_at: now.toISOString(),
    tau,
    questions_per_day: li.opts.questionsPerDay,
    audit_share: li.opts.auditShare,
    sibling_aware: li.opts.siblingAware,
    calibration_table: result.calibration.map((c) => ({ ...c, a: r4(c.a), b: r4(c.b), mean: r4(c.mean), ...(c.clientMean !== undefined ? { clientMean: r4(c.clientMean) } : {}) })),
    key_types_table: result.keyTypes.map((k) => ({ ...k, mean: r4(k.mean) })),
    questions_ranked: result.questions.slice(0, META_LIST_MAX).map((q) => ({ ...q, value: r4(q.value), units: q.units.slice(0, 12) })),
    audit_sample: result.audits.slice(0, META_LIST_MAX),
    rule_candidates_list: result.ruleCandidates.slice(0, META_LIST_MAX),
  };
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM att_learn');
    const ins = db.prepare('INSERT OR REPLACE INTO att_learn(id, unit, day, label, conf, rung, ask, audit) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const l of result.units) {
      const u = unitById.get(l.id);
      if (!u) continue;
      ins.run(l.id, u.unit, u.day, l.label, r4(l.label === null ? 0 : l.conf), l.rung, l.ask ? JSON.stringify({ ...l.ask, value: r4(l.ask.value) }) : null, l.audit || audits.has(l.id) ? 1 : 0);
    }
    db.prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES (?, ?)').run('att:learn', JSON.stringify(meta));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return summary;
}

/** The loop switched off (no `learn` key, or the layer itself off): no rows, no meta — the readout then says so. */
export function clearLearn(db: DatabaseSync): void {
  if (!db.prepare('SELECT 1 FROM att_learn LIMIT 1').get() && !db.prepare("SELECT 1 FROM sync_state WHERE key = 'att:learn'").get()) return;
  db.exec('BEGIN');
  try {
    db.exec("DELETE FROM att_learn; DELETE FROM sync_state WHERE key = 'att:learn';");
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
