// Plan the bench-agency month: storylines (lab spec 05 §2.4) + background traffic + noise (§2.5) → PlannedItem[]
// with exact truth (§2.8), plus the GIVEN tenant (§2.7) and the truth files. Nothing here calls a model: human
// items carry a Beat and `text: null` until the renderer fills them; machine items (bots, newsletters,
// notifications, digests, activity) get their final text from templates now; duplicates, forwards, cross-posts and
// recorder copies are DERIVED from another item's final text by a deterministic op (applyDerive / formatCopy).
//
// Determinism: one mulberry32 stream (metrics.ts rng) drives every choice in a fixed order, ids are counters or
// hashes of plan data, the world is cloned per build (forms registered during planning never leak between runs),
// and no clock is read — the same seed writes byte-identical files (plan.test.ts).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fnv1a, rng } from '../metrics.js';
import type { Kind } from '../types.js';
import { extractNextSteps, flatten } from '../../sources/meetings/normalise.js';
import { blockId, shortContainer } from '../../sources/local/normalise.js';
import { categoryFromName } from '../../sources/trackers/task.js';
import { ACCOUNTS, ADMIN_OF, ASSET, BOT, buildWorld, FORM_WEIGHT, GIVEN_SOURCES, REBRAND_DAY, RENAME_AT, RENAME_DAY, SINCE, SUBJECT, TICKET_TITLES, TOPICS, TZ, UNTIL } from './world.js';
import type {
  Addressee, Beat, CallContent, Channel, CommitmentTruth, DecidableBy, DedupRow, DedupType, DeriveOp, Fill, FormKind, GivenTenant, IdentityOcc, IdentityRow, ItemTruth, Lang, NoiseTag, NoiseType,
  PatternRow, Person, Plan, PlannedItem, RawLine, RosterEntry, Share, Source, SurfaceForm, Truth, TruthItemRow, TruthKind, World,
} from './types.js';

// --- time ---------------------------------------------------------------------------------------------

const MIN = 60_000;
const offsets = new Map<string, number>();
/** Minutes the tenant zone is ahead of UTC on a day (CEST = 120 for the whole window, but never assumed). */
function offsetMin(day: string): number {
  const hit = offsets.get(day);
  if (hit !== undefined) return hit;
  const t = Date.parse(`${day}T12:00:00Z`);
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(t));
  const g = (k: string) => Number(p.find((x) => x.type === k)!.value);
  const off = (Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute')) - t) / MIN;
  offsets.set(day, off);
  return off;
}
const hm = (s: string): number => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
/** Local day + local wall time ('HH:MM' or minutes after midnight) → ISO UTC. */
export function at(day: string, time: string | number): string {
  const m = typeof time === 'number' ? time : hm(time);
  return new Date(Date.parse(`${day}T00:00:00Z`) + (m - offsetMin(day)) * MIN).toISOString();
}
const addMin = (iso: string, m: number): string => new Date(Date.parse(iso) + Math.round(m * MIN)).toISOString();
const DAYF = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
export const localDay = (iso: string): string => DAYF.format(new Date(iso));
export const plusDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dow = (day: string): number => new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
const isWorkday = (day: string): boolean => dow(day) >= 1 && dow(day) <= 5;
/** RFC3339 in the tenant zone, as Google Calendar returns timed events. */
function rfc3339(iso: string): string {
  const day = localDay(iso);
  const off = offsetMin(day);
  const local = new Date(Date.parse(iso) + off * MIN).toISOString().slice(0, 19);
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${local}${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}
const DAYS: string[] = [];
for (let d = SINCE; d <= UNTIL; d = plusDays(d, 1)) DAYS.push(d);
const WORKDAYS = DAYS.filter(isWorkday);
/** Window week 1..4. */
const week = (day: string): number => Math.floor((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${SINCE}T00:00:00Z`)) / (7 * 86_400_000)) + 1;
/** n-th workday of the window (0-based), clamped. */
const wd = (n: number): string => WORKDAYS[Math.max(0, Math.min(WORKDAYS.length - 1, n))]!;
/** Date token as a writer of `lang` would put it (the renderer must reproduce it verbatim). */
export function dateToken(day: string, lang: Lang): string {
  const [, m, d] = day.split('-');
  if (lang === 'en') return `${Number(d)} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]}`;
  return `${d}.${m}.`;
}

// --- deterministic text ops (exported: the renderer / raw writer apply them) ------------------------------

/** Slack's reply-subject truncation (slack/normalise.ts truncate): collapse whitespace, cut at n with an ellipsis. */
function slackTruncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** The text of a derived item (or a slot) from its source's final text. Pure. */
export function applyDerive(src: string, op: DeriveOp = {}): string {
  let t = src;
  if (op.perturb === 'typo') {
    // Swap two inner letters of the longest word: the "before the edit" version of a corrected message.
    const words = t.split(/(\s+)/);
    let best = -1;
    for (let i = 0; i < words.length; i++) if (/^\p{L}{5,}$/u.test(words[i]!) && (best < 0 || words[i]!.length > words[best]!.length)) best = i;
    if (best >= 0) {
      const w = [...words[best]!];
      const k = Math.floor(w.length / 2);
      [w[k - 1], w[k]] = [w[k]!, w[k - 1]!];
      words[best] = w.join('');
    }
    t = words.join('');
  } else if (op.perturb === 'truncate') {
    const cut = t.replace(/\s*[^.!?\n]+[.!?]?\s*$/, '').trim();
    t = cut.length >= 10 ? cut : t;
  }
  if (op.quote) t = t.split('\n').map((l) => `> ${l}`).join('\n');
  if (op.re60) t = `re: ${slackTruncate(t, 60)}`;
  return `${op.prefix ?? ''}${t}${op.suffix ?? ''}`;
}

/** Kind in the bench's t4 vocabulary (types.ts KINDS has no 'answer'). */
export const benchKind = (k: TruthKind): Kind => (k === 'answer' ? 'info' : k);

// --- small utils ----------------------------------------------------------------------------------------

const hex = (s: string, n: number): string => {
  let out = '';
  for (let i = 0; out.length < n; i++) out += fnv1a(`${s}#${i}`).toString(16).padStart(8, '0');
  return out.slice(0, n);
};
const b32 = (s: string, n: number): string => {
  const A = '0123456789abcdefghijklmnopqrstuv';
  let out = '';
  for (let i = 0; out.length < n; i++) {
    let h = fnv1a(`${s}/${i}`);
    for (let j = 0; j < 6 && out.length < n; j++, h = Math.floor(h / 32)) out += A[h % 32];
  }
  return out;
};
const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];
const sorted = (xs: string[]): string[] => [...xs].sort();
/** identityKey + resolveIdentity of src/sources/people.ts, re-stated so the plan knows what resolves today. */
const idKey = (raw: string): string => raw.replace(/^(slack|msgraph):/, '').trim().toLowerCase();
const FORBIDDEN_GLOBAL = ['initiative', 'unregistered', 'synthetic', 'bench', 'truth'];
const LIST_ADDR = 'team@brightwell.example';

// --- internal specs (lines and identities are built in the final pass) --------------------------------------

interface TIn {
  storyline: string;
  label?: string;
  shares?: Share[];
  rung?: DecidableBy; // override of the computed 'which rung should decide'
  kind?: TruthKind | null;
  noiseType?: NoiseType;
  addressee?: Addressee | null;
  expectsReply?: boolean;
  commit?: { owner?: string; to?: string[]; due: string | null; outcome: 'kept' | 'missed' | 'open'; what: string };
  noise?: NoiseTag[];
  cluster?: string;
  dedupType?: DedupType;
  canonical?: boolean;
  family?: string;
  lang?: Lang; // language of a template text written by a person (bumps)
}
interface BeatIn {
  brief: string;
  lang?: Lang;
  words?: [number, number];
  required?: string[];
  smallTalk?: boolean;
}
type Body = { text: string } | { derived: { from: string; op: DeriveOp } } | { beat: BeatIn };

interface SlackSpec {
  ch: Channel;
  tsStr: string;
  author: string;
  authorPid: string; // person id or 'system'
  botFlag: boolean; // raw is_bot
  bot: boolean;
  opaque: boolean;
  mentions: string[]; // person ids
  rootId: string | null;
  replies: string[];
  edit?: { at: string; op: 'typo' | 'truncate' };
  deleteAt?: string;
}
interface MailSpec {
  acct: string;
  msgId: string;
  threadId: string;
  folder: string;
  from: string;
  fromPid: string;
  to: { raw: string; pid: string }[];
  cc: { raw: string; pid: string }[];
  subject: string;
}
interface TaskSpec {
  tracker: 'youtrack' | 'jira';
  taskId: string;
  project: string;
  num: number;
  reporter: { raw: string; pid: string };
  assignee: { raw: string; pid: string } | null;
  statuses: { at: string; status: string }[];
  labels: string[];
  due: string;
  comments: string[];
  renameAt?: string;
}
interface CommentSpec {
  task: string;
  commentId: string;
  author: { raw: string; pid: string };
}
interface EventSpec {
  eventId: string;
  start: string;
  end: string;
  allDay: boolean;
  attendees: { raw: string; pid: string }[];
  organizer: { raw: string; pid: string };
  createdAt: string;
  cancelledAt?: string;
}
interface MeetSpec {
  recorder: 'granola' | 'gmeet' | 'wispr';
  meetingId: string;
  start: string;
  end: string;
  attendees: { email: string; name: string }[];
  occ: IdentityOcc[];
  url: string;
  emitAt: string;
}
interface ActSpec {
  source: 'git' | 'claude';
  container: string;
  start: string;
  end: string;
  minutes: number;
  items: { ts: string; text: string }[];
}

// --- the generator --------------------------------------------------------------------------------------

class Gen {
  readonly r: () => number;
  readonly world: World;
  readonly items: PlannedItem[] = [];
  readonly byId = new Map<string, PlannedItem>();
  readonly people = new Map<string, Person>();
  readonly channels = new Map<string, Channel>();
  readonly givenIndex = new Map<string, string>(); // identityKey → person id (the GIVEN people.json)
  private seq = new Map<string, number>();
  private usedSecs = new Map<string, Set<number>>();
  readonly slack = new Map<string, SlackSpec>();
  readonly mail = new Map<string, MailSpec>();
  readonly task = new Map<string, TaskSpec>();
  readonly comment = new Map<string, CommentSpec>();
  readonly event = new Map<string, EventSpec>();
  readonly meet = new Map<string, MeetSpec>();
  readonly act = new Map<string, ActSpec>();
  readonly occ = new Map<string, IdentityOcc[]>(); // identities fixed at creation (meetings, tasks, events, mail)
  readonly bodies = new Map<string, Body>();
  readonly tins = new Map<string, TIn>();
  readonly keysByProject = new Map<string, string[]>();
  readonly calls: { id: string; copies: string[]; topics: { heading: string; share: number; label: string }[]; storyline: string; start: string; title: string }[] = [];
  readonly patterns: PatternRow[] = [];
  readonly answered = new Map<string, string>(); // question plan id → answer plan id
  readonly commitments: (CommitmentTruth & { ref: string; what: string; item: string })[] = [];
  readonly keptLinks = new Map<string, string>(); // commitment description → plan id of the item that fulfils it
  kept(what: string, id: string | null | undefined): void {
    if (id) this.keptLinks.set(what, id);
  }

  constructor(seed: number) {
    this.r = rng(seed);
    // A fresh world per plan: forms registered while planning (a full name first seen as a Gemini chip) stay local.
    this.world = structuredClone(buildWorld());
    for (const p of this.world.people) this.people.set(p.id, p);
    for (const c of this.world.channels) this.channels.set(c.name, c);
    for (const p of this.world.people) for (const f of p.forms) if (f.given) this.givenIndex.set(idKey(f.form === 'slack_label' ? `slack:${f.raw}` : f.raw), p.id);
  }

  // ── randomness ──
  chance(p: number): boolean {
    return this.r() < p;
  }
  int(a: number, b: number): number {
    return a + Math.floor(this.r() * (b - a + 1));
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.r() * xs.length)]!;
  }
  weighted<T>(pairs: readonly (readonly [T, number])[]): T {
    const total = pairs.reduce((a, p) => a + p[1], 0);
    let x = this.r() * total;
    for (const [v, w] of pairs) {
      x -= w;
      if (x < 0) return v;
    }
    return pairs[pairs.length - 1]![0];
  }
  next(prefix: string): string {
    const n = (this.seq.get(prefix) ?? 0) + 1;
    this.seq.set(prefix, n);
    return `${prefix}-${String(n).padStart(4, '0')}`;
  }
  counter(prefix: string): number {
    const n = (this.seq.get(prefix) ?? 0) + 1;
    this.seq.set(prefix, n);
    return n;
  }

  // ── people and surface forms ──
  person(id: string): Person {
    const p = this.people.get(id);
    if (!p) throw new Error(`unknown person ${id}`);
    return p;
  }
  isPerson(id: string): boolean {
    return this.people.has(id);
  }
  /** What the GIVEN people file resolves a raw string to (store semantics: exact key, then "<addr>"). */
  resolveGiven(raw: string): string | undefined {
    const hit = this.givenIndex.get(idKey(raw));
    if (hit) return hit;
    const m = /<([^<>@\s]+@[^<>\s]+)>/.exec(raw);
    return m?.[1] ? this.givenIndex.get(m[1].toLowerCase()) : undefined;
  }
  /** A form valid for `where` on `day`, weighted; falls back to the address (or the full name), registering it. */
  form(pid: string, where: string, day: string): SurfaceForm {
    const p = this.person(pid);
    const ok = p.forms.filter((f) => f.where?.includes(where) && (!f.from || day >= f.from) && (!f.until || day <= f.until));
    if (ok.length === 1) return ok[0]!;
    if (ok.length > 1) return this.weighted(ok.map((f) => [f, FORM_WEIGHT[`${pid}|${f.raw}|${f.form}`] ?? 1] as const));
    const addr = p.forms.find((f) => (f.form === 'email' || f.form === 'role_mailbox') && f.where?.includes('mail') && (!f.from || day >= f.from) && (!f.until || day <= f.until))
      ?? p.forms.find((f) => (f.form === 'email' || f.form === 'alias_email' || f.form === 'role_mailbox') && (!f.from || day >= f.from) && (!f.until || day <= f.until));
    if (addr && where !== 'gmeet' && where !== 'wispr') return this.register(p, addr.raw, addr.form, where);
    return this.register(p, p.name, 'full_name', where);
  }
  /** Record that `raw` occurs in `where` (adds a roster form when it is new). */
  register(p: Person, raw: string, form: FormKind, where: string): SurfaceForm {
    let f = p.forms.find((x) => x.raw === raw && x.form === form);
    if (!f) {
      const given = this.resolveGiven(form === 'slack_label' ? `slack:${raw}` : raw) === p.id;
      f = { raw, form, given, expected: given ? 'mapped' : !p.given ? 'question' : ['email', 'alias_email', 'full_name', 'umlaut_variant', 'order_swapped', 'slack_label'].includes(form) ? 'merge' : 'question', where: [where] };
      p.forms.push(f);
    } else if (!f.where?.includes(where)) f.where = [...(f.where ?? []), where];
    return f;
  }
  /** The form kind of a raw name in a meeting attendee field: the declared one for that recorder, never a Slack label. */
  meetingFormKind(pid: string, raw: string, where: string): FormKind {
    const p = this.person(pid);
    const known = p.forms.find((x) => x.raw === raw && x.where?.includes(where)) ?? p.forms.find((x) => x.raw === raw && x.form !== 'slack_label' && x.form !== 'opaque_id');
    return known?.form ?? (raw.includes('@') ? 'email' : 'full_name');
  }
  /** One identity occurrence of a person's raw form. Expected is judged against the GIVEN roster as stored. */
  occOf(field: IdentityOcc['field'], pid: string, f: SurfaceForm): IdentityOcc {
    const resolved = this.resolveGiven(f.form === 'slack_label' ? `slack:${f.raw}` : f.raw);
    const expected = resolved === pid ? 'mapped' : resolved ? 'question' : f.expected === 'mapped' ? 'merge' : f.expected;
    return { field, raw: f.raw, truth: pid, form: f.form, expected, ...(f.ambiguous ? { ambiguous: f.ambiguous } : {}) };
  }
  sysOcc(field: IdentityOcc['field'], raw: string): IdentityOcc {
    return { field, raw, truth: 'system', form: 'system', expected: 'drop' };
  }
  addr(pid: string, day: string, where = 'mail'): { raw: string; pid: string; f: SurfaceForm } {
    const f = this.form(pid, where, day);
    return { raw: f.raw, pid, f };
  }
  label(pid: string, day: string): string {
    return this.form(pid, 'slack', day).raw;
  }
  langOf(by: string, pref: Lang | undefined, audience: string[] = []): Lang {
    if (!this.isPerson(by)) return pref ?? 'en';
    const me = this.person(by);
    // Second languages that really occur: the Lakora-born SWL IT lead writes Italian to the PM who reads it, the
    // Valais prospect and the office assistant write French to the CEO.
    const fl = FLAVOUR[by];
    if (fl && audience.some((a) => a !== by && this.isPerson(a) && this.person(a).langs.includes(fl[0])) && this.chance(fl[1])) return fl[0];
    if (pref && me.langs.includes(pref)) return pref;
    const shared = me.langs.filter((l) => audience.every((a) => !this.isPerson(a) || this.person(a).langs.includes(l)));
    return shared[0] ?? me.langs[0]!;
  }

  // ── items ──
  private base(id: string, ref: string, type: PlannedItem['type'], source: Source, account: string, ts: string, t: TIn, extra: Partial<PlannedItem>): PlannedItem {
    const it: PlannedItem = {
      id,
      ref,
      type,
      source,
      account,
      ts,
      day: localDay(ts),
      threadId: ref,
      container: null,
      author: null,
      authorPerson: null,
      keys: [],
      render: { mode: 'template' },
      text: null,
      rendered: false,
      lines: [],
      truth: undefined as unknown as ItemTruth,
      ...extra,
    };
    this.items.push(it);
    this.byId.set(id, it);
    this.tins.set(id, t);
    return it;
  }
  private setBody(it: PlannedItem, body: Body, beatCtx: { lang: Lang; pos?: { index: number; of: number }; context: string[]; required: string[]; mail?: Beat['mail']; persona?: string; words?: [number, number] }): void {
    this.bodies.set(it.id, body);
    if ('text' in body) {
      it.render = { mode: 'template' };
      it.text = body.text;
      it.rendered = true;
    } else if ('derived' in body) {
      it.render = { mode: 'derived', from: body.derived.from, op: body.derived.op };
      const src = this.byId.get(body.derived.from);
      if (src?.rendered && src.text !== null) {
        it.text = applyDerive(src.text, body.derived.op);
        it.rendered = true;
      }
    } else {
      const b = body.beat;
      const persona = beatCtx.persona ?? (it.authorPerson ?? 'system');
      const p = this.isPerson(persona) ? this.person(persona) : undefined;
      const lang = b.lang ?? beatCtx.lang;
      const required = uniq([...it.keys, ...beatCtx.required, ...(b.required ?? [])]);
      const otherKeys = uniq(it.keys.flatMap((k) => this.keysByProject.get(k.split('-')[0]!) ?? [])).filter((k) => !required.includes(k)).slice(0, 12);
      const beat: Beat = {
        brief: b.brief,
        persona,
        lang,
        ...(lang === 'ru' && p && this.chance(p.persona.translit ?? 0) ? { translit: true } : {}),
        ...(p && this.chance(0.1) ? (() => { const m = p.langs.find((l) => l !== lang && (l === 'en' || l === 'de' || l === 'it')); return m ? { mix: m } : {}; })() : {}),
        register: p?.persona.register ?? 'neutral',
        required,
        forbidden: [...FORBIDDEN_GLOBAL, ...otherKeys],
        words: b.words ?? beatCtx.words ?? (b.smallTalk ? [2, 14] : [8, 45]),
        ...(beatCtx.pos ? { pos: beatCtx.pos } : {}),
        context: beatCtx.context,
        ...(b.smallTalk ? { smallTalk: true } : {}),
        ...(beatCtx.mail ? { mail: beatCtx.mail } : {}),
      };
      it.render = { mode: 'human', beat };
      it.text = null;
      it.rendered = false;
    }
  }

  /** Attach tracker keys after creation: the renderer must write them, and must not write the project's other keys. */
  addKeys(it: PlannedItem, keys: string[] = []): void {
    if (!keys.length) return;
    it.keys = uniq([...it.keys, ...keys]);
    if (it.render.mode !== 'human') return;
    const beat = it.render.beat;
    beat.required = uniq([...beat.required, ...keys]);
    const others = uniq(keys.flatMap((k) => this.keysByProject.get(k.split('-')[0]!) ?? [])).filter((k) => !beat.required.includes(k)).slice(0, 12);
    beat.forbidden = uniq([...beat.forbidden, ...others]);
  }

  // ── Slack ──
  slackMsg(o: TIn & { ch: string; ts: string; by: string; root?: PlannedItem; mention?: string[]; body: Body; conv?: PlannedItem['thread']; edit?: 'typo' | 'truncate'; editAfter?: number; deleteAfter?: number; opaque?: boolean; context?: string[]; lang?: Lang }): PlannedItem {
    const ch = this.channels.get(o.ch);
    if (!ch) throw new Error(`unknown channel ${o.ch}`);
    const used = this.usedSecs.get(ch.id) ?? new Set<number>();
    this.usedSecs.set(ch.id, used);
    let secs = Math.floor(Date.parse(o.ts) / 1000);
    while (used.has(secs)) secs++;
    used.add(secs);
    const tsStr = `${secs}.000${String(this.counter('slackfrac') % 1000).padStart(3, '0')}`;
    const iso = new Date(secs * 1000).toISOString();
    const day = localDay(iso);
    const team = ACCOUNTS.slackTeam;
    const id = `${ch.id}:${tsStr}`;
    const rootSpec = o.root ? this.slack.get(o.root.id)! : undefined;
    const bot = BOT.get(o.by);
    const isAgent = o.by === 'aven';
    let author: string;
    let authorPid: string;
    let opaque = false;
    if (bot) {
      author = bot.label;
      authorPid = 'system';
    } else {
      const p = this.person(o.by);
      let f = this.form(o.by, 'slack', day);
      if (o.opaque !== undefined && p.slack) f = p.forms.find((x) => x.form === (o.opaque ? 'opaque_id' : 'slack_label') && x.where?.includes('slack')) ?? f;
      opaque = f.form === 'opaque_id';
      author = f.raw;
      authorPid = o.by;
    }
    const container = ch.renamed && iso >= ch.renamed.at ? ch.renamed.container : ch.container;
    const it = this.base(this.next('slack'), `slack:${team}:${id}`, 'message', 'slack', team, iso, o, {
      threadId: `slack:${team}/${ch.id}/${rootSpec ? rootSpec.tsStr : tsStr}`,
      container,
      author,
      authorPerson: authorPid,
      ...(o.conv ? { thread: o.conv } : {}),
    });
    const spec: SlackSpec = { ch, tsStr, author, authorPid, botFlag: !!bot && !bot.unflagged, bot: !!bot, opaque, mentions: o.mention ?? [], rootId: o.root?.id ?? null, replies: [] };
    if (o.edit) spec.edit = { at: addMin(iso, o.editAfter ?? this.int(2, 25)), op: o.edit };
    if (o.deleteAfter !== undefined) spec.deleteAt = addMin(iso, o.deleteAfter);
    this.slack.set(it.id, spec);
    if (rootSpec && o.root) rootSpec.replies.push(it.id);
    const mentionLabels = (o.mention ?? []).map((m) => (m === 'aven' ? '@Aven' : `@${opaque && m === o.by ? author : this.mentionLabel(m, day, opaque)}`));
    if (isAgent || bot) {
      this.setBody(it, o.body, { lang: o.lang ?? 'en', context: o.context ?? [], required: [] });
    } else {
      const audience = ch.members.filter((m) => m !== o.by);
      const lang = this.langOf(o.by, o.lang ?? CH_LANG[o.ch], audience);
      this.setBody(it, o.body, { lang, context: o.context ?? (o.root ? [o.root.id, ...rootSpec!.replies.filter((x) => x !== it.id)] : []), required: mentionLabels, ...(o.conv ? { pos: { index: o.conv.index, of: o.conv.size } } : {}) });
    }
    return it;
  }
  private mentionLabel(pid: string, day: string, opaqueMsg: boolean): string {
    const p = this.person(pid);
    if (pid === 'marco-rossi' && opaqueMsg) return 'U0BWMRSGST1';
    const f = p.forms.find((x) => x.form === 'slack_label' && x.where?.includes('slack') && (!x.from || day >= x.from) && (!x.until || day <= x.until));
    return f?.raw ?? p.name;
  }

  /** A conversation in one Slack container: threaded (replies under the root) or flat (a run of top-level messages). */
  thread(ch: string, day: string, time: string | number, msgs: MsgIn[], d: TIn & { flat?: boolean; lang?: Lang }): PlannedItem[] {
    const out: PlannedItem[] = [];
    let t = at(day, time);
    const size = msgs.length;
    let root: PlannedItem | undefined;
    msgs.forEach((m, i) => {
      if (i > 0) t = m.at ? at(day, m.at) : addMin(t, m.gap ?? this.int(2, 40));
      const conv = { root: root?.id ?? '', index: i, size };
      const prev = out.slice(-3).map((x) => x.id);
      const it = this.slackMsg({
        ...d,
        ...m.t,
        storyline: d.storyline,
        label: m.label ?? d.label,
        shares: m.shares ?? d.shares,
        noise: [...(d.noise ?? []), ...(m.noise ?? [])],
        kind: m.kind,
        ch,
        ts: t,
        by: m.by,
        ...(root && !d.flat ? { root } : {}),
        mention: m.mention,
        body: m.text !== undefined ? { text: m.text } : { beat: { brief: m.brief, ...(m.lang ? { lang: m.lang } : {}), ...(m.words ? { words: m.words } : {}), ...(m.required ? { required: m.required } : {}), ...(m.kind === 'noise' ? { smallTalk: true } : {}) } },
        conv: size > 1 ? conv : undefined,
        context: prev,
        lang: m.lang ?? d.lang,
        ...(m.opaque !== undefined ? { opaque: m.opaque } : {}),
        ...(m.edit ? { edit: m.edit } : {}),
        ...(m.deleteAfter !== undefined ? { deleteAfter: m.deleteAfter } : {}),
        addressee: m.addressee ?? null,
        ...(m.commit ? { commit: m.commit } : {}),
        ...(m.expectsReply !== undefined ? { expectsReply: m.expectsReply } : {}),
        ...(m.by_ ? { rung: m.by_ } : {}),
      });
      this.addKeys(it, m.keys);
      if (i === 0) root = it;
      if (it.thread) it.thread.root = root!.id;
      out.push(it);
    });
    // Answers: a reply marked `answers` closes that question; otherwise a question/request is answered by the next
    // substantive message of someone else in the same conversation.
    msgs.forEach((m, i) => {
      if (m.answers !== undefined) this.answered.set(out[m.answers]!.id, out[i]!.id);
    });
    msgs.forEach((m, i) => {
      if (i === 0 || !(m.kind === 'question' || m.kind === 'request') || this.answered.has(out[i]!.id)) return;
      const k = msgs.findIndex((x, j) => j > i && x.by !== m.by && x.kind !== 'noise' && x.kind !== 'question');
      if (k > i) this.answered.set(out[i]!.id, out[k]!.id);
    });
    const r0 = msgs[0]!;
    if ((r0.kind === 'question' || r0.kind === 'request' || r0.kind === 'incident') && !this.answered.has(out[0]!.id)) {
      const k = msgs.findIndex((m, i) => i > 0 && m.by !== r0.by && m.kind !== 'noise' && m.answers === undefined);
      if (k > 0) this.answered.set(out[0]!.id, out[k]!.id);
    }
    return out;
  }

  // ── mail ──
  mailMsg(o: TIn & { acct: 'work' | 'personal'; ts: string; by: string; fromRaw?: string; to: string[]; cc?: string[]; subject: string; threadOf?: PlannedItem; folder?: string; body: Body; context?: string[]; lang?: Lang; pos?: { index: number; of: number }; greet?: string }): PlannedItem {
    const acct = o.acct === 'work' ? ACCOUNTS.work : ACCOUNTS.personal;
    const day = localDay(o.ts);
    const bot = BOT.get(o.by);
    const where = o.acct === 'personal' ? 'pmail' : 'mail';
    type Addr = { raw: string; pid: string; f: SurfaceForm | null };
    const from: Addr = o.fromRaw ? { raw: o.fromRaw, pid: bot ? 'system' : o.by, f: null } : bot ? { raw: bot.address!, pid: 'system', f: null } : this.addr(o.by, day, where);
    const recip = (x: string): Addr => (x.includes('@') ? { raw: x, pid: x === LIST_ADDR ? 'system' : this.ownerOfAddress(x), f: null } : this.addr(x, day, where));
    const occFor = (field: IdentityOcc['field'], a: Addr): IdentityOcc => {
      if (a.pid === 'system') return this.sysOcc(field, a.raw);
      const p = this.person(a.pid);
      return this.occOf(field, a.pid, a.f ?? p.forms.find((f) => f.raw === a.raw) ?? this.register(p, a.raw, 'email', where));
    };
    const to = (o.to ?? []).map(recip);
    const cc = (o.cc ?? []).map(recip);
    const n = this.counter('gmail');
    const msgId = hex(`gmail:${acct}:${n}`, 16);
    const threadId = o.threadOf ? this.mail.get(o.threadOf.id)!.threadId : msgId;
    const fromSubject = from.pid === SUBJECT;
    const folder = o.folder ?? (fromSubject ? 'sent' : 'inbox');
    const ref = `gmail:${acct}:${msgId}`;
    const it = this.base(this.next('gmail'), ref, 'message', 'gmail', acct, o.ts, o, { threadId: `gmail:${acct}/${threadId}`, container: folder, author: from.raw, authorPerson: from.pid, title: o.subject });
    const occ: IdentityOcc[] = [];
    occ.push(occFor('author', from));
    for (const x of [...to, ...cc]) {
      if (x.raw === from.raw) continue;
      occ.push(occFor('participant', x));
    }
    this.occ.set(it.id, occ);
    this.mail.set(it.id, { acct, msgId, threadId, folder, from: from.raw, fromPid: from.pid, to, cc, subject: o.subject });
    const toPids = to.map((x) => x.pid).filter((x) => x !== 'system');
    const lang = bot ? 'en' : this.langOf(o.by, o.lang, toPids);
    this.setBody(it, o.body, { lang, context: o.context ?? (o.threadOf ? this.mailContext(o.threadOf) : []), required: [], ...(o.pos ? { pos: o.pos } : {}), mail: { greet: o.greet ?? (toPids[0] && this.isPerson(toPids[0]) ? this.person(toPids[0]).name.split(' ')[0]! : ''), signOff: true }, words: [30, 160] });
    return it;
  }
  private mailContext(root: PlannedItem): string[] {
    const tid = this.mail.get(root.id)!.threadId;
    return this.items.filter((x) => x.source === 'gmail' && this.mail.get(x.id)?.threadId === tid).map((x) => x.id).slice(-3);
  }
  ownerOfAddress(addr: string): string {
    for (const p of this.world.people) if (p.forms.some((f) => f.raw === addr)) return p.id;
    for (const b of this.world.bots) if (b.address === addr) return 'system';
    return 'system';
  }

  /** A mail conversation: replies thread under the first mail, subject "Re:"/"AW:" unless given. */
  mailThread(acct: 'work' | 'personal', subject: string, day: string, time: string | number, mails: MailIn[], d: TIn & { lang?: Lang; reply?: 'Re' | 'AW' }): PlannedItem[] {
    const out: PlannedItem[] = [];
    let t = at(day, time);
    mails.forEach((m, i) => {
      if (i > 0) t = m.day ? at(m.day, m.at ?? '09:30') : addMin(t, m.gap ?? this.int(20, 600));
      const subj = m.subject ?? (i === 0 ? subject : `${d.reply ?? 'Re'}: ${subject}`);
      const it = this.mailMsg({
        ...d,
        ...m.t,
        storyline: d.storyline,
        label: m.label ?? d.label,
        shares: m.shares ?? d.shares,
        noise: [...(d.noise ?? []), ...(m.noise ?? [])],
        kind: m.kind,
        acct,
        ts: t,
        by: m.by,
        to: m.to,
        cc: m.cc,
        subject: subj,
        ...(out[0] ? { threadOf: out[0] } : {}),
        body: m.text !== undefined ? { text: m.text } : m.derived ? { derived: m.derived } : { beat: { brief: m.brief, ...(m.lang ? { lang: m.lang } : {}), ...(m.required ? { required: m.required } : {}), ...(m.words ? { words: m.words } : {}) } },
        context: out.slice(-3).map((x) => x.id),
        lang: m.lang ?? d.lang,
        pos: { index: i, of: mails.length },
        addressee: m.addressee ?? null,
        ...(m.commit ? { commit: m.commit } : {}),
        ...(m.fromRaw ? { fromRaw: m.fromRaw } : {}),
        ...(m.folder ? { folder: m.folder } : {}),
        ...(m.by_ ? { rung: m.by_ } : {}),
      });
      this.addKeys(it, m.keys);
      out.push(it);
    });
    mails.forEach((m, i) => {
      if (m.answers !== undefined) this.answered.set(out[m.answers]!.id, out[i]!.id);
    });
    mails.forEach((m, i) => {
      if (i === 0 || !(m.kind === 'question' || m.kind === 'request') || this.answered.has(out[i]!.id)) return;
      const k = mails.findIndex((x, j) => j > i && x.by !== m.by && x.kind !== 'noise' && x.kind !== 'question');
      if (k > i) this.answered.set(out[i]!.id, out[k]!.id);
    });
    const r0 = mails[0]!;
    if ((r0.kind === 'question' || r0.kind === 'request') && !this.answered.has(out[0]!.id)) {
      const k = mails.findIndex((m, i) => i > 0 && m.by !== r0.by && m.answers === undefined && m.kind !== 'noise');
      if (k > 0) this.answered.set(out[0]!.id, out[k]!.id);
    }
    return out;
  }

  // ── trackers ──
  ticket(o: TIn & { project: string; num?: number; title?: string; created: string; reporter: string; assignee: string | null; statuses: { at: string; status: string }[]; labels?: string[]; due?: string; brief: string; lang?: Lang; comments?: CommentIn[]; required?: string[] }): PlannedItem {
    const jira = o.project === 'MT';
    const tracker = jira ? 'jira' : 'youtrack';
    const account = jira ? ACCOUNTS.jira : ACCOUNTS.youtrack;
    const num = o.num ?? this.nextKeyNum(o.project);
    const projectDb: Record<string, number> = { ALP: 2, VN: 3, SWL: 4, KT: 5, BKR: 6, OPS: 7 };
    const taskId = jira ? String(10_100 + this.counter('jira-id')) : `${projectDb[o.project]}-${100 + num}`;
    const day = localDay(o.created);
    const ytRaw = (pid: string) => (jira ? this.addr(pid, day, 'jira') : this.addr(pid, day, 'yt'));
    const reporter = ytRaw(o.reporter);
    const assignee = o.assignee ? ytRaw(o.assignee) : null;
    const key0 = `${o.project}-${num}`;
    const renameAt = o.project === 'KT' ? RENAME_AT : undefined;
    const finalKey = o.project === 'KT' && o.statuses.some((s) => s.at >= RENAME_AT) ? `KH-${num}` : key0;
    const it = this.base(this.next(tracker), `${tracker}:${account}:${taskId}`, 'task', tracker, account, o.created, o, {
      container: finalKey.split('-')[0]!,
      author: reporter.raw,
      authorPerson: o.reporter,
      title: o.title,
      keys: uniq([key0, finalKey]),
    });
    const occ = [this.occOf('reporter', o.reporter, reporter.f), ...(assignee && o.assignee ? [this.occOf('assignee', o.assignee, assignee.f)] : [])];
    this.occ.set(it.id, occ);
    this.task.set(it.id, { tracker, taskId, project: o.project, num, reporter: { raw: reporter.raw, pid: o.reporter }, assignee: assignee && o.assignee ? { raw: assignee.raw, pid: o.assignee } : null, statuses: o.statuses, labels: o.labels ?? [], due: o.due ?? '', comments: [], ...(renameAt ? { renameAt } : {}) });
    const list = this.keysByProject.get(o.project) ?? [];
    list.push(key0);
    this.keysByProject.set(o.project, list);
    if (o.project === 'KT') this.keysByProject.set('KH', [...(this.keysByProject.get('KH') ?? []), `KH-${num}`]);
    const lang = o.lang ?? this.langOf(o.reporter, PROJECT_LANG[o.project], o.assignee ? [o.assignee] : []);
    this.setBody(it, { beat: { brief: o.brief, required: o.required } }, { lang, context: [], required: [], words: [25, 120] });
    for (const c of o.comments ?? []) this.commentOn(it, c);
    return it;
  }
  nextKeyNum(project: string): number {
    const start: Record<string, number> = { ALP: 30, VN: 20, SWL: 50, KT: 14, BKR: 120, OPS: 8, MT: 104 };
    return start[project]! + this.counter(`key:${project}`);
  }
  commentOn(task: PlannedItem, c: CommentIn): PlannedItem {
    const ts = this.task.get(task.id)!;
    const jira = ts.tracker === 'jira';
    const cid = jira ? String(20_100 + this.counter('jira-c')) : `4-${1000 + this.counter('yt-c')}`;
    const day = localDay(c.ts);
    const a = jira ? this.addr(c.by, day, 'jira') : this.addr(c.by, day, 'yt');
    const keyAt = ts.renameAt && c.ts >= ts.renameAt ? `KH-${ts.num}` : `${ts.project}-${ts.num}`;
    const t: TIn = { storyline: this.tins.get(task.id)!.storyline, label: c.label ?? this.tins.get(task.id)!.label, shares: c.shares, kind: c.kind, noise: c.noise, addressee: c.addressee ?? null, ...(c.commit ? { commit: c.commit } : {}), ...(c.by_ ? { rung: c.by_ } : {}) };
    const it = this.base(this.next(`${ts.tracker}-c`), `${task.ref}#c${cid}`, 'comment', ts.tracker, task.account, c.ts, t, { container: keyAt.split('-')[0]!, author: a.raw, authorPerson: c.by, keys: [keyAt], thread: { root: task.id, index: ts.comments.length + 1, size: 0 } });
    ts.comments.push(it.id);
    this.comment.set(it.id, { task: task.id, commentId: cid, author: { raw: a.raw, pid: c.by } });
    this.occ.set(it.id, [this.occOf('comment_author', c.by, a.f)]);
    const lang = c.lang ?? this.langOf(c.by, PROJECT_LANG[ts.project], [ts.reporter.pid, ...(ts.assignee ? [ts.assignee.pid] : [])]);
    const prev = [task.id, ...ts.comments.slice(-3, -1)];
    this.setBody(it, c.text !== undefined ? { text: c.text } : { beat: { brief: c.brief, ...(c.required ? { required: c.required } : {}) } }, { lang, context: prev, required: [], words: [6, 70] });
    if (c.answers) this.answered.set(c.answers, it.id);
    return it;
  }

  // ── calendar ──
  calEvent(o: TIn & { start: string; minutes: number; title: string; attendees: string[]; organizer: string; allDay?: boolean; createdAt?: string; cancelledAt?: string; idSeed?: string }): PlannedItem {
    const day = localDay(o.start);
    const eventId = o.idSeed ? o.idSeed : b32(`gcal:${this.counter('gcal')}`, 26);
    const att = o.attendees.map((x) => (x.includes('@') ? { raw: x, pid: 'system', f: null as SurfaceForm | null } : { ...this.addr(x, day, 'cal') }));
    const org = o.organizer.includes('@') ? { raw: o.organizer, pid: 'system', f: null as SurfaceForm | null } : this.addr(o.organizer, day, 'cal');
    const it = this.base(this.next('gcal'), `gcal:${ACCOUNTS.work}:${eventId}`, 'event', 'gcal', ACCOUNTS.work, o.start, o, { container: ACCOUNTS.work, author: org.raw, authorPerson: org.pid, title: o.title });
    const occ: IdentityOcc[] = [org.f ? this.occOf('organizer', org.pid, org.f) : this.sysOcc('organizer', org.raw)];
    for (const a of att) occ.push(a.f ? this.occOf('attendee', a.pid, a.f) : this.sysOcc('attendee', a.raw));
    this.occ.set(it.id, occ);
    const end = o.allDay ? plusDays(day, Math.max(1, Math.round(o.minutes / 1440))) : addMin(o.start, o.minutes);
    this.event.set(it.id, { eventId, start: o.allDay ? day : rfc3339(o.start), end: o.allDay ? end : rfc3339(end), allDay: !!o.allDay, attendees: att.map((a) => ({ raw: a.raw, pid: a.pid })), organizer: { raw: org.raw, pid: org.pid }, createdAt: o.createdAt ?? addMin(o.start, -this.int(1, 6) * 1440), ...(o.cancelledAt ? { cancelledAt: o.cancelledAt } : {}) });
    it.text = o.title;
    it.rendered = true;
    return it;
  }

  // ── meetings ──
  call(o: CallIn): PlannedItem[] {
    const day = localDay(at(o.day, o.start));
    const start = at(o.day, o.start);
    const end = addMin(start, o.minutes);
    const callId = `call-${String(this.calls.length + 1).padStart(2, '0')}`;
    const copies: PlannedItem[] = [];
    const topicsTruth = o.topics.map((t) => ({ heading: t.heading, share: t.share, label: t.label }));
    const shares = aggregateShares(o.topics.map((t) => ({ id: t.label, share: t.share })));
    o.recorders.forEach((rec, i) => {
      const title = o.titles?.[rec] ?? o.title;
      const shift = rec === 'granola' && o.splitTrap ? 20 : 0;
      const cStart = addMin(start, shift);
      // Gemini docs carry no duration (end = start); a split-trap Granola note started 20 min late.
      const cEnd = rec === 'gmeet' ? cStart : end;
      const n = this.counter(`meet:${rec}`);
      const meetingId = rec === 'granola' ? `not_${hex(`granola:${callId}:${n}`, 14)}` : rec === 'gmeet' ? `1${b32(`gmeet:${callId}:${n}`, 32).toUpperCase().replace(/[^0-9A-Z]/g, 'x')}` : `${hex(`wispr:${callId}`, 8)}-${hex(`w2:${callId}`, 4)}-4${hex(`w3:${callId}`, 3)}-a${hex(`w4:${callId}`, 3)}-${hex(`w5:${callId}`, 12)}`;
      const account = rec === 'granola' ? ACCOUNTS.granola : rec === 'gmeet' ? ACCOUNTS.work : ACCOUNTS.wispr;
      const occ: IdentityOcc[] = [];
      let attendees: { email: string; name: string }[] = [];
      let invited: string | undefined;
      if (rec === 'granola') {
        attendees = o.attendees.map((pid) => {
          const f = this.form(pid, 'granola', day);
          occ.push(this.occOf('attendee', pid, f));
          return { email: f.raw.includes('@') ? f.raw.toLowerCase() : '', name: this.person(pid).name };
        });
      } else if (rec === 'wispr') {
        attendees = (o.wispr ?? o.attendees.map((pid) => [pid, ''] as [string, string])).map(([pid, raw]) => {
          const f = raw ? this.register(this.person(pid), raw, this.meetingFormKind(pid, raw, 'wispr'), 'wispr') : this.form(pid, 'wispr', day);
          occ.push(this.occOf('attendee', pid, f));
          return { email: '', name: f.raw };
        });
      } else {
        // Gemini: ONE attendee entry — the "Invited" chips joined by spaces (no commas in real exports).
        const chips = (o.chips ?? [[SUBJECT, '']]).map(([pid, raw]) => {
          const f = raw ? this.register(this.person(pid), raw, this.meetingFormKind(pid, raw, 'gmeet'), 'gmeet') : this.form(pid, 'gmeet', day);
          return { pid, f };
        });
        // parseGeminiDoc then splits the line on commas — so a "Müller, Jürg" chip cuts the line in the wrong
        // places. Chip spans tell which people each resulting entry actually contains.
        let line = '';
        const spans: { pid: string; f: SurfaceForm; s: number; e: number }[] = [];
        for (const c of chips) {
          if (line) line += ' ';
          spans.push({ pid: c.pid, f: c.f, s: line.length, e: line.length + c.f.raw.length });
          line += c.f.raw;
        }
        invited = line;
        const entries: { text: string; s: number; e: number }[] = [];
        let pos = 0;
        for (const m of line.matchAll(/\s*,\s*/g)) {
          entries.push({ text: line.slice(pos, m.index), s: pos, e: m.index! });
          pos = m.index! + m[0].length;
        }
        entries.push({ text: line.slice(pos), s: pos, e: line.length });
        for (const en of entries) {
          const text = en.text.trim();
          if (!text) continue;
          const entry = text.includes('@') ? { email: text.toLowerCase(), name: '' } : { email: '', name: text };
          attendees.push(entry);
          const inside = spans.filter((sp) => sp.s < en.e && sp.e > en.s);
          if (inside.length === 1 && inside[0]!.f.raw === text) occ.push(this.occOf('attendee', inside[0]!.pid, inside[0]!.f));
          else {
            const pids = sorted(uniq(inside.map((c) => c.pid)));
            // Splittable = whole chips only, each exactly the canonical name of a person the GIVEN people file has
            // (the "split on known full names" rule; diacritics folded) — anything else needs a person to answer.
            const whole = inside.every((sp) => sp.s >= en.s && sp.e <= en.e);
            const fold = (x: string) => x.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
            const splittable = whole && inside.every((c) => this.person(c.pid).given && fold(c.f.raw) === fold(this.person(c.pid).name));
            occ.push({ field: 'attendee', raw: entry.email || entry.name, truth: pids.join('+'), form: 'glued_pair', expected: splittable ? 'merge' : 'question' });
          }
        }
      }
      const emitAt = rec === 'gmeet' ? addMin(end, o.late ? 26 * 60 : 35) : addMin(end, rec === 'granola' ? 12 : 6);
      const ref = `${rec}:${account}:${meetingId}`;
      const multi = o.topics.length > 1;
      const t: TIn = {
        storyline: o.storyline,
        shares,
        label: shares[0]?.id ?? 'none',
        noise: [
          ...(o.noise ?? []),
          ...(o.recorders.length > 1 ? ['recorder_copy' as NoiseTag] : []),
          ...(rec === 'gmeet' && o.late ? ['late_copy' as NoiseTag] : []),
          ...(o.splitTrap ? ['call_split_trap' as NoiseTag] : []),
          ...(multi ? ['multi_initiative' as NoiseTag] : []),
          ...(occ.some((x) => x.form === 'glued_pair') ? ['glued' as NoiseTag] : []),
          ...(rec !== 'granola' ? ['name_only' as NoiseTag] : []),
        ],
        kind: null,
        ...(o.by_ ? { rung: o.by_ } : {}),
        cluster: `rec-${callId}`,
        dedupType: o.recorders.length > 1 ? 'recorder_copy' : undefined,
        canonical: i === 0,
      };
      const it = this.base(this.next('meeting'), ref, 'meeting', rec, account, cStart, t, {
        altRef: `meeting:${rec}:${meetingId}`,
        container: null,
        author: null,
        authorPerson: null,
        title,
        meeting: { call: callId, recorder: rec, primary: i === 0, ...(invited !== undefined ? { invited } : {}), style: rec },
      });
      this.occ.set(it.id, occ);
      const url = rec === 'granola' ? `https://notes.granola.example/d/${meetingId}` : rec === 'gmeet' ? `https://docs.workspace.example/document/d/${meetingId}` : `https://flow.wispr.example/m/${meetingId}`;
      this.meet.set(it.id, { recorder: rec, meetingId, start: cStart, end: cEnd, attendees, occ, url, emitAt });
      if (i === 0) {
        const speakers = uniq([SUBJECT, ...o.attendees.filter((p) => p !== SUBJECT)]).slice(0, 6).map((p) => this.person(p).name);
        const beat: Beat = {
          brief: o.brief,
          persona: SUBJECT,
          lang: o.lang,
          register: 'neutral',
          required: uniq(o.required ?? []),
          forbidden: [...FORBIDDEN_GLOBAL],
          words: [Math.max(120, o.minutes * 5), Math.max(220, o.minutes * 9)],
          context: [],
          meeting: {
            topics: o.topics.map((x) => ({ heading: x.heading, share: x.share, brief: x.brief })),
            nextSteps: o.nextSteps.map((x, k) => ({ owner: x.owner, ownerLabel: this.person(x.owner).name, brief: x.brief, due: x.due, commitment: x.commit ? `cm-${callId}-${k + 1}` : null })),
            speakers,
            minutes: o.minutes,
          },
        };
        it.render = { mode: 'human', beat };
      } else {
        it.render = { mode: 'derived', from: copies[0]!.id, op: {} };
      }
      copies.push(it);
    });
    // Commitments made on the call (once per call; every copy carries them in truth).
    o.nextSteps.forEach((x, k) => {
      if (!x.commit) return;
      const id = `cm-${callId}-${k + 1}`;
      this.commitments.push({ id, owner: x.owner, to: x.to ?? o.attendees.filter((p) => p !== x.owner).slice(0, 3), due: x.due, outcome: x.commit, keptBy: null, ref: copies[0]!.ref, what: x.brief, item: copies[0]!.id });
    });
    this.calls.push({ id: callId, copies: copies.map((c) => c.id), topics: topicsTruth, storyline: o.storyline, start, title: o.title });
    if (o.event !== false) {
      this.calEvent({ storyline: o.storyline, shares, label: shares[0]?.id ?? 'none', start, minutes: o.minutes, title: o.eventTitle ?? o.title, attendees: o.attendees, organizer: o.organizer ?? SUBJECT, kind: null, noise: o.recurring ? ['recurring'] : [] });
    }
    return copies;
  }

  // ── activity ──
  private actRefs = new Set<string>();
  work(o: TIn & { source: 'git' | 'claude'; repo: string; day: string; start: string; minutes: number; subjects: string[] }): PlannedItem {
    let start = at(o.day, o.start);
    // The puller's block id hashes (source, container, start): two blocks may not share all three.
    while (this.actRefs.has(`${o.source}|${o.repo}|${start}`)) start = addMin(start, 7);
    this.actRefs.add(`${o.source}|${o.repo}|${start}`);
    const end = addMin(start, o.minutes);
    const renamed = this.world.repos.find((r) => r.container === o.repo && r.renamed && start >= r.renamed.at);
    const container = renamed?.renamed?.container ?? o.repo;
    const id = blockId(o.source, container, start);
    const items = o.subjects.map((s, i) => ({ ts: addMin(start, Math.round(((i + 1) * o.minutes) / (o.subjects.length + 1))), text: s }));
    const short = shortContainer(container);
    const title = o.source === 'git' ? `${short}: ${items.length} commit${items.length > 1 ? 's' : ''} — ${items[0]!.text.slice(0, 80)}` : `claude in ${short} (${Math.max(1, Math.ceil(items.length / 3))} session${items.length > 3 ? 's' : ''}): ${items[0]!.text.slice(0, 80)}`;
    const it = this.base(this.next('activity'), `${o.source}:${ACCOUNTS.host}:${id}`, 'activity', o.source, ACCOUNTS.host, start, { ...o, kind: null }, { altRef: `activity:${o.source}:${id}`, container, author: null, authorPerson: SUBJECT, title });
    this.act.set(it.id, { source: o.source, container, start, end, minutes: o.minutes, items });
    it.text = [title, ...items.map((x) => x.text)].join('\n');
    it.rendered = true;
    this.occ.set(it.id, []);
    return it;
  }
}

// --- DSL shapes -------------------------------------------------------------------------------------------

interface MsgIn {
  by: string;
  kind: TruthKind;
  brief: string;
  mention?: string[];
  addressee?: Addressee;
  label?: string;
  shares?: Share[];
  keys?: string[];
  gap?: number;
  at?: string;
  noise?: NoiseTag[];
  commit?: TIn['commit'];
  answers?: number;
  lang?: Lang;
  words?: [number, number];
  required?: string[];
  text?: string;
  opaque?: boolean;
  edit?: 'typo' | 'truncate';
  deleteAfter?: number;
  expectsReply?: boolean;
  by_?: DecidableBy;
  t?: Partial<TIn>;
}
interface MailIn {
  by: string;
  to: string[];
  cc?: string[];
  kind: TruthKind;
  brief: string;
  gap?: number;
  day?: string;
  at?: string;
  subject?: string;
  label?: string;
  shares?: Share[];
  keys?: string[];
  noise?: NoiseTag[];
  commit?: TIn['commit'];
  answers?: number;
  lang?: Lang;
  required?: string[];
  words?: [number, number];
  text?: string;
  derived?: { from: string; op: DeriveOp };
  addressee?: Addressee;
  fromRaw?: string;
  folder?: string;
  by_?: DecidableBy;
  t?: Partial<TIn>;
}
interface CommentIn {
  ts: string;
  by: string;
  kind: TruthKind;
  brief: string;
  text?: string;
  label?: string;
  shares?: Share[];
  noise?: NoiseTag[];
  addressee?: Addressee;
  commit?: TIn['commit'];
  answers?: string;
  lang?: Lang;
  required?: string[];
  by_?: DecidableBy;
}
interface CallIn {
  storyline: string;
  title: string;
  titles?: Partial<Record<'granola' | 'gmeet' | 'wispr', string>>;
  eventTitle?: string;
  day: string;
  start: string;
  minutes: number;
  recorders: ('granola' | 'gmeet' | 'wispr')[];
  attendees: string[];
  organizer?: string;
  chips?: [string, string][]; // gmeet Invited chips: [person, raw ('' = pick a form)]
  wispr?: [string, string][]; // wispr attendee names
  topics: { heading: string; share: number; label: string; brief: string }[];
  nextSteps: { owner: string; brief: string; due: string | null; commit?: 'kept' | 'missed' | 'open'; to?: string[] }[];
  brief: string;
  lang: Lang;
  required?: string[];
  late?: boolean;
  splitTrap?: boolean;
  recurring?: boolean;
  noise?: NoiseTag[];
  event?: false;
  by_?: DecidableBy;
}

const CH_LANG: Record<string, Lang> = {
  general: 'de', random: 'de', dev: 'en', booker: 'en', sales: 'de', hiring: 'de', 'ext-alpenhof': 'de', 'ext-velonord': 'en', 'ext-swl': 'de', 'ext-medtrack': 'en', 'ext-klartext-cms': 'de',
  'dm:@jonas': 'de', 'dm:@lea': 'de', 'dm:@dima': 'ru', 'dm:@sasha': 'ru', 'dm:U0BWMRSGST1': 'en', 'mpim:@lea+@tobias': 'de', 'mpim:@dima+@olga': 'ru',
};
const FLAVOUR: Record<string, [Lang, number]> = { 'marco-bernasconi': ['it', 0.6], 'laura-imhof': ['fr', 0.5], 'sophie-laurent': ['fr', 0.35], 'chiara-romano': ['it', 0.3], 'marco-rossi': ['it', 0.3] };
const PROJECT_LANG: Record<string, Lang> = { ALP: 'de', VN: 'en', SWL: 'de', KT: 'de', BKR: 'en', OPS: 'en', MT: 'en' };

const one = (id: string): Share[] => [{ id, share: 1 }];
function aggregateShares(xs: Share[]): Share[] {
  const m = new Map<string, number>();
  for (const x of xs) if (x.id !== 'none') m.set(x.id, (m.get(x.id) ?? 0) + x.share);
  const total = [...m.values()].reduce((a, b) => a + b, 0);
  if (!total) return [];
  return [...m.entries()].map(([id, s]) => ({ id, share: Math.round((s / total) * 1000) / 1000 })).sort((a, b) => b.share - a.share || a.id.localeCompare(b.id));
}
const to = (ids: string[], addressing: Addressee['addressing'] = 'implicit', extra: Partial<Addressee> = {}): Addressee => ({ to: sorted(uniq(ids)), addressing, ...extra });
const nobody = (extra: Partial<Addressee> = {}): Addressee => ({ to: [], addressing: 'none', ...extra });

// =========================================================================================================
// Storylines (spec §2.4, compressed into 4 weeks). Each is a scripted set of beats with exact labels.
// =========================================================================================================

function s1Alpenhof(g: Gen): void {
  const S = 's1-alpenhof';
  const RL = 'alpenhof/relaunch';
  // Tickets first (keys are referenced by the conversations).
  g.ticket({ storyline: S, label: RL, project: 'ALP', title: 'Relaunch: 301-Weiterleitungen der alten URLs', created: at(wd(0), '10:12'), reporter: 'lea-vogt', assignee: 'dmitry-sokolov', labels: ['relaunch'],
    statuses: [{ at: at(wd(0), '10:12'), status: 'Open' }, { at: at(wd(2), '09:40'), status: 'In Progress' }, { at: at(wd(6), '16:05'), status: 'Fixed' }],
    brief: 'List of about 140 old URLs from the previous hotel website that need 301 redirects to the new pages before go-live; the CSV export is attached.', kind: 'request',
    comments: [
      { ts: at(wd(2), '09:41'), by: 'dmitry-sokolov', kind: 'question', brief: 'Asks whether the old /de/zimmer-* URLs should all point to the new room overview or to individual room pages.' },
      { ts: at(wd(2), '11:20'), by: 'lea-vogt', kind: 'answer', brief: 'Individual room pages where a match exists, otherwise the overview; she will mark the matches in the CSV.' },
      { ts: at(wd(6), '16:04'), by: 'dmitry-sokolov', kind: 'info', brief: 'Redirect map deployed to staging, 138 of 140 URLs covered, two pages no longer exist.' },
    ] });
  const tChecklist = g.ticket({ storyline: S, label: RL, project: 'ALP', title: 'Go-Live-Checkliste abarbeiten', created: at(wd(1), '08:55'), reporter: 'lea-vogt', assignee: 'lea-vogt', labels: ['relaunch'], due: '2026-09-24',
    statuses: [{ at: at(wd(1), '08:55'), status: 'Open' }, { at: at(wd(5), '10:00'), status: 'In Progress' }, { at: at(wd(16), '17:30'), status: 'Done' }],
    brief: 'Checklist for the Alpenhof go-live: DNS switch, SSL, redirects, analytics, cookie banner, content freeze and the booking widget test.', kind: 'info',
    comments: [
      { ts: at(wd(8), '15:12'), by: 'claudia-steiner', kind: 'question', brief: 'Asks whether the go-live on 24 September is still realistic given the open spa page.', required: ['24.09.'] },
      { ts: at(wd(8), '16:40'), by: 'lea-vogt', kind: 'answer', brief: 'Still on track, the spa page is the last open item and is planned for Monday.' },
      { ts: at(wd(11), '17:05'), by: 'lea-vogt', kind: 'info', brief: 'Go-live moved to 29 September after the decision call; DNS switch now planned for that morning.', required: ['29.09.'] },
    ] });
  // W1: Claudia asks about the checklist; Lea commits to the 24.09 go-live (missed later).
  g.thread('ext-alpenhof', wd(0), '09:18', [
    { by: 'claudia-steiner', kind: 'question', brief: 'Asks the team where the go-live checklist stands and whether anything is needed from the hotel side this week.', addressee: to(['lea-vogt'], 'implicit', { side: 'brightwell' }) },
    { by: 'lea-vogt', kind: 'answer', brief: `Answers that the checklist is in ${tChecklist.keys[0]} and that the hotel still owes the final spa texts and photo licences.`, keys: [tChecklist.keys[0]!], addressee: to(['claudia-steiner']) },
    { by: 'claudia-steiner', kind: 'noise', brief: 'Thanks, will send the texts.', addressee: nobody() },
  ], { storyline: S, label: RL });
  g.thread('ext-alpenhof', wd(2), '14:02', [
    { by: 'lea-vogt', kind: 'commitment', brief: 'Confirms to the hotel that the go-live happens on 24 September as planned, with the DNS switch in the morning.', required: ['24.09.'], addressee: to(['claudia-steiner', 'juerg-mueller'], 'implicit', { side: 'alpenhof' }),
      commit: { owner: 'lea-vogt', to: ['claudia-steiner'], due: '2026-09-24', outcome: 'missed', what: 'go-live on 24.09.' } },
    { by: 'juerg-mueller', kind: 'question', brief: 'Asks who will change the DNS records and whether he needs to lower the TTL beforehand.', addressee: to(['lea-vogt']) },
    { by: 'mara-keller', kind: 'answer', brief: 'Answers that she will send a DNS cutover plan with the exact records and that the TTL should go down to 300 seconds two days before.', addressee: to(['juerg-mueller']), required: ['300'] },
  ], { storyline: S, label: RL });
  // W2: go-live prep call (granola + gmeet).
  g.call({ storyline: S, title: 'Alpenhof Go-Live Vorbereitung', titles: { gmeet: 'Alpenhof – Go-Live Vorbereitung' }, day: wd(6), start: '10:00', minutes: 60, recorders: ['granola', 'gmeet'],
    attendees: ['mara-keller', 'lea-vogt', 'claudia-steiner', 'juerg-mueller', 'dmitry-sokolov'],
    chips: [['mara-keller', 'Mara Keller'], ['juerg-mueller', 'Müller, Jürg'], ['claudia-steiner', 'Claudia Steiner']],
    topics: [{ heading: 'Go-Live Ablauf', share: 1, label: RL, brief: 'Walk through the go-live day: DNS switch, redirect test, content freeze from 21 September, booking widget check.' }],
    nextSteps: [
      { owner: 'mara-keller', brief: 'send the DNS cutover plan to Jürg', due: '2026-09-18', commit: 'kept', to: ['juerg-mueller'] },
      { owner: 'lea-vogt', brief: 'confirm the content freeze with Claudia', due: '2026-09-21', commit: 'kept', to: ['claudia-steiner'] },
      { owner: 'dmitry-sokolov', brief: 'test the booking widget prices on staging', due: '2026-09-22', commit: 'missed', to: ['lea-vogt'] },
    ],
    brief: 'Go-live preparation with the hotel: sequence of the go-live day, who does what, open content.', lang: 'de' });
  // Mara keeps her commitment: the DNS plan mail (Jürg is the exclusive retainer marker — wrong here: this is relaunch work).
  const dns = g.mailThread('work', 'Alpenhof Relaunch: DNS-Umstellung – Ablauf', wd(8), '16:20', [
    { by: 'mara-keller', to: ['juerg-mueller'], cc: ['lea-vogt'], kind: 'info', brief: 'Sends the DNS cutover plan: records to change, TTL 300 from two days before, switch at 07:00 on go-live day, rollback plan.', required: ['300', '07:00'] },
    { by: 'juerg-mueller', to: ['mara-keller'], cc: ['lea-vogt'], kind: 'answer', brief: 'Confirms he lowers the TTL and will be available on the go-live morning.', gap: 140 },
  ], { storyline: S, label: RL, reply: 'AW', noise: ['identity_variant'] });
  g.kept('send the DNS cutover plan to Jürg', dns[0]!.id);
  // W3 Mon: SSL on staging (relaunch, again the exclusive-marker person).
  g.thread('ext-alpenhof', wd(10), '08:47', [
    { by: 'juerg-mueller', kind: 'incident', brief: 'Reports that the SSL certificate on the staging site expired over the weekend and the browser blocks access.', addressee: to(['dmitry-sokolov'], 'implicit', { side: 'brightwell' }) },
    { by: 'dmitry-sokolov', kind: 'answer', brief: 'Renewed the staging certificate, should work again in a few minutes.', addressee: to(['juerg-mueller']) },
  ], { storyline: S, label: RL });
  // W3 Tue: decision call → go-live slips to 29.09.
  g.call({ storyline: S, title: 'Alpenhof Go-Live – Entscheid', day: wd(11), start: '11:00', minutes: 30, recorders: ['granola'], attendees: ['mara-keller', 'lea-vogt', 'claudia-steiner'],
    topics: [{ heading: 'Go-Live Termin', share: 1, label: RL, brief: 'Spa page and photo licences are late; decision to move the go-live from 24 to 29 September.' }],
    nextSteps: [
      { owner: 'lea-vogt', brief: 'inform the hotel team about the new go-live date', due: '2026-09-22', commit: 'kept', to: ['claudia-steiner'] },
      { owner: 'mara-keller', brief: 'update the DNS plan for 29.09.', due: '2026-09-25', commit: 'kept', to: ['juerg-mueller'] },
    ],
    brief: 'Short decision call: go-live date moves to 29 September.', lang: 'de', required: ['29.09.'] });
  g.thread('ext-alpenhof', wd(11), '13:10', [
    { by: 'lea-vogt', kind: 'info', brief: 'Announces to the hotel that the go-live moves to Tuesday 29 September; content freeze stays, DNS switch at 07:00 that day.', required: ['29.09.'], addressee: to(['claudia-steiner', 'juerg-mueller'], 'implicit', { side: 'alpenhof', broadcast: true }) },
    { by: 'claudia-steiner', kind: 'noise', brief: 'Short acknowledgement with a thumbs-up.', addressee: nobody() },
  ], { storyline: S, label: RL });
  g.mailThread('work', 'Go-Live verschoben?', wd(11), '18:05', [
    { by: 'claudia-steiner', to: ['mara-keller'], kind: 'question', brief: 'Asks Mara directly whether the new date 29 September is now firm, because the hotel plans a newsletter for that day.', required: ['29.09.'] },
    { by: 'mara-keller', to: ['claudia-steiner'], cc: ['lea-vogt'], kind: 'answer', brief: 'Confirms 29 September is firm and explains that the two missing pages are now in review.', gap: 55 },
  ], { storyline: S, label: RL, reply: 'AW' });
  // W4 Tue (go-live day): deploys, then the widget price incident — genuinely relaunch 0.5 / booker 0.5.
  const split: Share[] = [{ id: RL, share: 0.5 }, { id: 'brightwell/booker', share: 0.5 }];
  const goLive = wd(16);
  const tWidget = g.ticket({ storyline: S, shares: split, label: 'brightwell/booker', project: 'BKR', title: 'Widget shows prices without CHF rounding', created: at(goLive, '10:05'), reporter: 'lea-vogt', assignee: 'chiara-romano',
    statuses: [{ at: at(goLive, '10:05'), status: 'Open' }, { at: at(goLive, '10:30'), status: 'In Progress' }, { at: at(wd(17), '12:10'), status: 'Fixed' }],
    brief: 'On the new Alpenhof room pages the booking widget shows prices like CHF 189.95 instead of rounded CHF 190; reproducible on all room types.', kind: 'incident', noise: ['multi_initiative'], required: ['CHF 190'],
    comments: [
      { ts: at(goLive, '10:31'), by: 'chiara-romano', kind: 'info', brief: 'Found it: the rounding rule of the rate plan is ignored when the widget runs in the new embed mode.' },
      { ts: at(wd(17), '12:09'), by: 'chiara-romano', kind: 'info', brief: 'Fix released with the widget; verified on the Alpenhof room pages.' },
    ] });
  const inc = g.thread('ext-alpenhof', goLive, '09:52', [
    { by: 'claudia-steiner', kind: 'incident', brief: 'Reports that the booking widget on the new room pages shows odd prices like CHF 189.95 instead of CHF 190, guests are already asking.', required: ['CHF 189.95'], addressee: to(['lea-vogt'], 'implicit', { side: 'brightwell' }) },
    { by: 'lea-vogt', kind: 'answer', brief: `Thanks, the team is on it, tracked as ${tWidget.keys[0]}.`, keys: [tWidget.keys[0]!], addressee: to(['claudia-steiner']) },
    { by: 'chiara-romano', kind: 'info', brief: 'Explains the rounding rule is skipped in the new embed mode; a fix is coming today.' },
    { by: 'mara-keller', kind: 'request', brief: 'Asks Chiara to also check the other Booker hotels before releasing the fix.', mention: ['chiara-romano'], addressee: to(['chiara-romano'], 'explicit') },
    { by: 'chiara-romano', kind: 'commitment', brief: 'Promises the fix and the check of all hotels by tomorrow noon.', commit: { owner: 'chiara-romano', to: ['mara-keller'], due: '2026-09-30', outcome: 'kept', what: 'widget rounding fix for all hotels' } },
    { by: 'juerg-mueller', kind: 'question', brief: 'Asks whether the DNS switch this morning could have caused it.', addressee: to(['mara-keller']) },
    { by: 'mara-keller', kind: 'answer', brief: 'No, it is a widget setting, unrelated to the DNS switch which went fine.', addressee: to(['juerg-mueller']) },
  ], { storyline: S, shares: split, label: 'brightwell/booker', noise: ['multi_initiative'] });
  g.thread('ext-alpenhof', wd(17), '12:20', [
    { by: 'chiara-romano', kind: 'info', brief: `Fix for ${tWidget.keys[0]} is live; prices are rounded again on all room pages.`, keys: [tWidget.keys[0]!], addressee: to(['claudia-steiner'], 'implicit', { side: 'alpenhof' }) },
    { by: 'claudia-steiner', kind: 'noise', brief: 'Says thank you, looks good now.', addressee: nobody() },
  ], { storyline: S, shares: split, label: 'brightwell/booker', noise: ['multi_initiative'] });
  // The same issue arrived as a mail too (mail + ticket + Slack for one issue).
  const mailInc = g.mailThread('work', 'Falsche Preise im Buchungswidget', goLive, '09:58', [
    { by: 'claudia-steiner', to: ['mara-keller', 'lea-vogt'], kind: 'incident', brief: 'Same report by mail: prices with decimals in the booking widget on the new website, screenshots attached.', required: ['CHF 189.95'] },
  ], { storyline: S, shares: split, label: 'brightwell/booker', noise: ['multi_initiative', 'ticket_duplicate'] });
  const cl = 'tdup-widget-prices';
  for (const x of [inc[0]!, tWidget, mailInc[0]!]) Object.assign(g.tins.get(x.id)!, { cluster: cl, dedupType: 'ticket_duplicate' as DedupType, canonical: x === inc[0] });
  g.kept('widget rounding fix for all hotels', g.items.find((x) => x.keys.includes(tWidget.keys[0]!) && x.source === 'slack' && x.day === localDay(at(wd(17), '12:20')))?.id);
  // Final invoice (alpenhof/admin) from the CFO.
  g.mailThread('work', 'Schlussrechnung Relaunch', wd(18), '10:40', [
    { by: 'remo-gerber', to: ['mara-keller'], cc: ['sophie-laurent'], kind: 'request', brief: 'Asks for the final invoice of the relaunch to be split into the agreed two cost centres.', label: 'alpenhof/admin' },
    { by: 'mara-keller', to: ['remo-gerber'], cc: ['sophie-laurent'], kind: 'commitment', brief: 'Promises that Sophie sends the split invoice by Friday.', label: 'alpenhof/admin', commit: { owner: 'sophie-laurent', to: ['remo-gerber'], due: '2026-10-02', outcome: 'open', what: 'split final invoice' }, gap: 95 },
  ], { storyline: S, label: 'alpenhof/admin', reply: 'AW' });
  g.patterns.push({ pattern_id: 'p-widget-prices', initiative: 'brightwell/booker', members: [], first_seen: goLive, last_seen: wd(17), note: 'go-live price rounding: Slack thread + mail + BKR ticket + Sentry' });
  // A retainer call recorded by Gemini only: the IT lead's chip in an umlaut-free spelling.
  g.call({ storyline: S, title: 'Alpenhof Support Call', day: wd(13), start: '15:00', minutes: 30, recorders: ['gmeet'], attendees: ['mara-keller', 'juerg-mueller', 'dmitry-sokolov'], organizer: 'juerg-mueller',
    chips: [['juerg-mueller', 'Juerg Mueller']], // a single non-subject chip: the umlaut-free spelling stands alone
    topics: [{ heading: 'Hosting und Wartung', share: 1, label: 'alpenhof/retainer', brief: 'Old-site PHP update, backup check of September, mail forwarding for the reservations address.' }],
    nextSteps: [{ owner: 'dmitry-sokolov', brief: 'fix the mail forwarding for the reservations address', due: '2026-09-25', commit: 'kept', to: ['juerg-mueller'] }],
    brief: 'Monthly retainer call with the hotel IT lead.', lang: 'de' });
}

function s2VeloNord(g: Gen): void {
  const S = 's2-velonord';
  // W2 rebrand notice (velonord/shop: the shop domain switch is the work it causes).
  g.mailThread('work', 'We are now Velo-Nord – new domain', wd(6), '08:30', [
    { by: 'kai-lund', to: ['mara-keller'], cc: ['mette-hansen', 'felix-wagner'], kind: 'info', brief: 'Announces the rebrand: from today all addresses are @velo-nord.example, the shop should move to shop.velo-nord.example soon.', required: ['velo-nord.example'] },
    { by: 'mara-keller', to: ['kai-lund'], cc: ['felix-wagner'], kind: 'commitment', brief: 'Congratulates and promises a plan for the shop domain switch by Friday.', commit: { owner: 'mara-keller', to: ['kai-lund'], due: '2026-09-18', outcome: 'kept', what: 'plan for the shop domain switch' }, gap: 70 },
  ], { storyline: S, label: 'velonord/shop', noise: ['rename', 'identity_variant'] });
  const tDomain = g.ticket({ storyline: S, label: 'velonord/shop', project: 'VN', title: 'Switch shop domain to shop.velo-nord.example', created: at(wd(6), '11:00'), reporter: 'felix-wagner', assignee: 'felix-wagner',
    statuses: [{ at: at(wd(6), '11:00'), status: 'Open' }, { at: at(wd(8), '09:00'), status: 'In Progress' }, { at: at(wd(12), '18:00'), status: 'Done' }],
    brief: 'Move the shop to the new domain, redirect the old one, update the payment provider callback URLs and the sitemap.', kind: 'request', noise: ['rename'],
    comments: [{ ts: at(wd(9), '10:15'), by: 'felix-wagner', kind: 'info', brief: 'Plan sent to Kai: switch on Wednesday evening, old domain redirects for twelve months.' }] });
  g.kept('plan for the shop domain switch', tDomain.id);
  // ERP stock-sync lag pattern (W2, within 7 days): alerts + 3 tickets + client mail + a call.
  const ERP = 'velonord/erp-sync';
  const t1 = g.ticket({ storyline: S, label: ERP, project: 'VN', title: 'Stock sync lags behind by more than 30 minutes', created: at(wd(5), '09:20'), reporter: 'mette-hansen', assignee: 'aleksandr-petrov', labels: ['erp'],
    statuses: [{ at: at(wd(5), '09:20'), status: 'Open' }, { at: at(wd(5), '13:00'), status: 'In Progress' }, { at: at(wd(9), '17:00'), status: 'Fixed' }],
    brief: 'Since Monday the stock levels in the shop are often more than 30 minutes behind the ERP; customers order bikes that are no longer in stock.', kind: 'incident',
    comments: [
      { ts: at(wd(5), '13:02'), by: 'aleksandr-petrov', kind: 'info', brief: 'The sync queue has a backlog of several thousand jobs after the price import; scaling the worker.' },
      { ts: at(wd(7), '10:40'), by: 'mette-hansen', kind: 'question', brief: 'Asks whether the lag is gone, she still sees articles with outdated stock.' },
      { ts: at(wd(7), '15:10'), by: 'aleksandr-petrov', kind: 'answer', brief: 'Lag is down to about five minutes; the remaining outdated articles come from the export issue in the other ticket.' },
    ] });
  const t2 = g.ticket({ storyline: S, label: ERP, project: 'VN', title: 'Articles shown as available although sold out', created: at(wd(6), '14:30'), reporter: 'kai-lund', assignee: 'felix-wagner', labels: ['erp'],
    statuses: [{ at: at(wd(6), '14:30'), status: 'Open' }, { at: at(wd(8), '10:00'), status: 'Waiting for Client' }, { at: at(wd(10), '11:00'), status: 'Fixed' }],
    brief: 'Three models are shown as available in the shop although the ERP says zero stock; list of article numbers attached.', kind: 'incident', noise: ['status_variant'],
    comments: [
      { ts: at(wd(8), '09:55'), by: 'felix-wagner', kind: 'question', brief: 'Asks Kai to confirm whether the three articles are bundles, because bundles are not synced.' },
      { ts: at(wd(9), '16:30'), by: 'kai-lund', kind: 'answer', brief: 'Yes, two of them are bundles; the third is a normal article.' },
    ] });
  const t3 = g.ticket({ storyline: S, label: ERP, project: 'VN', title: 'ERP export fails on special characters', created: at(wd(7), '08:45'), reporter: 'mette-hansen', assignee: 'aleksandr-petrov', labels: ['erp'],
    statuses: [{ at: at(wd(7), '08:45'), status: 'Open' }, { at: at(wd(8), '11:00'), status: 'In Progress' }, { at: at(wd(11), '16:00'), status: 'Fixed' }],
    brief: 'The nightly article export aborts on article names with special characters (ø, å), so those articles are not updated at all.', kind: 'incident',
    comments: [{ ts: at(wd(11), '15:58'), by: 'aleksandr-petrov', kind: 'info', brief: 'Encoding fixed in the bridge; tonight’s export ran through completely.' }] });
  // Duplicate filed by Kai for the same bug as t2 (closed "Duplicate").
  const t2dup = g.ticket({ storyline: S, label: ERP, project: 'VN', title: 'Sold-out bikes still orderable in shop', created: at(wd(7), '17:10'), reporter: 'kai-lund', assignee: 'felix-wagner', labels: ['erp'],
    statuses: [{ at: at(wd(7), '17:10'), status: 'Open' }, { at: at(wd(8), '09:50'), status: 'Duplicate' }],
    brief: 'Customer complaint: ordered a bike that was sold out; looks like the stock in the shop is wrong.', kind: 'incident', noise: ['ticket_duplicate'],
    comments: [{ ts: at(wd(8), '09:50'), by: 'felix-wagner', kind: 'info', brief: `Closing as duplicate of ${t2.keys[0]}.`, required: [t2.keys[0]!] }] });
  for (const x of [t2, t2dup]) Object.assign(g.tins.get(x.id)!, { cluster: 'tdup-vn-soldout', dedupType: 'ticket_duplicate' as DedupType, canonical: x === t2 });
  const mInc = g.mailThread('work', 'Stock levels out of date again', wd(6), '09:05', [
    { by: 'mette-hansen', to: ['mara-keller'], cc: ['kai-lund'], kind: 'incident', brief: 'Complains that stock levels in the shop are out of date again for the third day in a row and asks for a root cause.', expectsReply: true } as MailIn,
    { by: 'mara-keller', to: ['mette-hansen'], cc: ['kai-lund', 'aleksandr-petrov'], kind: 'commitment', brief: 'Apologises, explains the queue backlog and promises a written root-cause summary by Monday.', commit: { owner: 'mara-keller', to: ['mette-hansen'], due: '2026-09-21', outcome: 'kept', what: 'root-cause summary for the stock sync' }, gap: 80 },
  ], { storyline: S, label: ERP });
  g.thread('ext-velonord', wd(6), '10:15', [
    { by: 'mette-hansen', kind: 'incident', brief: `Posts that stock sync is lagging again, references ${t1.keys[0]}.`, keys: [t1.keys[0]!], addressee: to(['aleksandr-petrov'], 'implicit', { side: 'brightwell' }) },
    { by: 'aleksandr-petrov', kind: 'answer', brief: 'Queue backlog after the price import; second worker is running, lag should be gone within the hour.', addressee: to(['mette-hansen']) },
  ], { storyline: S, label: ERP });
  g.call({ storyline: S, title: 'Velo Nord – ERP stock sync', titles: { granola: 'Velo Nord ERP sync' }, day: wd(9), start: '11:00', minutes: 45, recorders: ['gmeet', 'granola'], splitTrap: true,
    attendees: ['mara-keller', 'mette-hansen', 'kai-lund', 'aleksandr-petrov'], chips: [['mara-keller', 'Mara Keller'], ['mette-hansen', 'Mette Hansen']],
    topics: [{ heading: 'Stock sync', share: 1, label: ERP, brief: 'Root cause of the stock lag (queue backlog, export encoding), monitoring, what Velo Nord sees.' }],
    nextSteps: [
      { owner: 'aleksandr-petrov', brief: 'add queue length monitoring to the bridge', due: '2026-09-23', commit: 'kept', to: ['mette-hansen'] },
      { owner: 'mara-keller', brief: 'send the root-cause summary to Mette', due: '2026-09-21', commit: 'kept', to: ['mette-hansen'] },
    ],
    brief: 'Call about the ERP stock sync problems of the week.', lang: 'en' });
  const rc = g.mailThread('work', 'Root cause: stock sync delays (week 38)', wd(10), '09:15', [
    { by: 'mara-keller', to: ['mette-hansen'], cc: ['kai-lund', 'aleksandr-petrov'], kind: 'info', brief: 'Sends the root-cause summary: queue backlog after the price import, the export encoding bug, and the new monitoring.' },
  ], { storyline: S, label: ERP });
  g.kept('send the root-cause summary to Mette', rc[0]!.id);
  g.kept('root-cause summary for the stock sync', rc[0]!.id);
  g.patterns.push({ pattern_id: 'p-vn-stock-sync', initiative: ERP, members: [t1.ref, t2.ref, t3.ref, mInc[0]!.ref], first_seen: wd(5), last_seen: wd(11), note: 'stock-sync lag: alerts + 3 tickets + client mail within 7 days' });
  // B2B (dealer) portal — unregistered — W3/W4.
  const B2B = 'unregistered:velonord-b2b-portal';
  const req = g.mailThread('work', 'Dealer portal for Velo Nord', wd(13), '15:40', [
    { by: 'jan-peters', to: ['mara-keller'], cc: ['kai-lund'], kind: 'request', brief: 'Introduces himself as managing director and asks whether Brightwell could build a portal where bike dealers order at dealer prices.', lang: 'de' },
    { by: 'mara-keller', to: ['jan-peters'], cc: ['kai-lund', 'jonas-brandt'], kind: 'answer', brief: 'Answers that this is possible, proposes an intro call next week.', gap: 120, lang: 'de' },
  ], { storyline: S, label: B2B, noise: ['unregistered'] });
  g.mailMsg({ storyline: S, label: B2B, noise: ['unregistered', 'forward'], kind: 'info', acct: 'work', ts: at(wd(13), '18:02'), by: 'mara-keller', to: ['jonas-brandt'], subject: 'Fwd: Dealer portal for Velo Nord',
    body: { derived: { from: req[0]!.id, op: { prefix: 'FYI – new lead from Velo Nord, see below.\n\n---------- Forwarded message ---------\nFrom: jan.peters@velo-nord.example\nSubject: Dealer portal for Velo Nord\n\n' } } },
    addressee: to(['jonas-brandt']), cluster: 'fwd-b2b', dedupType: 'forward', canonical: false });
  Object.assign(g.tins.get(req[0]!.id)!, { cluster: 'fwd-b2b', dedupType: 'forward' as DedupType, canonical: true });
  g.call({ storyline: S, title: 'Velo Nord Händlerportal – Intro', day: wd(16), start: '15:00', minutes: 60, recorders: ['granola'], attendees: ['mara-keller', 'jonas-brandt', 'jan-peters', 'kai-lund'],
    topics: [{ heading: 'Händlerportal', share: 1, label: B2B, brief: 'Requirements for a dealer portal: dealer login, dealer prices, bulk orders, ERP connection; budget frame.' }],
    nextSteps: [{ owner: 'jonas-brandt', brief: 'send a first estimate for the dealer portal', due: '2026-10-06', commit: 'open', to: ['jan-peters'] }],
    brief: 'Intro call about a dealer portal for Velo Nord.', lang: 'de', noise: ['unregistered'] });
  g.thread('ext-velonord', wd(17), '10:05', [
    { by: 'kai-lund', kind: 'info', brief: 'Shares the list of 40 dealers who would use the portal and their typical order sizes.', addressee: to(['mara-keller'], 'implicit', { side: 'brightwell' }) },
    { by: 'mara-keller', kind: 'question', brief: 'Asks whether dealers need their own price lists or one dealer discount.', addressee: to(['kai-lund']) },
    { by: 'kai-lund', kind: 'answer', brief: 'Own price lists for the five biggest dealers, a flat discount for the rest.', addressee: to(['mara-keller']) },
  ], { storyline: S, label: B2B, noise: ['unregistered'] });
  g.ticket({ storyline: S, label: B2B, project: 'VN', title: 'Dealer portal: collect requirements', created: at(wd(17), '14:00'), reporter: 'mara-keller', assignee: 'felix-wagner',
    statuses: [{ at: at(wd(17), '14:00'), status: 'Open' }], brief: 'Collect requirements for the dealer portal from the intro call and Kai’s dealer list.', kind: 'info', noise: ['unregistered'],
    comments: [{ ts: at(wd(18), '09:30'), by: 'felix-wagner', kind: 'question', brief: 'Asks whether the portal should live in the existing shop or as a separate app.' }] });
}

function s3Swl(g: Gen): void {
  const S = 's3-swl';
  const P = 'swl/portal';
  const ADM = 'swl/admin';
  const tLogin = g.ticket({ storyline: S, label: P, project: 'SWL', title: 'Login-Timeout im Kundenportal', created: at(wd(5), '08:20'), reporter: 'tobin-berger', assignee: 'aleksandr-petrov',
    statuses: [{ at: at(wd(5), '08:20'), status: 'Open' }, { at: at(wd(5), '09:00'), status: 'In Progress' }, { at: at(wd(7), '18:00'), status: 'Fixed' }, { at: at(wd(9), '10:00'), status: 'Verified' }],
    brief: 'Seit heute Morgen bricht der Login im Kundenportal nach 30 Sekunden mit einem Timeout ab; die Hotline erhält viele Anrufe.', kind: 'incident',
    comments: [
      { ts: at(wd(5), '09:01'), by: 'aleksandr-petrov', kind: 'info', brief: 'Session store is overloaded, connections pile up; increasing the pool as a first measure.', lang: 'en' },
      { ts: at(wd(5), '14:30'), by: 'marco-bernasconi', kind: 'question', brief: 'Fragt, ob das Problem mit dem Update vom Wochenende zusammenhängt.', lang: 'it' },
      { ts: at(wd(5), '15:15'), by: 'tobias-hofer', kind: 'answer', brief: 'Antwortet, dass es nicht am Update liegt, sondern an der Last auf dem Session-Store.' },
      { ts: at(wd(7), '17:55'), by: 'aleksandr-petrov', kind: 'info', brief: 'Session store moved to a bigger instance; no timeouts since 15:00.', lang: 'en' },
    ] });
  const tReset = g.ticket({ storyline: S, label: P, project: 'SWL', title: 'Passwort-Reset-Mail kommt nicht an', created: at(wd(5), '11:45'), reporter: 'tobin-berger', assignee: 'dmitry-sokolov',
    statuses: [{ at: at(wd(5), '11:45'), status: 'Open' }, { at: at(wd(6), '10:00'), status: 'Waiting for client' }, { at: at(wd(8), '12:00'), status: 'Fixed' }],
    brief: 'Kunden, die wegen des Timeouts das Passwort zurücksetzen wollen, erhalten keine Mail.', kind: 'incident', noise: ['status_variant'],
    comments: [
      { ts: at(wd(6), '09:58'), by: 'dmitry-sokolov', kind: 'question', brief: 'Asks for two affected customer numbers to check the mail log.', lang: 'en' },
      { ts: at(wd(6), '16:20'), by: 'tobin-berger', kind: 'answer', brief: 'Schickt zwei Kundennummern.' },
    ] });
  const tSess = g.ticket({ storyline: S, label: P, project: 'SWL', title: 'Session läuft nach 5 Minuten ab', created: at(wd(6), '13:10'), reporter: 'marco-bernasconi', assignee: 'dmitry-sokolov',
    statuses: [{ at: at(wd(6), '13:10'), status: 'Open' }, { at: at(wd(10), '11:00'), status: 'In Progress' }, { at: at(wd(14), '16:00'), status: 'Fixed' }],
    brief: 'Nach dem Fix werden Benutzer nach fünf Minuten Inaktivität ausgeloggt; früher waren es 30 Minuten.', kind: 'incident',
    comments: [{ ts: at(wd(10), '11:02'), by: 'dmitry-sokolov', kind: 'info', brief: 'The pool fix reset the session TTL to the default; restoring 30 minutes.', lang: 'en' }] });
  const tDup = g.ticket({ storyline: S, label: P, project: 'SWL', title: 'Kundenportal: Anmeldung nicht möglich (Timeout)', created: at(wd(5), '10:05'), reporter: 'marco-bernasconi', assignee: 'aleksandr-petrov',
    statuses: [{ at: at(wd(5), '10:05'), status: 'Open' }, { at: at(wd(5), '10:40'), status: 'Duplicate' }],
    brief: 'Mehrere Mitarbeitende können sich nicht im Portal anmelden.', kind: 'incident', noise: ['ticket_duplicate'],
    comments: [{ ts: at(wd(5), '10:40'), by: 'tobias-hofer', kind: 'info', brief: `Schliesst als Duplikat von ${tLogin.keys[0]}.`, required: [tLogin.keys[0]!] }] });
  for (const x of [tLogin, tDup]) Object.assign(g.tins.get(x.id)!, { cluster: 'tdup-swl-login', dedupType: 'ticket_duplicate' as DedupType, canonical: x === tLogin });
  g.thread('ext-swl', wd(5), '08:12', [
    { by: 'tobin-berger', kind: 'incident', brief: 'Meldet, dass sich seit heute früh viele Kunden nicht mehr im Portal anmelden können (Timeout).', addressee: to(['tobias-hofer'], 'implicit', { side: 'brightwell' }) },
    { by: 'tobias-hofer', kind: 'answer', brief: `Bestätigt, das Team schaut es an, Ticket ${tLogin.keys[0]}.`, keys: [tLogin.keys[0]!] },
    { by: 'aleksandr-petrov', kind: 'info', brief: 'First analysis: the session store is overloaded, raising the connection pool now.', lang: 'en' },
    { by: 'marco-bernasconi', kind: 'question', brief: 'Fragt, ob man auf der Startseite einen Störungshinweis schalten soll.', addressee: to(['tobias-hofer']) },
    { by: 'tobias-hofer', kind: 'answer', brief: 'Ja, Banner ist vorbereitet und geht in zehn Minuten live.' },
    { by: 'tobin-berger', kind: 'question', brief: 'Fragt nach einer Prognose, wann es wieder geht.', gap: 120, addressee: to(['aleksandr-petrov']) },
    { by: 'aleksandr-petrov', kind: 'answer', brief: 'Load is back to normal, logins work again; the permanent fix follows tomorrow.', lang: 'en', gap: 30 },
  ], { storyline: S, label: P });
  // Cross-post: Mara pastes the ticket text into #ext-swl the next morning for the client's IT lead.
  g.slackMsg({ storyline: S, label: P, kind: 'info', ch: 'ext-swl', ts: at(wd(6), '08:05'), by: 'mara-keller', body: { derived: { from: tLogin.id, op: { prefix: `${tLogin.keys[0]} (Zusammenfassung aus dem Ticket):\n` } } }, noise: ['crosspost'], addressee: to(['marco-bernasconi'], 'implicit', { side: 'swl' }), cluster: 'xp-swl-login', dedupType: 'crosspost', canonical: false });
  Object.assign(g.tins.get(tLogin.id)!, { cluster: 'tdup-swl-login' });
  g.call({ storyline: S, title: 'SWL Incident Login-Timeouts', day: wd(8), start: '16:00', minutes: 45, recorders: ['granola', 'wispr'],
    attendees: ['mara-keller', 'tobias-hofer', 'aleksandr-petrov', 'dmitry-sokolov', 'tobin-berger'],
    wispr: [['mara-keller', 'Mara Keller'], ['tobias-hofer', 'Tobais Hofer'], ['aleksandr-petrov', 'Sasha'], ['dmitry-sokolov', 'Dima S.'], ['tobin-berger', 'Tobin Berger']],
    topics: [{ heading: 'Login-Timeouts', share: 1, label: P, brief: 'Timeline of the outage, root cause in the session store, the permanent fix and communication to customers.' }],
    nextSteps: [
      { owner: 'aleksandr-petrov', brief: 'move the session store to a bigger instance', due: '2026-09-18', commit: 'kept', to: ['tobin-berger'] },
      { owner: 'tobias-hofer', brief: 'send the incident report to SWL', due: '2026-09-22', commit: 'kept', to: ['marco-bernasconi'] },
    ],
    brief: 'Incident review call with SWL about the login timeouts.', lang: 'de' });
  const rep = g.mailThread('work', 'Incident-Report Login-Störung KW 38', wd(10), '14:00', [
    { by: 'tobias-hofer', to: ['marco-bernasconi'], cc: ['mara-keller', 'tobin-berger'], kind: 'info', brief: 'Sends the incident report: start 07:40, impact, root cause, measures, 2 hours 20 minutes outage.', required: ['07:40'], addressee: to(['marco-bernasconi'], 'explicit') },
  ], { storyline: S, label: P });
  g.kept('send the incident report to SWL', rep[0]!.id);
  g.thread('ext-swl', wd(10), '09:30', [
    { by: 'marco-bernasconi', kind: 'request', brief: 'Bittet um den schriftlichen Incident-Report für die Geschäftsleitung.', mention: ['tobias-hofer'], addressee: to(['tobias-hofer'], 'explicit') },
    { by: 'tobias-hofer', kind: 'commitment', brief: 'Sagt den Bericht bis heute Nachmittag zu.', commit: { owner: 'tobias-hofer', to: ['marco-bernasconi'], due: '2026-09-21', outcome: 'kept', what: 'incident report by this afternoon' } },
  ], { storyline: S, label: P });
  g.kept('incident report by this afternoon', rep[0]!.id);
  // Procurement: SLA penalty + retainer PO → swl/admin (Andrea is not in the people file; role mailbox).
  g.mailThread('work', 'SLA-Pönale Login-Störung KW 38', wd(12), '10:20', [
    { by: 'andrea-fischer', fromRaw: 'einkauf@stadtwerke-lindquell.example', to: ['mara-keller'], cc: ['marco-bernasconi'], kind: 'request', brief: 'Formally claims the SLA penalty under clause 7.2 for the outage: 5 percent of the monthly fee of CHF 9,600, i.e. CHF 480, to be credited on the next invoice.', required: ['7.2', 'CHF 480'] },
    { by: 'mara-keller', to: ['andrea.fischer@stadtwerke-lindquell.example'], cc: ['jonas-brandt', 'marco-bernasconi'], kind: 'answer', brief: 'Acknowledges the claim and confirms the credit on the October invoice.', gap: 200 },
    { by: 'andrea-fischer', to: ['mara-keller'], kind: 'noise', brief: 'Short thanks, closes the matter.', gap: 1300 },
  ], { storyline: S, label: ADM, reply: 'AW', noise: ['identity_variant'] });
  g.mailThread('work', 'Bestellung Q4 – Retainer Kundenportal', wd(16), '09:10', [
    { by: 'andrea-fischer', to: ['mara-keller'], cc: ['sophie-laurent'], kind: 'info', brief: 'Sends the purchase order 4500012345 for the Q4 retainer, 60 hours per month, and asks to quote the PO number on every invoice.', required: ['4500012345'] },
    { by: 'sophie-laurent', to: ['andrea-fischer'], cc: ['mara-keller'], kind: 'answer', brief: 'Confirms the PO number will be on all Q4 invoices.', gap: 160 },
  ], { storyline: S, label: ADM, reply: 'AW' });
  g.call({ storyline: S, title: 'Jour fixe SWL', day: wd(12), start: '10:00', minutes: 45, recorders: ['granola'], attendees: ['mara-keller', 'tobias-hofer', 'marco-bernasconi', 'tobin-berger'], recurring: true,
    topics: [
      { heading: 'Kundenportal: Stabilität nach dem Incident', share: 0.6, label: P, brief: 'Session TTL back to 30 minutes, monitoring, the banner, open tickets.' },
      { heading: 'SLA-Pönale und Bestellung Q4', share: 0.4, label: ADM, brief: 'Credit of the penalty on the October invoice, the PO for Q4 is on its way.' },
    ],
    nextSteps: [{ owner: 'tobias-hofer', brief: 'share the monitoring dashboard with SWL IT', due: '2026-09-25', commit: 'kept', to: ['marco-bernasconi'] }],
    brief: 'Weekly SWL jour fixe after the incident.', lang: 'de', noise: ['multi_initiative'] });
  g.call({ storyline: S, title: 'Jour fixe SWL', day: wd(17), start: '10:00', minutes: 30, recorders: ['granola'], attendees: ['mara-keller', 'tobias-hofer', 'marco-bernasconi'], recurring: true,
    topics: [{ heading: 'Kundenportal', share: 1, label: P, brief: 'Release 3.2 of the portal, address change form, invoice download.' }],
    nextSteps: [{ owner: 'mara-keller', brief: 'propose a date for the portal release 3.2', due: '2026-10-02', commit: 'open', to: ['marco-bernasconi'] }],
    brief: 'Weekly SWL jour fixe.', lang: 'de' });
  g.patterns.push({ pattern_id: 'p-swl-login', initiative: P, members: [tLogin.ref, tReset.ref, tSess.ref, tDup.ref], first_seen: wd(5), last_seen: wd(10), note: 'login timeouts: 3 tickets + duplicate + alert burst + 2 threads' });
}

function s4MedTrack(g: Gen): void {
  const S = 's4-medtrack';
  const M = 'medtrack/app';
  const push = g.ticket({ storyline: S, label: M, project: 'MT', title: 'Android: push notifications not delivered after app update', created: at(wd(1), '09:30'), reporter: 'priya-nair', assignee: 'dmitry-sokolov',
    statuses: [{ at: at(wd(1), '09:30'), status: 'To Do' }, { at: at(wd(2), '10:00'), status: 'In Progress' }, { at: at(wd(9), '15:00'), status: 'In Review' }, { at: at(wd(12), '11:00'), status: 'Done' }],
    brief: 'After updating to 2.3.1 on Android, reminder pushes no longer arrive until the app is opened once; affects Android 13 and 14.', kind: 'incident',
    comments: [
      { ts: at(wd(2), '10:02'), by: 'dmitry-sokolov', kind: 'question', brief: 'Asks whether the device token is refreshed after the update in their logs.' },
      { ts: at(wd(2), '15:40'), by: 'priya-nair', kind: 'answer', brief: 'The token changes after the update but the old one is still used for a day.' },
      { ts: at(wd(3), '11:00'), by: 'daniel-weber', kind: 'request', brief: 'Asks for a root cause before the sprint review.' },
      { ts: at(wd(8), '17:30'), by: 'dmitry-sokolov', kind: 'info', brief: 'Fix: the backend now replaces stale tokens on the first heartbeat; in review.' },
      { ts: at(wd(12), '10:55'), by: 'priya-nair', kind: 'info', brief: 'Verified on four devices, closing.' },
    ] });
  g.ticket({ storyline: S, label: M, project: 'MT', title: 'iOS: badge count wrong after reading a reminder', created: at(wd(3), '14:00'), reporter: 'yulia-kuznetsova', assignee: 'marco-rossi',
    statuses: [{ at: at(wd(3), '14:00'), status: 'To Do' }, { at: at(wd(5), '09:00'), status: 'In Progress' }, { at: at(wd(13), '16:00'), status: 'Done' }],
    brief: 'The badge on the app icon still shows a count after the reminder has been read in the app.', kind: 'incident',
    comments: [{ ts: at(wd(13), '15:58'), by: 'marco-rossi', kind: 'info', brief: 'Fixed in build 112, now resetting the badge when the reminder list is opened.' }] });
  g.thread('ext-medtrack', wd(1), '10:15', [
    { by: 'yulia-kuznetsova', kind: 'question', brief: `Asks whether anyone at Brightwell can look at ${push.keys[0]} today, patients are missing their reminders.`, keys: [push.keys[0]!], addressee: to(['dmitry-sokolov'], 'implicit', { side: 'brightwell' }) },
    { by: 'dmitry-sokolov', kind: 'answer', brief: 'Taking it, first suspicion is stale device tokens after the update.' },
    { by: 'marco-rossi', kind: 'info', brief: 'On iOS everything looks fine, so it is Android only.', opaque: true },
  ], { storyline: S, label: M });
  g.thread('ext-medtrack', wd(4), '16:30', [
    { by: 'daniel-weber', kind: 'question', brief: 'Asks for the status of the push problem and whether the fix is backend or app side.', mention: ['dmitry-sokolov'], addressee: to(['dmitry-sokolov'], 'explicit') },
    { by: 'dmitry-sokolov', kind: 'answer', brief: 'Backend side; fix ready early next week.' },
    { by: 'mara-keller', kind: 'commitment', brief: 'Adds that she will share the release plan for 2.4 with the push fix by Tuesday.', commit: { owner: 'mara-keller', to: ['daniel-weber', 'yulia-kuznetsova'], due: '2026-09-15', outcome: 'kept', what: 'release plan 2.4 with the push fix' } },
  ], { storyline: S, label: M });
  // Sprint review #1: gmeet + granola; glued Invited line incl. a Cyrillic chip.
  g.call({ storyline: S, title: 'MedTrack Sprint Review', titles: { gmeet: 'MedTrack – Sprint Review 18' }, day: wd(4), start: '14:00', minutes: 60, recorders: ['gmeet', 'granola'],
    attendees: ['mara-keller', 'yulia-kuznetsova', 'daniel-weber', 'marco-rossi', 'dmitry-sokolov', 'hanna-lindqvist'], organizer: 'yulia-kuznetsova',
    chips: [['mara-keller', 'Mara Keller'], ['yulia-kuznetsova', 'Iuliia Kuznetsova'], ['daniel-weber', 'Daniel Weber']],
    topics: [
      { heading: 'Sprint 18 Ergebnisse', share: 0.6, label: M, brief: 'Demo of the reminder screen, the open push bug on Android, iOS badge bug.' },
      { heading: 'Release 2.4', share: 0.4, label: M, brief: 'Scope and date of release 2.4, store texts.' },
    ],
    nextSteps: [
      { owner: 'mara-keller', brief: 'share the release plan for 2.4', due: '2026-09-15', commit: 'kept', to: ['yulia-kuznetsova'] },
      { owner: 'mara-keller', brief: 'check the push service quota with Aleksandr', due: '2026-09-18', commit: 'open', to: ['daniel-weber'] },
      { owner: 'marco-rossi', brief: 'submit the iOS build to TestFlight', due: '2026-09-16', commit: 'kept', to: ['yulia-kuznetsova'] },
    ],
    brief: 'Sprint review 18 with MedTrack.', lang: 'en' });
  const plan = g.mailThread('work', 'Release plan 2.4', wd(6), '17:40', [
    { by: 'mara-keller', to: ['yulia-kuznetsova', 'daniel-weber'], cc: ['marco-rossi'], kind: 'info', brief: 'Shares the release plan for 2.4: push fix, badge fix, reminder screen; store submission on 1 October.', required: ['1 Oct'] },
    { by: 'yulia-kuznetsova', to: ['mara-keller'], kind: 'question', brief: 'Asks whether the dark mode fixes could also make it into 2.4.', gap: 300 },
    { by: 'mara-keller', to: ['yulia-kuznetsova'], kind: 'answer', brief: 'Only if they are approved by Friday; otherwise 2.5.', gap: 900 },
  ], { storyline: S, label: M });
  g.kept('share the release plan for 2.4', plan[0]!.id);
  g.kept('release plan 2.4 with the push fix', plan[0]!.id);
  // Sprint review #2: gmeet only, glued chips with an e-mail (→ stored in the email field), transliterations.
  g.call({ storyline: S, title: 'MedTrack – Sprint Review 19', day: wd(14), start: '14:00', minutes: 50, recorders: ['gmeet'],
    attendees: ['mara-keller', 'yulia-kuznetsova', 'daniel-weber', 'priya-nair', 'marco-rossi', 'olga-ivanova'], organizer: 'yulia-kuznetsova',
    chips: [['yulia-kuznetsova', 'Julia Kusnezowa'], ['mara-keller', 'Mara Keller'], ['priya-nair', 'priya.nair@medtrack.example']],
    topics: [
      { heading: 'Sprint 19 Demo', share: 0.7, label: M, brief: 'Push fix verified, badge fix, crash on Android 14 in the diary.' },
      { heading: 'Planning sprint 20', share: 0.3, label: M, brief: 'Dark mode, onboarding skip button, release 2.4 submission.' },
    ],
    nextSteps: [
      { owner: 'mara-keller', brief: 'confirm the store submission date with Yulia', due: '2026-09-29', commit: 'kept', to: ['yulia-kuznetsova'] },
      { owner: 'priya-nair', brief: 'retest the diary crash on Android 14', due: '2026-09-29', commit: 'open', to: ['dmitry-sokolov'] },
    ],
    brief: 'Sprint review 19 with MedTrack.', lang: 'en' });
  // A second Android push report one week later (near repeat of the first, different reporter wording).
  const again = g.ticket({ storyline: S, label: M, project: 'MT', title: 'Android: push notifications missing after update (again)', created: at(wd(15), '09:10'), reporter: 'priya-nair', assignee: 'dmitry-sokolov',
    statuses: [{ at: at(wd(15), '09:10'), status: 'To Do' }, { at: at(wd(15), '13:00'), status: 'Done' }],
    brief: 'Two testers again report missing pushes after updating to the 2.4 beta.', kind: 'incident', noise: ['ticket_duplicate'],
    comments: [{ ts: at(wd(15), '12:58'), by: 'dmitry-sokolov', kind: 'answer', brief: `Same root cause as ${push.keys[0]}: the beta build predates the backend fix; closing.`, required: [push.keys[0]!] }] });
  for (const x of [push, again]) Object.assign(g.tins.get(x.id)!, { cluster: 'tdup-mt-push', dedupType: 'ticket_duplicate' as DedupType, canonical: x === push });
  g.call({ storyline: S, title: 'MedTrack TestFlight Abstimmung', day: wd(11), start: '16:30', minutes: 30, recorders: ['gmeet'], attendees: ['mara-keller', 'marco-rossi', 'yulia-kuznetsova'], organizer: 'yulia-kuznetsova',
    chips: [['yulia-kuznetsova', 'Юлия Кузнецова'], ['mara-keller', 'Mara Keller']],
    topics: [{ heading: 'TestFlight', share: 1, label: M, brief: 'Who gets TestFlight access, build 112 feedback, crash reports from testers.' }],
    nextSteps: [{ owner: 'marco-rossi', brief: 'add the MedTrack testers to TestFlight', due: '2026-09-23', commit: 'kept', to: ['yulia-kuznetsova'] }],
    brief: 'Short call about TestFlight testing of the iOS app.', lang: 'en' });
  g.patterns.push({ pattern_id: 'p-mt-push', initiative: M, members: [push.ref, again.ref], first_seen: wd(1), last_seen: wd(15), note: 'Android push not delivered after update: Jira + Slack + sprint reviews' });
}

function s5KlarText(g: Gen): void {
  const S = 's5-klartext';
  const K = 'klartext/content-hub';
  // Before the rename: CMS migration (KT keys, #ext-klartext-cms, repo klartext-cms) — same initiative by alias.
  const imp = g.ticket({ storyline: S, label: K, project: 'KT', title: 'Artikelimport aus Alt-CMS: Umlaute', created: at(wd(2), '10:00'), reporter: 'ines-wolf', assignee: 'olga-ivanova',
    statuses: [{ at: at(wd(2), '10:00'), status: 'Open' }, { at: at(wd(3), '09:00'), status: 'In Progress' }, { at: at(wd(13), '15:00'), status: 'Fixed' }],
    brief: 'Beim Testimport werden Umlaute in Titeln falsch dargestellt (z. B. "MÃ¼nchen").', kind: 'incident', noise: ['rename'],
    comments: [
      { ts: at(wd(3), '09:05'), by: 'olga-ivanova', kind: 'info', brief: 'Das Alt-CMS exportiert Latin-1, wir konvertieren jetzt beim Import.' },
      { ts: at(wd(13), '14:55'), by: 'olga-ivanova', kind: 'info', brief: 'Zweiter Testimport ohne Fehler, 12 400 Artikel.', required: ['12 400'] },
    ] });
  g.thread('ext-klartext-cms', wd(2), '11:10', [
    { by: 'paul-keller', kind: 'question', brief: 'Fragt, wann der zweite Testimport der Artikel geplant ist.', addressee: to(['tobias-hofer'], 'implicit', { side: 'brightwell' }) },
    { by: 'tobias-hofer', kind: 'answer', brief: `Nach dem Fix für ${imp.keys[0]}, voraussichtlich in zwei Wochen.`, keys: [imp.keys[0]!] },
  ], { storyline: S, label: K, noise: ['rename'] });
  // Rename day: the client announces the new name; channel, keys and repo follow.
  g.mailThread('work', 'Neuer Projektname: Content Hub', RENAME_DAY, '08:05', [
    { by: 'paul-keller', to: ['tobias-hofer', 'mara-keller'], kind: 'info', brief: 'Informs that the project is renamed from CMS migration to "Content Hub" effective today, because it now includes newsletters and dossiers.', required: ['Content Hub'] },
    { by: 'tobias-hofer', to: ['paul-keller'], cc: ['mara-keller'], kind: 'answer', brief: 'Confirms the rename of the Slack channel, the YouTrack project key and the repository.', gap: 75 },
  ], { storyline: S, label: K, noise: ['rename'] });
  g.thread('ext-klartext-cms', RENAME_DAY, '09:45', [
    { by: 'tobias-hofer', kind: 'info', brief: 'Announces in the (renamed) channel that tickets now carry the KH key and the channel name changed.', required: ['KH'], addressee: nobody({ broadcast: true }) },
    { by: 'ines-wolf', kind: 'noise', brief: 'Thumbs up, thanks for the info.', addressee: nobody() },
  ], { storyline: S, label: K, noise: ['rename'] });
  g.call({ storyline: S, title: 'Content Hub – Workshop', titles: { gmeet: 'Content Hub Workshop' }, day: RENAME_DAY, start: '14:00', minutes: 90, recorders: ['granola', 'gmeet'],
    attendees: ['mara-keller', 'tobias-hofer', 'paul-keller', 'ines-wolf', 'olga-ivanova'],
    chips: [['mara-keller', 'Mara Keller'], ['paul-keller', 'Paul Keller'], ['olga-ivanova', 'Ольга Иванова']],
    topics: [{ heading: 'Content-Modell und Workflow', share: 1, label: K, brief: 'Content model for dossiers, author profiles, image rights field, editorial approval step.' }],
    nextSteps: [
      { owner: 'olga-ivanova', brief: 'build the dossier content type', due: '2026-09-30', commit: 'kept', to: ['ines-wolf'] },
      { owner: 'tobias-hofer', brief: 'send the updated project plan for the content hub', due: '2026-09-25', commit: 'kept', to: ['paul-keller'] },
    ],
    brief: 'Workshop on the renamed content hub project.', lang: 'de', noise: ['rename'] });
  g.ticket({ storyline: S, label: K, project: 'KT', title: 'Bildrechte-Feld im Content-Modell', created: at(wd(12), '16:00'), reporter: 'ines-wolf', assignee: 'olga-ivanova',
    statuses: [{ at: at(wd(12), '16:00'), status: 'Open' }, { at: at(wd(15), '10:00'), status: 'In Progress' }], brief: 'Jedes Bild braucht ein Pflichtfeld für Bildrechte und Ablaufdatum.', kind: 'request', noise: ['rename'],
    comments: [{ ts: at(wd(15), '10:05'), by: 'olga-ivanova', kind: 'question', brief: 'Fragt, ob das Ablaufdatum optional sein darf.' }] });
  g.thread('ext-klartext-cms', wd(15), '10:30', [
    { by: 'ines-wolf', kind: 'request', brief: 'Bittet darum, im Hub eine Vorschau für Dossiers zu bauen, bevor die Redaktion testet.', addressee: to(['olga-ivanova'], 'implicit', { side: 'brightwell' }) },
    { by: 'olga-ivanova', kind: 'commitment', brief: 'Sagt die Vorschau bis Mittwoch zu.', commit: { owner: 'olga-ivanova', to: ['ines-wolf'], due: '2026-09-30', outcome: 'kept', what: 'dossier preview' } },
  ], { storyline: S, label: K, noise: ['rename'] });
}

function s6Internal(g: Gen): void {
  const S = 's6-internal';
  const HM = 'unregistered:hosting-migration';
  const ZP = 'unregistered:zermatt-pitch';
  // Monday standups: 4–6 topics across clients; split by section share.
  const standups: { day: string; recorders: ('granola' | 'gmeet')[]; late?: boolean; chips: [string, string][]; topics: CallIn['topics'] }[] = [
    { day: wd(0), recorders: ['gmeet', 'granola'], chips: [['mara-keller', 'Mara Keller'], ['lea-vogt', 'Lea Vogt'], ['tobias-hofer', 'Tobias Hofer']], topics: [
      { heading: 'Alpenhof Relaunch', share: 0.3, label: 'alpenhof/relaunch', brief: 'Redirects, spa page, go-live 24.09.' },
      { heading: 'SWL Portal', share: 0.15, label: 'swl/portal', brief: 'Invoice download bug, release 3.2.' },
      { heading: 'MedTrack', share: 0.2, label: 'medtrack/app', brief: 'New Android push bug.' },
      { heading: 'Booker', share: 0.2, label: 'brightwell/booker', brief: 'Release 1.9 scope, rate plans.' },
      { heading: 'Hosting-Umzug', share: 0.15, label: HM, brief: 'Nordhost offer, call on Thursday.' },
    ] },
    { day: wd(5), recorders: ['gmeet'], chips: [['mara-keller', 'Mara Keller']], topics: [
      { heading: 'SWL Login-Störung', share: 0.35, label: 'swl/portal', brief: 'Outage this morning, who is on it.' },
      { heading: 'Velo Nord ERP', share: 0.25, label: 'velonord/erp-sync', brief: 'Stock sync lag.' },
      { heading: 'Alpenhof', share: 0.25, label: 'alpenhof/relaunch', brief: 'Go-live prep call Tuesday.' },
      { heading: 'Bewerbungen', share: 0.15, label: 'brightwell/hiring', brief: 'Interview with the backend candidate on Wednesday.' },
    ] },
    { day: wd(10), recorders: ['gmeet', 'granola'], chips: [['dmitry-sokolov', 'Дмитрий Соколов'], ['mara-keller', 'Mara Keller'], ['olga-ivanova', 'Olga I.']], topics: [
      { heading: 'Alpenhof Go-Live', share: 0.25, label: 'alpenhof/relaunch', brief: 'Spa page late, decision tomorrow.' },
      { heading: 'Kieselfeder Umbenennung', share: 0.15, label: 'klartext/content-hub', brief: 'Rename to content hub on Wednesday.' },
      { heading: 'Pitch Zermatt', share: 0.2, label: ZP, brief: 'Pitch on 1 October, deck owners.' },
      { heading: 'MedTrack', share: 0.15, label: 'medtrack/app', brief: 'Push fix in review.' },
      { heading: 'Nordhost Migration', share: 0.15, label: HM, brief: 'Staging cluster ready, DNS TTLs.' },
      { heading: 'Booker Support', share: 0.1, label: 'brightwell/booker-support', brief: 'Double booking at one hotel.' },
    ] },
    { day: wd(15), recorders: ['gmeet'], late: true, chips: [['mara-keller', 'Mara Keller'], ['aleksandr-petrov', 'Alexander Petrov']], topics: [
      { heading: 'Alpenhof Go-Live Dienstag', share: 0.35, label: 'alpenhof/relaunch', brief: 'Go-live tomorrow, DNS 07:00.' },
      { heading: 'Velo Nord Händlerportal', share: 0.2, label: 'unregistered:velonord-b2b-portal', brief: 'Intro call Tuesday.' },
      { heading: 'Pitch Zermatt', share: 0.25, label: ZP, brief: 'Demo app, rehearsal Wednesday.' },
      { heading: 'SWL Release 3.2', share: 0.2, label: 'swl/portal', brief: 'Release date proposal.' },
    ] },
  ];
  for (const s of standups) {
    const chips = s.chips;
    g.call({ storyline: S, title: 'Montags-Standup', titles: { gmeet: 'Weekly Standup Brightwell' }, day: s.day, start: '09:00', minutes: 30, recorders: s.recorders, late: s.late, recurring: true,
      attendees: ['mara-keller', 'jonas-brandt', 'lea-vogt', 'tobias-hofer', 'dmitry-sokolov', 'aleksandr-petrov', 'olga-ivanova'], organizer: 'jonas-brandt', chips,
      topics: s.topics, nextSteps: [{ owner: 'lea-vogt', brief: 'update the project board after the standup', due: null }],
      brief: 'Weekly internal standup, one section per client/topic.', lang: 'de', noise: ['multi_initiative'] });
  }
  // Hosting migration (unregistered): vendor call, mails, #dev threads, OPS tickets (key routes to infra — wrong).
  g.call({ storyline: S, title: 'Nordhost – managed Kubernetes', eventTitle: 'Hosting: Nordhost call', day: wd(3), start: '16:00', minutes: 45, recorders: ['wispr'],
    attendees: ['mara-keller', 'aleksandr-petrov', 'dmitry-sokolov', 'lars-eriksen'], organizer: 'lars-eriksen',
    wispr: [['mara-keller', 'Mara Keller'], ['aleksandr-petrov', 'Alexander Petrov'], ['dmitry-sokolov', 'Dmitrii Sokolov'], ['lars-eriksen', 'Lars Eriksen']],
    topics: [
      { heading: 'Migration plan', share: 0.7, label: HM, brief: 'Moving all client sites to Nordhost managed Kubernetes, timeline, cutover weekends.' },
      { heading: 'Current CI and backups', share: 0.3, label: 'brightwell/infra', brief: 'What stays on the current CI runners and backup retention.' },
    ],
    nextSteps: [
      { owner: 'lars-eriksen', brief: 'send the contract draft and pricing', due: '2026-09-15', commit: 'kept', to: ['mara-keller'] },
      { owner: 'aleksandr-petrov', brief: 'set up the staging cluster at Nordhost', due: '2026-09-22', commit: 'kept', to: ['mara-keller'] },
    ],
    brief: 'Vendor call with Nordhost about moving the hosting.', lang: 'en', noise: ['unregistered', 'multi_initiative'] });
  const nh = g.mailThread('work', 'Nordhost: offer for managed Kubernetes', wd(5), '11:30', [
    { by: 'lars-eriksen', to: ['mara-keller'], cc: ['aleksandr-petrov'], kind: 'info', brief: 'Sends the offer and the contract draft: three-node cluster, managed databases, EUR 1,850 per month, 24-month term.', required: ['EUR 1,850'] },
    { by: 'mara-keller', to: ['lars-eriksen'], cc: ['aleksandr-petrov', 'jonas-brandt'], kind: 'question', brief: 'Asks whether a 12-month term is possible and what the exit terms are.', gap: 240 },
    { by: 'lars-eriksen', to: ['mara-keller'], kind: 'answer', brief: 'A 12-month term is possible with a 6 percent surcharge; exit with full data export.', gap: 1200 },
  ], { storyline: S, label: HM, noise: ['unregistered'] });
  g.kept('send the contract draft and pricing', nh[0]!.id);
  g.thread('dev', wd(7), '10:40', [
    { by: 'aleksandr-petrov', kind: 'info', brief: 'Staging cluster at Nordhost is up; first test deployment of the status page worked.', addressee: nobody({ broadcast: true }) },
    { by: 'dmitry-sokolov', kind: 'question', brief: 'Asks how database migrations will run during the cutover.', addressee: to(['aleksandr-petrov']) },
    { by: 'aleksandr-petrov', kind: 'answer', brief: 'Dump and restore per client during the cutover window, dry run next week.' },
    { by: 'mara-keller', kind: 'request', brief: 'Asks Aleksandr to write down the cutover order of the client sites.', mention: ['aleksandr-petrov'], addressee: to(['aleksandr-petrov'], 'explicit') },
  ], { storyline: S, label: HM, noise: ['unregistered'] });
  g.ticket({ storyline: S, label: HM, project: 'OPS', title: 'Nordhost: set up the staging cluster', created: at(wd(4), '09:00'), reporter: 'mara-keller', assignee: 'aleksandr-petrov',
    statuses: [{ at: at(wd(4), '09:00'), status: 'Open' }, { at: at(wd(5), '09:00'), status: 'In Progress' }, { at: at(wd(7), '10:30'), status: 'Done' }], brief: 'Create the staging cluster at Nordhost with the same namespaces as today.', kind: 'request', noise: ['unregistered'],
    comments: [{ ts: at(wd(7), '10:31'), by: 'aleksandr-petrov', kind: 'info', brief: 'Cluster ready, credentials in the vault entry "nordhost-staging".' }] });
  g.ticket({ storyline: S, label: HM, project: 'OPS', title: 'Lower DNS TTLs before the move', created: at(wd(9), '14:00'), reporter: 'aleksandr-petrov', assignee: 'aleksandr-petrov',
    statuses: [{ at: at(wd(9), '14:00'), status: 'Open' }, { at: at(wd(13), '09:00'), status: 'In Progress' }], brief: 'Lower the TTL of all client DNS records to 300 seconds one week before the first cutover weekend.', kind: 'request', noise: ['unregistered'] });
  // Hiring: private channel + candidate mails + interviews.
  g.thread('hiring', wd(1), '13:20', [
    { by: 'jonas-brandt', kind: 'info', brief: 'Two good applications for the backend role, CVs in the drive; proposes interviews next week.', addressee: nobody({ broadcast: true }) },
    { by: 'mara-keller', kind: 'answer', brief: 'Takes the technical interviews; Wednesday or Thursday afternoon work for her.' },
  ], { storyline: S, label: 'brightwell/hiring' });
  const app = g.mailThread('work', 'Application: Backend Developer – Tim Novak', wd(1), '07:55', [
    { by: 'tim-novak', to: ['jonas-brandt'], cc: [LIST_ADDR], kind: 'info', brief: 'Applies for the backend developer position, five years of PHP and Go, available from November.' },
    { by: 'mara-keller', to: ['tim-novak'], cc: ['jonas-brandt'], kind: 'question', brief: 'Invites him to an interview and asks whether Wednesday 16 September at 11:00 works.', required: ['16 Sep', '11:00'], gap: 1500 },
    { by: 'tim-novak', to: ['mara-keller'], kind: 'answer', brief: 'Confirms the interview slot.', gap: 200 },
  ], { storyline: S, label: 'brightwell/hiring' });
  // The application also arrived via the team list (exact duplicate).
  g.mailMsg({ storyline: S, label: 'brightwell/hiring', kind: 'info', acct: 'work', ts: addMin(app[0]!.ts, 1), by: 'tim-novak', to: [LIST_ADDR], subject: 'Application: Backend Developer – Tim Novak', threadOf: app[0], body: { derived: { from: app[0]!.id, op: {} } }, noise: ['exact_dup'], addressee: to(['jonas-brandt']), cluster: 'dup-app-tim', dedupType: 'exact', canonical: false });
  Object.assign(g.tins.get(app[0]!.id)!, { cluster: 'dup-app-tim', dedupType: 'exact' as DedupType, canonical: true });
  g.call({ storyline: S, title: 'Interview Tim Novak (Backend)', day: wd(7), start: '11:00', minutes: 45, recorders: ['granola'], attendees: ['mara-keller', 'jonas-brandt', 'tim-novak'],
    topics: [{ heading: 'Interview', share: 1, label: 'brightwell/hiring', brief: 'Technical interview: experience, a design question about booking availability, expectations.' }],
    nextSteps: [{ owner: 'jonas-brandt', brief: 'send feedback to Tim by Friday', due: '2026-09-18', commit: 'kept', to: ['tim-novak'] }], brief: 'Interview with a backend developer candidate.', lang: 'en' });
  g.mailThread('work', 'Application Frontend Developer', wd(6), '20:10', [
    { by: 'elena-popescu', to: ['jonas-brandt'], kind: 'info', brief: 'Applies for the frontend role with a portfolio link.' },
    { by: 'jonas-brandt', to: ['elena-popescu'], cc: ['mara-keller'], kind: 'question', brief: 'Invites her to an interview on 24 September at 13:30.', required: ['24 Sep', '13:30'], gap: 900 },
  ], { storyline: S, label: 'brightwell/hiring' });
  g.call({ storyline: S, title: 'Interview Elena Popescu (Frontend)', day: wd(13), start: '13:30', minutes: 45, recorders: ['granola'], attendees: ['mara-keller', 'nina-brunner', 'elena-popescu'],
    topics: [{ heading: 'Interview', share: 1, label: 'brightwell/hiring', brief: 'Portfolio review, accessibility, collaboration with design.' }],
    nextSteps: [{ owner: 'mara-keller', brief: 'invite Elena to a trial day', due: '2026-09-30', commit: 'open', to: ['elena-popescu'] }], brief: 'Interview with a frontend developer candidate.', lang: 'en' });
  // Zermatt pitch (unregistered): #sales threads, mails with the prospect, the pitch call, a demo deploy.
  g.mailThread('work', 'Pitch Zermatt Alpine Resorts – Briefing', wd(9), '09:40', [
    { by: 'laura-imhof', to: ['jonas-brandt'], cc: ['mara-keller'], kind: 'request', brief: 'Invites Brightwell to pitch for the new resort website on 1 October in Zermatt; briefing attached; asks for two hotel references.', required: ['1. Oktober'] },
    { by: 'jonas-brandt', to: ['laura-imhof'], cc: ['mara-keller'], kind: 'answer', brief: 'Confirms participation and names the Alpenhof relaunch and Booker as references.', gap: 180 },
  ], { storyline: S, label: ZP, noise: ['unregistered'], reply: 'AW' });
  g.thread('sales', wd(10), '14:15', [
    { by: 'jonas-brandt', kind: 'request', brief: 'Asks Nina and Mara to prepare the pitch deck and a small demo of a booking flow for Zermatt by next Wednesday.', mention: ['nina-brunner', 'mara-keller'], addressee: to(['nina-brunner', 'mara-keller'], 'explicit') },
    { by: 'nina-brunner', kind: 'commitment', brief: 'Takes the deck and the moodboard, first draft on Friday.', commit: { owner: 'nina-brunner', to: ['jonas-brandt'], due: '2026-09-25', outcome: 'kept', what: 'pitch deck draft' } },
    { by: 'mara-keller', kind: 'commitment', brief: 'Builds the demo on the Booker widget, deployed as a separate pitch demo app.', commit: { owner: 'mara-keller', to: ['jonas-brandt'], due: '2026-09-30', outcome: 'kept', what: 'Zermatt demo app' } },
  ], { storyline: S, label: ZP, noise: ['unregistered'] });
  g.call({ storyline: S, title: 'Pitch Zermatt Alpine Resorts', eventTitle: 'Pitch Zermatt (vor Ort)', day: wd(18), start: '10:00', minutes: 60, recorders: ['wispr'], attendees: ['mara-keller', 'jonas-brandt', 'nina-brunner', 'laura-imhof'], organizer: 'laura-imhof',
    wispr: [['mara-keller', 'Mara Keller'], ['jonas-brandt', 'JB'], ['nina-brunner', 'Nina Brunner'], ['laura-imhof', 'Laura Imhof']],
    topics: [{ heading: 'Pitch', share: 1, label: ZP, brief: 'Presentation of the concept, demo of the booking flow, questions about hosting and timeline.' }],
    nextSteps: [{ owner: 'jonas-brandt', brief: 'send the offer to Laura', due: '2026-10-07', commit: 'open', to: ['laura-imhof'] }],
    brief: 'The pitch at Zermatt Alpine Resorts.', lang: 'de', noise: ['unregistered', 'over_broad_title'] });
  // Admin: VAT, payroll, insurance (brightwell/admin) — Petra is the exclusive admin marker.
  g.mailThread('work', 'MWST-Abrechnung Q3', wd(13), '08:40', [
    { by: 'petra-schmid', to: ['mara-keller'], cc: ['sophie-laurent'], kind: 'request', brief: 'Asks for the missing receipts for the Q3 VAT return by 30 September.', required: ['30.09.'] },
    { by: 'sophie-laurent', to: ['petra-schmid'], cc: ['mara-keller'], kind: 'answer', brief: 'Sends the receipts as a zip and lists two that are still missing.', gap: 400 },
  ], { storyline: S, label: 'brightwell/admin', reply: 'AW' });
  g.mailThread('work', 'Lohnlauf September', wd(17), '09:00', [
    { by: 'petra-schmid', to: ['mara-keller'], kind: 'question', brief: 'Asks whether the new apprentice’s salary starts in September and for his bank details.' },
    { by: 'mara-keller', to: ['petra-schmid'], cc: ['ivo-meier'], kind: 'answer', brief: 'Yes, from 7 September; Ivo sends the bank details himself.', gap: 50 },
  ], { storyline: S, label: 'brightwell/admin', reply: 'AW' });
  g.call({ storyline: S, title: 'Booker Demo Hotel Bergblick', day: wd(12), start: '15:30', minutes: 45, recorders: ['wispr'], attendees: ['mara-keller', 'lea-vogt', 'sebastian-kraus'], organizer: 'lea-vogt',
    wispr: [['mara-keller', 'Mara Keller'], ['lea-vogt', 'Lea Vogt'], ['sebastian-kraus', 'Sebastain Kraus']],
    topics: [{ heading: 'Doppelbuchungen', share: 1, label: 'brightwell/booker-support', brief: 'Walk through the double booking of the hotel, how the availability sync works, what support tells the hotel.' }],
    nextSteps: [{ owner: 'sebastian-kraus', brief: 'send the hotel a summary of the double-booking cause', due: '2026-09-25', commit: 'kept', to: ['lea-vogt'] }],
    brief: 'Internal walkthrough of a support case before calling the hotel.', lang: 'de' });
  // An Italian-speaking Booker pilot hotel writes to the support list (Mara is on it): the same rounding bug, seen
  // from the product side — booker-support, not the Alpenhof relaunch.
  const SUP = 'brightwell/booker-support';
  g.mailThread('work', 'Prezzi nel widget non arrotondati', wd(16), '11:20', [
    { by: 'giulia-ferri', to: ['support@brightwell.example'], kind: 'incident', brief: 'Reports that since this morning the booking widget on the hotel site shows prices like CHF 149.95 instead of CHF 150 and guests ask why.', required: ['CHF 149.95'], lang: 'it' },
    { by: 'sebastian-kraus', fromRaw: 'support@brightwell.example', to: ['giulia.ferri@albergo-riva.example'], cc: ['mara-keller'], kind: 'answer', brief: 'Answers in Italian that the problem is known, a fix is coming tomorrow at noon.', gap: 40, lang: 'it' },
    { by: 'giulia-ferri', to: ['support@brightwell.example'], kind: 'noise', brief: 'Thanks, short.', gap: 25, lang: 'it' },
  ], { storyline: S, label: SUP });
  g.ticket({ storyline: S, label: SUP, project: 'BKR', title: 'Albergo Riva: export prenotazioni settembre', created: at(wd(13), '09:40'), reporter: 'giulia-ferri', assignee: 'sebastian-kraus', labels: ['support'],
    statuses: [{ at: at(wd(13), '09:40'), status: 'Open' }, { at: at(wd(14), '10:00'), status: 'In Progress' }, { at: at(wd(15), '15:00'), status: 'Fixed' }],
    brief: 'Asks for an export of all September bookings with the channel and the payment status, for the accountant.', kind: 'request', lang: 'it',
    comments: [
      { ts: at(wd(14), '10:02'), by: 'sebastian-kraus', kind: 'question', brief: 'Asks whether cancelled bookings should be included.', lang: 'it' },
      { ts: at(wd(14), '11:30'), by: 'giulia-ferri', kind: 'answer', brief: 'Yes, with a separate column for cancellations.', lang: 'it' },
      { ts: at(wd(15), '14:58'), by: 'sebastian-kraus', kind: 'info', brief: 'Export attached as CSV.', lang: 'it' },
    ] });
  g.mailThread('work', 'Domanda: tariffe weekend ottobre', wd(18), '08:50', [
    { by: 'giulia-ferri', to: ['support@brightwell.example'], kind: 'question', brief: 'Asks how to set a weekend surcharge for October in Booker.', lang: 'it' },
  ], { storyline: S, label: SUP });
  g.mailThread('work', 'Betriebshaftpflicht – Verlängerung 2027', wd(8), '11:15', [
    { by: 'martin-kuehne', to: ['mara-keller'], kind: 'request', brief: 'Sends the renewal offer for the liability insurance and asks for the 2026 revenue estimate.' },
  ], { storyline: S, label: 'brightwell/admin' });
}

function s7Personal(g: Gen): void {
  const S = 's7-personal';
  const PP = 'personal/personal';
  g.mailThread('personal', 'Terminbestätigung Kontrolle', wd(2), '07:30', [
    { by: 'anna-frei', to: ['mara-keller'], kind: 'info', brief: 'Confirms the dental check-up on 17 September at 07:30.', required: ['17.09.', '07:30'] },
  ], { storyline: S, label: PP });
  g.mailThread('personal', 'Terminverschiebung', wd(7), '12:10', [
    { by: 'mara-keller', to: ['anna-frei'], kind: 'request', brief: 'Asks to move the check-up because of a client call.' },
    { by: 'anna-frei', to: ['mara-keller'], kind: 'answer', brief: 'Offers 1 October at 07:30 instead.', gap: 90, required: ['01.10.'] },
  ], { storyline: S, label: PP, reply: 'AW' });
  g.mailThread('personal', 'Besichtigung Wohnung Hottingen', wd(4), '18:20', [
    { by: 'beat-zimmermann', to: ['mara-keller'], kind: 'info', brief: 'Invites to a viewing of the 4.5-room apartment on Saturday 19 September at 10:00 and lists documents to bring.', required: ['10:00'] },
    { by: 'mara-keller', to: ['beat-zimmermann'], cc: ['stefan-keller'], kind: 'answer', brief: 'Confirms they come both.', gap: 120 },
    { by: 'beat-zimmermann', to: ['mara-keller'], kind: 'question', brief: 'After the viewing: asks whether they want to apply.', day: '2026-09-21', at: '09:10' },
    { by: 'mara-keller', to: ['beat-zimmermann'], kind: 'answer', brief: 'Yes, application follows this week.', day: '2026-09-21', at: '20:40' },
  ], { storyline: S, label: PP, reply: 'AW' });
  for (const [d, brief] of [[wd(3), 'Asks who picks up the kids on Friday.'], [wd(9), 'Reminds about the parents evening on Tuesday.'], [wd(14), 'Proposes dinner with friends on Saturday.'], [wd(18), 'Shares the apartment application form to sign.']] as const) {
    g.mailThread('personal', brief.split(' ').slice(0, 4).join(' '), d, '12:30', [
      { by: 'stefan-keller', to: ['mara-keller'], kind: d === wd(18) ? 'request' : 'question', brief },
      { by: 'mara-keller', to: ['stefan-keller'], kind: 'answer', brief: 'Short answer.', gap: 45, words: [3, 25] },
    ], { storyline: S, label: PP });
  }
}

function s8Ambiguity(g: Gen): void {
  const S = 's8-ambiguity';
  // Narrow-marker PM asks about "the widget fix" — Alpenhof page vs Booker product; content decides (booker).
  g.thread('dm:@lea', wd(17), '16:45', [
    { by: 'lea-vogt', kind: 'question', brief: 'Asks whether the widget fix will also go into the next Booker release for the other pilot hotels or stays a hotfix for one site.', addressee: to(['mara-keller']), by_: 'ambiguous' },
    { by: 'mara-keller', kind: 'answer', brief: 'It goes into Booker 1.9 for all hotels; the hotfix is already live everywhere.', by_: 'ambiguous' },
  ], { storyline: S, label: 'brightwell/booker', noise: ['ambiguous'], flat: true });
  // Broad-marker CEO DM run touching three clients within minutes.
  g.thread('dm:@jonas', wd(8), '08:10', [
    { by: 'jonas-brandt', kind: 'question', brief: 'Asks whether the Alpenhof go-live date is still safe, the hotel CFO called him.', label: 'alpenhof/relaunch', addressee: to(['mara-keller']) },
    { by: 'jonas-brandt', kind: 'question', brief: 'And whether the SWL penalty for the outage will be claimed and how much it could be.', label: 'swl/admin', addressee: to(['mara-keller']), gap: 2 },
    { by: 'jonas-brandt', kind: 'info', brief: 'Also: the Velo Nord managing director wants to talk about something for their dealers.', label: 'unregistered:velonord-b2b-portal', addressee: to(['mara-keller']), gap: 3, noise: ['unregistered'] },
    { by: 'mara-keller', kind: 'answer', brief: 'Go-live is tight but possible; SWL will likely claim 5 percent of a month; happy to join the Velo Nord call.', shares: [{ id: 'alpenhof/relaunch', share: 0.34 }, { id: 'swl/admin', share: 0.33 }, { id: 'unregistered:velonord-b2b-portal', share: 0.33 }], label: 'alpenhof/relaunch', gap: 12, noise: ['multi_initiative'] },
  ], { storyline: S, flat: true, noise: ['ambiguous'], rung: 'content' });
  // 1:1 with Jonas recorded twice (granola + wispr), three clients in one call.
  g.call({ storyline: S, title: '1:1 Jonas / Mara', day: wd(8), start: '08:30', minutes: 45, recorders: ['granola', 'wispr'], attendees: ['mara-keller', 'jonas-brandt'], organizer: 'jonas-brandt', recurring: true,
    wispr: [['mara-keller', 'Mara Keller'], ['jonas-brandt', 'JB']],
    topics: [
      { heading: 'Alpenhof', share: 0.4, label: 'alpenhof/relaunch', brief: 'Go-live risk, communication with the CFO.' },
      { heading: 'SWL Penalty', share: 0.3, label: 'swl/admin', brief: 'Expected SLA claim and how to answer.' },
      { heading: 'Velo Nord Dealers', share: 0.3, label: 'unregistered:velonord-b2b-portal', brief: 'Possible dealer portal project.' },
    ],
    nextSteps: [{ owner: 'mara-keller', brief: 'call the Alpenhof CFO about the go-live risk', due: '2026-09-18', commit: 'kept', to: ['remo-gerber'] }],
    brief: 'Weekly 1:1 of the founders, three clients.', lang: 'de', noise: ['multi_initiative', 'ambiguous'], by_: 'ambiguous' });
  // "Marco" as a name-only attendee: Bernasconi (SWL) — Rossi equally plausible; title hits the over-broad "sync".
  g.call({ storyline: S, title: 'Weekly sync', day: wd(10), start: '15:00', minutes: 30, recorders: ['wispr'], attendees: ['mara-keller', 'marco-bernasconi'],
    wispr: [['mara-keller', 'Mara Keller'], ['marco-bernasconi', 'Marco']],
    topics: [{ heading: 'Portal', share: 1, label: 'swl/portal', brief: 'Session timeout regression, monitoring access for SWL IT, next release.' }],
    nextSteps: [{ owner: 'mara-keller', brief: 'grant SWL IT read access to the monitoring dashboard', due: '2026-09-24', commit: 'kept', to: ['marco-bernasconi'] }],
    brief: 'Short weekly sync with the SWL IT lead.', lang: 'de', noise: ['ambiguous', 'over_broad_title', 'name_only'], by_: 'ambiguous', event: false });
}

// =========================================================================================================
// Background traffic (fills each source up to its quota) and machine noise.
// =========================================================================================================

const SLACK_QUOTA: Record<string, number> = {
  general: 30, random: 22, dev: 52, booker: 36, sales: 14, hiring: 11, 'ext-alpenhof': 46, 'ext-velonord': 32, 'ext-swl': 38, 'ext-medtrack': 32, 'ext-klartext-cms': 24,
  'dm:@jonas': 28, 'dm:@lea': 24, 'dm:@dima': 19, 'dm:@sasha': 17, 'dm:U0BWMRSGST1': 10, 'mpim:@lea+@tobias': 12, 'mpim:@dima+@olga': 10,
};
const CH_TOPICS: Record<string, [string, number][]> = {
  general: [['none', 0.55], ['brightwell/admin', 0.15], ['brightwell/booker', 0.1], ['brightwell/sales', 0.1], ['brightwell/infra', 0.1]],
  random: [['none', 1]],
  dev: [['brightwell/infra', 0.25], ['unregistered:hosting-migration', 0.2], ['brightwell/booker', 0.15], ['medtrack/app', 0.1], ['swl/portal', 0.1], ['alpenhof/relaunch', 0.1], ['velonord/erp-sync', 0.05], ['klartext/content-hub', 0.05]],
  booker: [['brightwell/booker', 0.75], ['brightwell/booker-support', 0.25]],
  sales: [['brightwell/sales', 0.5], ['unregistered:zermatt-pitch', 0.5]],
  hiring: [['brightwell/hiring', 1]],
  'ext-alpenhof': [['alpenhof/relaunch', 0.65], ['alpenhof/retainer', 0.35]],
  'ext-velonord': [['velonord/shop', 0.55], ['velonord/erp-sync', 0.35], ['unregistered:velonord-b2b-portal', 0.1]],
  'ext-swl': [['swl/portal', 0.92], ['swl/admin', 0.08]],
  'ext-medtrack': [['medtrack/app', 1]],
  'ext-klartext-cms': [['klartext/content-hub', 1]],
  'dm:@jonas': [['brightwell/sales', 0.2], ['brightwell/admin', 0.15], ['brightwell/hiring', 0.15], ['alpenhof/relaunch', 0.15], ['swl/admin', 0.1], ['unregistered:zermatt-pitch', 0.1], ['none', 0.15]],
  'dm:@lea': [['alpenhof/relaunch', 0.45], ['alpenhof/retainer', 0.15], ['brightwell/booker', 0.3], ['none', 0.1]],
  'dm:@dima': [['brightwell/booker', 0.3], ['medtrack/app', 0.25], ['swl/portal', 0.2], ['unregistered:hosting-migration', 0.1], ['none', 0.15]],
  'dm:@sasha': [['brightwell/infra', 0.35], ['unregistered:hosting-migration', 0.4], ['swl/portal', 0.1], ['none', 0.15]],
  'dm:U0BWMRSGST1': [['medtrack/app', 0.9], ['none', 0.1]],
  'mpim:@lea+@tobias': [['alpenhof/relaunch', 0.3], ['swl/portal', 0.3], ['klartext/content-hub', 0.2], ['none', 0.2]],
  'mpim:@dima+@olga': [['medtrack/app', 0.3], ['klartext/content-hub', 0.3], ['brightwell/booker', 0.2], ['none', 0.2]],
};
// Who answers for an initiative on our side (the implicit addressee of client questions).
const OWNER: Record<string, string> = {
  'alpenhof/relaunch': 'lea-vogt', 'alpenhof/retainer': 'dmitry-sokolov', 'velonord/shop': 'felix-wagner', 'velonord/erp-sync': 'aleksandr-petrov', 'unregistered:velonord-b2b-portal': 'mara-keller',
  'swl/portal': 'tobias-hofer', 'swl/admin': 'mara-keller', 'medtrack/app': 'dmitry-sokolov', 'klartext/content-hub': 'tobias-hofer', 'brightwell/booker': 'lea-vogt', 'brightwell/booker-support': 'sebastian-kraus',
  'brightwell/infra': 'aleksandr-petrov', 'unregistered:hosting-migration': 'aleksandr-petrov', 'brightwell/sales': 'jonas-brandt', 'unregistered:zermatt-pitch': 'jonas-brandt', 'brightwell/hiring': 'jonas-brandt', 'brightwell/admin': 'sophie-laurent',
};
const ACTS: Record<string, string[]> = {
  question: ['asks {to} whether {s} is ready for review', 'asks {to} when {s} will be on staging', 'asks {to} how {s} is supposed to work', 'asks {to} if there is news on {s}', 'asks {to} who is taking care of {s}'],
  request: ['asks {to} to take a look at {s}', 'asks {to} to update {s} before the next call', 'asks {to} to prioritise {s} this week', 'asks {to} to send the current state of {s}'],
  info: ['reports that {s} is done and on staging', 'shares a short status on {s}', 'notes that {s} needs one more round of feedback', 'mentions that {s} is blocked by a missing decision'],
  incident: ['reports that {s} is broken on production since this morning', 'reports an error around {s} that users noticed'],
  answer: ['answers that {s} will be ready soon', 'explains briefly how {s} works', 'answers that {s} is already done', 'says {s} is waiting for feedback from the other side'],
  commitment: ['promises to finish {s} by {date}', 'commits to send an update on {s} by {date}'],
  noise: ['says thanks', 'says good morning to everyone', 'suggests lunch at the Thai place', 'wishes everyone a nice weekend', 'shares a coffee machine update', 'congratulates a colleague on their birthday'],
};

function fillAct(g: Gen, kind: string, s: string, toName: string, due: string, lang: Lang): string {
  return g.pick(ACTS[kind]!).replace('{s}', s).replace('{to}', toName || 'the team').replace('{date}', dateToken(due, lang));
}
const firstName = (g: Gen, pid: string): string => (g.isPerson(pid) ? g.person(pid).name.split(' ')[0]! : '');

function backgroundSlack(g: Gen): void {
  const humanCount = (ch: string): number => g.items.filter((x) => x.source === 'slack' && !g.slack.get(x.id)!.bot && g.slack.get(x.id)!.ch.name === ch).length;
  for (const [chName, quota] of Object.entries(SLACK_QUOTA)) {
    const ch = g.channels.get(chName)!;
    const members = ch.members;
    let guard = 0;
    while (humanCount(chName) < quota && guard++ < 400) {
      const day = g.pick(chName === 'random' || chName === 'general' ? DAYS.filter((d) => isWorkday(d) || g.chance(0.15)) : WORKDAYS);
      const label = g.weighted(CH_TOPICS[chName]!);
      if (label === 'unregistered:zermatt-pitch' && week(day) < 3) continue;
      if (label === 'unregistered:velonord-b2b-portal' && week(day) < 3) continue;
      const isDm = ch.kind === 'dm' || ch.kind === 'mpim';
      const subjectBias = isDm ? 0.5 : chName.startsWith('ext-') ? 0.18 : 0.15;
      const author = g.chance(subjectBias) && members.includes(SUBJECT) ? SUBJECT : g.pick(members.filter((m) => m !== SUBJECT || members.length === 1));
      const s = label === 'none' ? '' : g.pick(TOPICS[label]!);
      const smallTalk = label === 'none';
      const rootKind: TruthKind = smallTalk ? (isDm ? g.weighted([['noise', 0.5], ['question', 0.3], ['info', 0.2]] as const) : 'noise') : g.weighted([['question', 0.32], ['request', 0.2], ['info', 0.33], ['incident', 0.05], ['noise', 0.1]] as const);
      const owner = OWNER[label] && OWNER[label] !== author && members.includes(OWNER[label]!) ? OWNER[label]! : g.pick(members.filter((m) => m !== author)) ?? SUBJECT;
      const counterpart = isDm ? members.filter((m) => m !== author) : [owner];
      const explicit = !isDm && (rootKind === 'question' || rootKind === 'request') && g.chance(0.4);
      const lang = g.langOf(author, CH_LANG[chName], members.filter((m) => m !== author));
      const due = plusDays(day, g.int(1, 6));
      const tag: NoiseTag[] = label.startsWith('unregistered:') ? ['unregistered'] : [];
      const brief = smallTalk && rootKind !== 'noise' ? (rootKind === 'question' ? 'asks a personal, non-work question (weekend, lunch, how the kids are)' : 'shares a personal non-work note') : fillAct(g, rootKind, s, firstName(g, counterpart[0]!), due, lang);
      const msgs: MsgIn[] = [{
        by: author,
        kind: rootKind,
        brief,
        ...(explicit ? { mention: [counterpart[0]!] } : {}),
        addressee: rootKind === 'noise' ? nobody() : explicit ? to([counterpart[0]!], 'explicit') : isDm ? to(counterpart) : to([owner], 'implicit', g.person(author).company !== 'brightwell' ? { side: 'brightwell' } : {}),
        ...(rootKind === 'noise' || smallTalk ? { label: 'none' } : {}),
        ...(g.chance(0.04) ? { edit: g.pick(['typo', 'truncate'] as const) } : {}),
      }];
      const nReplies = rootKind === 'noise' ? (g.chance(0.3) ? 1 : 0) : g.weighted([[0, 0.5], [1, 0.22], [2, 0.14], [3, 0.08], [5, 0.06]] as const);
      for (let i = 0; i < nReplies; i++) {
        const prev = i === 0 ? author : msgs[msgs.length - 1]!.by;
        const by = i === 0 ? counterpart[0]! : g.chance(0.6) ? (prev === author ? counterpart[0]! : author) : g.pick(members);
        const k: TruthKind = rootKind === 'noise' ? 'noise' : i === 0 ? (rootKind === 'info' ? g.weighted([['answer', 0.4], ['question', 0.3], ['noise', 0.3]] as const) : g.weighted([['answer', 0.75], ['commitment', 0.15], ['question', 0.1]] as const)) : g.weighted([['answer', 0.3], ['info', 0.25], ['question', 0.15], ['commitment', 0.1], ['noise', 0.2]] as const);
        const kLang = g.langOf(by, CH_LANG[chName], members.filter((m) => m !== by));
        msgs.push({
          by,
          kind: k,
          brief: k === 'noise' ? g.pick(['says thanks', 'reacts with a short "ok, merci"', 'says "perfect, thank you"', 'sends a thumbs-up word']) : fillAct(g, k, s || 'that', firstName(g, prev), plusDays(day, g.int(1, 5)), kLang),
          addressee: k === 'noise' ? nobody() : to([prev === by ? author : prev]),
          ...(k === 'noise' || smallTalk ? { label: 'none' } : {}),
          ...(k === 'commitment' ? { commit: { owner: by, to: [prev === by ? author : prev], due: plusDays(day, g.int(1, 5)), outcome: g.weighted([['kept', 0.6], ['missed', 0.2], ['open', 0.2]] as const), what: `${s || 'follow-up'}` } } : {}),
          ...(g.chance(0.03) ? { edit: g.pick(['typo', 'truncate'] as const) } : {}),
          ...(i === 0 && rootKind !== 'noise' && !isDm ? {} : { by_: 'context' as DecidableBy }),
        });
      }
      const flat = isDm && g.chance(0.85);
      g.thread(chName, day, g.int(8 * 60 + 10, 18 * 60 + 20), msgs, { storyline: 'background', label, noise: tag, flat });
    }
  }
}

function backgroundAgent(g: Gen): void {
  // Questions to the project agent and its answers (template text — the agent is a machine) + daily open-item notes.
  const chans = ['ext-swl', 'ext-alpenhof', 'ext-medtrack', 'ext-velonord', 'ext-klartext-cms'];
  const keysFor: Record<string, string[]> = { 'ext-swl': ['SWL'], 'ext-alpenhof': ['ALP'], 'ext-medtrack': ['MT'], 'ext-velonord': ['VN'], 'ext-klartext-cms': ['KT'] };
  const STATUS = ['Open', 'In Progress', 'Waiting for client', 'Fixed', 'In Review'];
  for (let i = 0; i < 40; i++) {
    const chName = g.pick(chans);
    const ch = g.channels.get(chName)!;
    const day = g.pick(WORKDAYS);
    const keys = (g.keysByProject.get(keysFor[chName]![0]!) ?? []);
    if (!keys.length) continue;
    const key = g.pick(keys);
    const asker = g.pick(ch.members.filter((m) => m !== SUBJECT || g.chance(0.5)));
    const ini = g.items.find((x) => x.type === 'task' && x.keys.includes(key));
    const label = ini ? g.tins.get(ini.id)!.label ?? 'none' : CH_TOPICS[chName]![0]![0];
    const lang = g.langOf(asker, CH_LANG[chName]);
    const st = g.pick(STATUS);
    const asg = ini && g.task.get(ini.id)!.assignee ? g.person(g.task.get(ini.id)!.assignee!.pid).name : 'nobody';
    g.thread(chName, day, g.int(8 * 60 + 30, 17 * 60 + 30), [
      { by: asker, kind: 'question', brief: `asks the agent for the current status of ${key}`, keys: [key], mention: ['aven'], addressee: to([], 'explicit', { agent: 'aven' }) },
      { by: 'aven', kind: 'answer', brief: '', text: lang === 'de' ? `${key}: Status „${st}“, zugewiesen an ${asg}. Letzte Änderung ${dateToken(day, 'de')}` : `${key}: status "${st}", assigned to ${asg}. Last change ${dateToken(day, 'en')}.`, keys: [key], gap: 1, addressee: to([asker]) },
    ], { storyline: 'background', label: label === 'none' ? CH_TOPICS[chName]![0]![0] : label, rung: 'key' });
  }
  // Unprompted daily notes in client channels (open items) — the rest of the agent's ~80 messages.
  const agentCount = () => g.items.filter((x) => x.source === 'slack' && x.author === 'Aven').length;
  let guard = 0;
  while (agentCount() < 80 && guard++ < 200) {
    const chName = g.pick(chans);
    const day = g.pick(WORKDAYS);
    const keys = (g.keysByProject.get(keysFor[chName]![0]!) ?? []).slice(0, 4);
    const label = CH_TOPICS[chName]![0]![0];
    g.slackMsg({ storyline: 'background', label, kind: 'info', ch: chName, ts: at(day, '07:45'), by: 'aven', body: { text: `Open items ${dateToken(day, 'en')}: ${keys.length ? keys.join(', ') : 'none'} — reply here if something is missing.` }, addressee: nobody({ broadcast: true }), family: `agent:daily:${chName}` });
  }
}

const ALERT_RULES: { id: string; warn: (h: string) => string; ok: (h: string, m: number) => string }[] = [
  { id: 'http5xx', warn: (h) => `[WARNING] HTTP 5xx rate above 2% on ${h}`, ok: (h, m) => `[RESOLVED] HTTP 5xx rate back to normal on ${h} (after ${m} min)` },
  { id: 'p95', warn: (h) => `[WARNING] Response time p95 above 2s on ${h}`, ok: (h, m) => `[RESOLVED] Response time p95 back below 2s on ${h} (after ${m} min)` },
  { id: 'down', warn: (h) => `Monitor is DOWN: ${h} (connection timeout)`, ok: (h, m) => `Monitor is UP: ${h} (was down for ${m} min)` },
  { id: 'disk', warn: (h) => `[WARNING] Disk usage 87% on ${h}:/var`, ok: (h, m) => `[RESOLVED] Disk usage below 80% on ${h}:/var (after ${m} min)` },
  { id: 'cpu', warn: (h) => `[WARNING] CPU load above 90% for 5 min on ${h}`, ok: (h, m) => `[RESOLVED] CPU load normal on ${h} (after ${m} min)` },
  { id: 'mem', warn: (h) => `[WARNING] Memory above 90% on ${h}`, ok: (h, m) => `[RESOLVED] Memory below 80% on ${h} (after ${m} min)` },
  { id: 'queue', warn: (h) => `[WARNING] Queue backlog above 1000 jobs on ${h}`, ok: (h, m) => `[RESOLVED] Queue backlog drained on ${h} (after ${m} min)` },
  { id: 'cron', warn: (h) => `[WARNING] Cron job "nightly-export" missed on ${h}`, ok: (h, m) => `[RESOLVED] Cron job "nightly-export" ran on ${h} (after ${m} min)` },
  { id: 'dbconn', warn: (h) => `[WARNING] DB connections above 80% on ${h}`, ok: (h, m) => `[RESOLVED] DB connections normal on ${h} (after ${m} min)` },
  { id: 'synclag', warn: (h) => `[WARNING] Stock sync lag above 15 min on ${h}`, ok: (h, m) => `[RESOLVED] Stock sync lag below 5 min on ${h} (after ${m} min)` },
  { id: 'ssl', warn: (h) => `[WARNING] SSL certificate for ${h} expires in 12 days`, ok: (h, m) => `[RESOLVED] SSL certificate for ${h} renewed (after ${m} min)` },
  { id: 'session', warn: (h) => `[WARNING] Session store latency above 500ms on ${h}`, ok: (h, m) => `[RESOLVED] Session store latency normal on ${h} (after ${m} min)` },
];
const HOST_RULES: Record<string, string[]> = {
  'www.alpenhof-hotels.example': ['down', 'p95', 'ssl', 'disk'],
  'staging.alpenhof-hotels.example': ['down', 'ssl'],
  'shop.velo-nord.example': ['http5xx', 'p95', 'down'],
  'erp-bridge.brightwell.example': ['queue', 'synclag', 'cron', 'mem'],
  'portal.stadtwerke-lindquell.example': ['p95', 'http5xx', 'session', 'down'],
  'api.medtrack.example': ['http5xx', 'p95', 'cpu'],
  'hub.kieselfeder-verlag.example': ['down', 'disk', 'cron'],
  'booker.brightwell.example': ['http5xx', 'dbconn', 'p95'],
  'widget.brightwell.example': ['http5xx', 'p95'],
  'ci.brightwell.example': ['disk', 'cpu', 'mem'],
  'vpn.brightwell.example': ['ssl', 'down'],
  'nh-k8s-01.nordhost.example': ['cpu', 'mem', 'disk', 'down'],
};

/** Velo Nord's shop answered on its old domain until the switch (VN ticket done on the rename day). */
const SHOP_SWITCH_AT = '2026-09-23T16:00:00.000Z';
const hostAt = (host: string, t: string): string => (host === 'shop.velo-nord.example' && t < SHOP_SWITCH_AT ? 'shop.velonord.example' : host);

function alertIncident(g: Gen, host: string, ruleId: string, t: string, storyline: string, extra: NoiseTag[] = []): void {
  const rule = ALERT_RULES.find((r) => r.id === ruleId)!;
  const asset = ASSET.get(host)!;
  host = hostAt(host, t);
  const label = asset.initiative;
  const n = g.counter('flap');
  const cluster = `flap-${String(n).padStart(4, '0')}`;
  const family = `alert:${ruleId}:${host}`;
  const stale: NoiseTag[] = label !== 'brightwell/infra' ? ['stale_rule'] : [];
  const tags: NoiseTag[] = ['notification', 'alert', 'flap', ...stale, ...extra, ...(label.startsWith('unregistered:') ? ['unregistered' as NoiseTag] : [])];
  const w = g.slackMsg({ storyline, label, kind: 'noise', noiseType: 'notification', ch: 'ops-alerts', ts: t, by: 'uptime', body: { text: rule.warn(host) }, noise: tags, addressee: nobody(), cluster, dedupType: 'flap', canonical: true, family });
  let last = w.ts;
  if (g.chance(0.22)) {
    const re = g.slackMsg({ storyline, label, kind: 'noise', noiseType: 'notification', ch: 'ops-alerts', ts: addMin(last, g.int(4, 6)), by: 'uptime', body: { text: rule.warn(host) }, noise: [...tags, 'refire', 'exact_dup'], addressee: nobody(), cluster, dedupType: 'flap', canonical: false, family });
    last = re.ts;
  }
  if (ruleId !== 'ssl' || g.chance(0.3)) {
    const mins = g.int(2, 15);
    g.slackMsg({ storyline, label, kind: 'noise', noiseType: 'notification', ch: 'ops-alerts', ts: addMin(w.ts, mins + (last !== w.ts ? 6 : 0)), by: 'uptime', body: { text: rule.ok(host, mins) }, noise: tags, addressee: nobody(), cluster, dedupType: 'flap', canonical: false, family });
  }
}

function backgroundBots(g: Gen): void {
  // Storyline bursts first.
  for (let i = 0; i < 9; i++) alertIncident(g, 'portal.stadtwerke-lindquell.example', g.pick(['p95', 'session', 'http5xx']), at(wd(5), 7 * 60 + 35 + i * 22), 's3-swl');
  for (let i = 0; i < 4; i++) alertIncident(g, 'portal.stadtwerke-lindquell.example', g.pick(['p95', 'session']), at(wd(6), 8 * 60 + i * 47), 's3-swl');
  for (const d of [wd(5), wd(6), wd(7), wd(8), wd(9), wd(10)]) alertIncident(g, 'erp-bridge.brightwell.example', g.pick(['synclag', 'queue']), at(d, g.int(6 * 60, 20 * 60)), 's2-velonord');
  for (let i = 0; i < 3; i++) alertIncident(g, 'widget.brightwell.example', 'http5xx', at(wd(16), 9 * 60 + 40 + i * 35), 's1-alpenhof', ['multi_initiative']);
  // Background flapping: every host/rule pair with a daily incident rate.
  for (const day of DAYS) {
    for (const [host, rules] of Object.entries(HOST_RULES)) {
      for (const rule of rules) {
        const rate = host.startsWith('nh-k8s') && week(day) < 2 ? 0 : rule === 'ssl' ? 0.05 : 0.33;
        if (g.chance(rate)) alertIncident(g, host, rule, at(day, g.int(0, 23 * 60 + 40)), 'noise');
      }
    }
  }
  // Sentry issues + Quick Analyzer companions (within 2 minutes).
  const SENTRY: [string, string][] = [['booker-api', 'TypeError: Cannot read properties of undefined (reading "rate")'], ['booker-widget', 'RangeError: Invalid currency code'], ['swl-portal', 'SessionTimeoutError: session store did not answer in 3000ms'], ['medtrack-api', 'PushTokenError: token not registered'], ['velonord-shop', 'CheckoutError: shipping zone NO not found'], ['klartext-hub', 'ImportError: invalid byte sequence for encoding UTF8'], ['alpenhof-web', 'TemplateError: missing translation key rooms.overview.title'], ['erp-bridge', 'TimeoutError: ERP export did not finish in 600s']];
  for (let i = 0; i < 100; i++) {
    const [app, err] = g.pick(SENTRY);
    const day = g.pick(DAYS);
    const t = at(day, g.int(6 * 60, 22 * 60));
    const label = ASSET.get(app)!.initiative;
    const n = g.int(3, 480);
    const cluster = `sentry-${String(g.counter('sentry')).padStart(4, '0')}`;
    const s = g.slackMsg({ storyline: 'noise', label, kind: 'noise', noiseType: 'notification', ch: 'ops-alerts', ts: t, by: 'sentry', body: { text: `New issue in ${app}: ${err} — ${n} events in the last hour` }, noise: ['notification', 'integration', ...(label !== 'brightwell/infra' ? ['stale_rule' as NoiseTag] : [])], addressee: nobody(), cluster, canonical: true, family: `sentry:${app}` });
    if (g.chance(0.6)) {
      g.slackMsg({ storyline: 'noise', label, kind: 'noise', noiseType: 'notification', ch: 'ops-alerts', ts: addMin(s.ts, g.int(1, 2)), by: 'sentry-qa', body: { text: `Probable cause for ${app}: ${err.split(':')[0]} — likely introduced by the last deploy (confidence ${(0.5 + g.r() * 0.45).toFixed(2)})` }, noise: ['notification', 'integration'], addressee: nobody(), cluster, dedupType: 'near', canonical: false, family: `sentry-qa:${app}` });
      Object.assign(g.tins.get(s.id)!, { dedupType: 'near' as DedupType });
    }
  }
  // Deploys: start + finish per deploy, per app; a few legacy webhook lines without the bot flag.
  const DEPLOY_RATE: Record<string, number> = { 'booker-api': 1.2, 'booker-widget': 0.8, 'alpenhof-web': 0.35, 'velonord-shop': 0.25, 'erp-bridge': 0.2, 'swl-portal': 0.25, 'klartext-hub': 0.2, 'medtrack-api': 0.3, 'status-page': 0.1 };
  const deployers = ['dmitry-sokolov', 'chiara-romano', 'felix-wagner', 'aleksandr-petrov', 'olga-ivanova'];
  const deploy = (app: string, t: string, storyline: string, extra: NoiseTag[] = []) => {
    const label = ASSET.get(app)!.initiative;
    const sha = hex(`sha:${app}:${t}`, 7);
    const who = g.person(g.pick(deployers)).name;
    const env = g.chance(0.35) ? 'staging' : 'production';
    const tags: NoiseTag[] = ['notification', 'deploy', ...extra, ...(label.startsWith('unregistered:') ? ['unregistered' as NoiseTag] : [])];
    g.slackMsg({ storyline, label, kind: 'noise', noiseType: 'notification', ch: 'deploys', ts: t, by: 'deploybot', body: { text: `Deploying ${app}@${sha} to ${env} (triggered by ${who})` }, noise: tags, addressee: nobody(), family: `deploy:${app}` });
    g.slackMsg({ storyline, label, kind: 'noise', noiseType: 'notification', ch: 'deploys', ts: addMin(t, g.int(2, 9)), by: 'deploybot', body: { text: `${app}@${sha} deployed to ${env} in ${g.int(1, 6)}m${g.int(10, 59)}s` }, noise: tags, addressee: nobody(), family: `deploy:${app}` });
  };
  deploy('alpenhof-web', at(wd(16), '06:55'), 's1-alpenhof');
  deploy('booker-widget', at(wd(17), '12:02'), 's1-alpenhof', ['multi_initiative']);
  for (const d of [wd(15), wd(16), wd(17)]) deploy('pitch-demo', at(d, g.int(17 * 60, 20 * 60)), 's6-internal');
  for (const day of WORKDAYS) for (const [app, rate] of Object.entries(DEPLOY_RATE)) if (g.chance(rate / 1.6)) deploy(app, at(day, g.int(9 * 60, 18 * 60)), 'noise');
  for (let i = 0; i < 15; i++) {
    const app = g.pick(Object.keys(DEPLOY_RATE));
    const day = g.pick(WORKDAYS);
    const label = ASSET.get(app)!.initiative;
    g.slackMsg({ storyline: 'noise', label, kind: 'noise', noiseType: 'notification', ch: 'deploys', ts: at(day, g.int(9 * 60, 18 * 60)), by: 'deploy-hook', body: { text: `deploy finished: ${app} (production)` }, noise: ['notification', 'deploy', 'unflagged_bot'], addressee: nobody(), family: `hook:${app}` });
  }
  // GitHub and YouTrack integration posts in #dev.
  const repos = g.world.repos.filter((r) => !r.container.includes('nordhost'));
  for (let i = 0; i < 100; i++) {
    const repo = g.pick(repos);
    const day = g.pick(WORKDAYS);
    const t = at(day, g.int(8 * 60, 19 * 60));
    const name = (repo.renamed && t >= repo.renamed.at ? repo.renamed.container : repo.container).replace(/^[^/]+\//, '');
    const pr = g.int(100, 480);
    const login = g.pick(['dsokolov', 'oivanova', 'fwagner', 'cromano', 'apetrov', 'mkeller']);
    const ev = g.weighted([['opened', 0.4], ['merged', 0.35], ['ci', 0.25]] as const);
    const text = ev === 'ci' ? `[${name}] CI failed on main: ${g.pick(['unit tests', 'lint', 'e2e checkout', 'build'])} (#${pr})` : `[${name}] Pull request ${ev} #${pr}: ${g.pick(TOPICS[repo.initiative] ?? ['maintenance'])} — by ${login}`;
    g.slackMsg({ storyline: 'noise', label: repo.initiative, kind: 'noise', noiseType: 'notification', ch: 'dev', ts: t, by: 'github', body: { text }, noise: ['notification', 'integration', ...(repo.initiative.startsWith('unregistered:') ? ['unregistered' as NoiseTag] : [])], addressee: nobody(), family: `github:${ev}:${name}` });
  }
  const tickets = g.items.filter((x) => x.type === 'task' && x.source === 'youtrack');
  for (let i = 0; i < 60 && tickets.length; i++) {
    const tk = g.pick(tickets);
    const spec = g.task.get(tk.id)!;
    const inWindow = spec.statuses.filter((x) => localDay(x.at) >= SINCE);
    if (!inWindow.length) continue;
    const st = g.pick(inWindow);
    const key = spec.renameAt && st.at >= spec.renameAt ? `KH-${spec.num}` : `${spec.project}-${spec.num}`;
    g.slackMsg({ storyline: 'noise', label: g.tins.get(tk.id)!.label ?? 'none', shares: g.tins.get(tk.id)!.shares, kind: 'noise', noiseType: 'notification', ch: 'dev', ts: addMin(st.at, g.int(0, 3)), by: 'youtrack-bot', body: { text: `${key} ${tk.title} — State: ${st.status}` }, noise: ['notification', 'integration'], addressee: nobody(), family: `youtrack:${spec.project}` }).keys.push(key);
  }
}

function backgroundTickets(g: Gen): void {
  // Fill each tracker project from its title bank (carried-over tickets start before the window).
  const QUOTA: Record<string, number> = { ALP: 12, VN: 9, SWL: 8, KT: 7, BKR: 8, OPS: 5, MT: 10 };
  const REPORTERS: Record<string, string[]> = { ALP: ['claudia-steiner', 'juerg-mueller', 'lea-vogt'], VN: ['kai-lund', 'mette-hansen', 'felix-wagner'], SWL: ['tobin-berger', 'marco-bernasconi', 'tobias-hofer'], KT: ['ines-wolf', 'paul-keller', 'tobias-hofer'], BKR: ['lea-vogt', 'sebastian-kraus', 'chiara-romano'], OPS: ['aleksandr-petrov', 'mara-keller'], MT: ['yulia-kuznetsova', 'priya-nair', 'daniel-weber'] };
  const ASSIGNEES: Record<string, string[]> = { ALP: ['dmitry-sokolov', 'nina-brunner', 'lea-vogt'], VN: ['felix-wagner', 'aleksandr-petrov'], SWL: ['dmitry-sokolov', 'aleksandr-petrov'], KT: ['olga-ivanova', 'felix-wagner'], BKR: ['chiara-romano', 'dmitry-sokolov', 'sebastian-kraus'], OPS: ['aleksandr-petrov'], MT: ['dmitry-sokolov', 'marco-rossi', 'olga-ivanova'] };
  const FLOW: Record<string, string[][]> = {
    youtrack: [['Open', 'In Progress', 'Fixed'], ['Open', 'In Progress', 'Waiting for client', 'Fixed'], ['Open', 'Waiting for Client'], ['Open', 'In Progress'], ['Open'], ['Open', 'In Progress', 'Verified']],
    jira: [['To Do', 'In Progress', 'Done'], ['To Do', 'In Progress', 'In Review'], ['To Do']],
  };
  for (const [project, quota] of Object.entries(QUOTA)) {
    const used = new Set(g.items.filter((x) => x.type === 'task' && g.task.get(x.id)!.project === project).map((x) => x.title));
    const bank = TICKET_TITLES[project]!.filter((t) => !used.has(t.title));
    let have = g.items.filter((x) => x.type === 'task' && g.task.get(x.id)!.project === project).length;
    for (const t of bank) {
      if (have >= quota) break;
      have++;
      const carried = g.chance(0.3);
      const created = carried ? at(plusDays(SINCE, -g.int(10, 70)), g.int(8 * 60, 17 * 60)) : at(g.pick(WORKDAYS.slice(0, 17)), g.int(8 * 60, 17 * 60));
      const flow = g.pick(FLOW[project === 'MT' ? 'jira' : 'youtrack']!);
      let tt = created;
      const statuses = flow.map((s, i) => {
        if (i > 0) tt = addMin(tt, g.int(3, 6 * 24) * 60);
        return { at: tt, status: s };
      });
      const reporter = g.pick(REPORTERS[project]!);
      const assignee = g.chance(0.9) ? g.pick(ASSIGNEES[project]!) : null;
      const ini = t.ini;
      const isClient = g.person(reporter).side === 'client';
      const tags: NoiseTag[] = [...(ini.startsWith('unregistered:') ? ['unregistered' as NoiseTag] : []), ...(statuses.some((s) => s.status === 'Waiting for Client') ? ['status_variant' as NoiseTag] : []), ...(project === 'KT' ? ['rename' as NoiseTag] : [])];
      const comments: CommentIn[] = [];
      const nC = project === 'MT' ? g.int(2, 5) : g.int(3, 7);
      let ct = addMin(created, g.int(30, 600));
      const people = uniq([reporter, ...(assignee ? [assignee] : []), ...(isClient ? [OWNER[ini] ?? SUBJECT] : []), ...(g.chance(0.3) ? [SUBJECT] : [])]);
      for (let i = 0; i < nC; i++) {
        ct = addMin(ct, g.int(20, 2 * 24 * 60));
        if (ct > at(UNTIL, '20:00')) break;
        const by = people[i % people.length]!;
        const k: TruthKind = g.weighted([['question', 0.25], ['answer', 0.25], ['info', 0.3], ['request', 0.12], ['commitment', 0.08]] as const);
        const toPid = people.find((p) => p !== by) ?? reporter;
        comments.push({ ts: ct, by, kind: k, brief: fillAct(g, k, `the ticket "${t.title}"`, firstName(g, toPid), plusDays(localDay(ct), g.int(1, 4)), PROJECT_LANG[project]!), addressee: to([toPid]), ...(k === 'commitment' ? { commit: { owner: by, to: [toPid], due: plusDays(localDay(ct), g.int(1, 4)), outcome: g.weighted([['kept', 0.6], ['missed', 0.2], ['open', 0.2]] as const), what: t.title } } : {}), ...(project === 'SWL' && by === 'marco-bernasconi' && g.chance(0.4) ? { lang: 'it' as Lang } : {}) });
      }
      g.ticket({ storyline: carried ? 'background-carried' : 'background', label: ini, project, title: t.title, created, reporter, assignee, statuses, labels: t.tag ? [t.tag] : [], brief: `Describes the problem or wish behind "${t.title}" with enough detail to start.`, kind: g.pick(['request', 'incident', 'request'] as const), noise: tags, comments, addressee: assignee ? to([assignee]) : to([OWNER[ini] ?? SUBJECT]) });
    }
  }
  // Top up comments to ~250 (YouTrack) / ~40 (Jira) on tickets that are still moving.
  const topUp = (tracker: 'youtrack' | 'jira', target: number) => {
    let guard = 0;
    while (g.items.filter((x) => x.type === 'comment' && x.source === tracker).length < target && guard++ < 400) {
      const tk = g.pick(g.items.filter((x) => x.type === 'task' && x.source === tracker));
      const spec = g.task.get(tk.id)!;
      const day = g.pick(WORKDAYS);
      const t = at(day, g.int(8 * 60, 18 * 60));
      if (t < tk.ts) continue;
      const by = g.chance(0.5) ? spec.reporter.pid : spec.assignee?.pid ?? SUBJECT;
      const toPid = by === spec.reporter.pid ? spec.assignee?.pid ?? SUBJECT : spec.reporter.pid;
      const k: TruthKind = g.weighted([['question', 0.25], ['answer', 0.25], ['info', 0.35], ['request', 0.15]] as const);
      g.commentOn(tk, { ts: t, by, kind: k, brief: fillAct(g, k, `the ticket "${tk.title}"`, firstName(g, toPid), plusDays(day, 2), PROJECT_LANG[spec.project]!), addressee: to([toPid]) });
    }
  };
  topUp('youtrack', 250);
  topUp('jira', 40);
}

const MAIL_SUBJECTS: Record<string, string[]> = {
  'alpenhof/relaunch': ['Feedback zur Zimmerübersicht', 'Texte Spa-Seite', 'Bildrechte Galerie', 'Abnahme Startseite', 'Newsletter-Anmeldung auf der neuen Website'],
  'alpenhof/retainer': ['SSL-Zertifikat www', 'Backup September', 'CMS-Zugang Rezeption', 'Mailweiterleitung reservation@', 'Serverwartung am Wochenende'],
  'velonord/shop': ['Shop: frame size filter', 'Norway shipping costs', 'Autumn sale discount codes', 'Gift cards in checkout'],
  'velonord/erp-sync': ['ERP export errors', 'Sync interval', 'Warehouse mapping'],
  'swl/portal': ['Kundenportal: Rechnungs-Download', 'Störungsbanner Texte', 'Release Kundenportal 3.2', 'Zählerstand-Formular'],
  'medtrack/app': ['Push notification issue', 'Sprint review follow-up', 'TestFlight access', 'Store screenshots 2.4'],
  'klartext/content-hub': ['Migration: Testimport', 'Content-Modell Dossiers', 'Redaktionsworkflow', 'Autorenprofile'],
  'brightwell/booker': ['Booker pilot: feedback from the hotel', 'Booker pricing for new hotels', 'Booker release 1.9 notes'],
  'brightwell/booker-support': ['Rückerstattung Export', 'Doppelbuchung 12.09.', 'Widget lädt nicht'],
  'brightwell/infra': ['VPN certificates', 'CI costs September'],
  'unregistered:hosting-migration': ['Migration timeline', 'Staging cluster access', 'Nordhost contract questions'],
  'brightwell/sales': ['Anfrage Website Skischule', 'Referenzen Hotellerie', 'Angebot Relaunch Pension'],
  'unregistered:zermatt-pitch': ['Pitch-Unterlagen', 'Pitch: Fragen zum Hosting', 'Pitch-Termin 1. Oktober'],
  'brightwell/hiring': ['Interview scheduling', 'Trial day', 'Reference check'],
  'brightwell/admin': ['Spesen August', 'Miete Büro Oktober', 'Jahresabschluss 2025', 'Kreditkartenabrechnung'],
  'alpenhof/admin': ['Rechnung Support-Stunden August'],
  'swl/admin': ['Rapport Stunden August'],
  'medtrack/admin': ['Half-day report September'],
  'klartext/admin': ['Rechnung Meilenstein 2'],
  'velonord/admin': ['Invoice August'],
};
const MAIL_CONTACTS: Record<string, string[]> = {
  'alpenhof/relaunch': ['claudia-steiner'], 'alpenhof/retainer': ['juerg-mueller'], 'alpenhof/admin': ['remo-gerber'],
  'velonord/shop': ['kai-lund'], 'velonord/erp-sync': ['mette-hansen'], 'velonord/admin': ['kai-lund'],
  'swl/portal': ['marco-bernasconi', 'tobin-berger'], 'swl/admin': ['andrea-fischer'],
  'medtrack/app': ['yulia-kuznetsova', 'daniel-weber'], 'medtrack/admin': ['daniel-weber'],
  'klartext/content-hub': ['paul-keller', 'ines-wolf'], 'klartext/admin': ['paul-keller'],
  'brightwell/booker': ['lea-vogt', 'chiara-romano'], 'brightwell/booker-support': ['sebastian-kraus'], 'brightwell/infra': ['aleksandr-petrov'],
  'unregistered:hosting-migration': ['lars-eriksen', 'aleksandr-petrov'], 'brightwell/sales': ['jonas-brandt'], 'unregistered:zermatt-pitch': ['laura-imhof', 'jonas-brandt'],
  'brightwell/hiring': ['jonas-brandt', 'tim-novak', 'elena-popescu'], 'brightwell/admin': ['sophie-laurent', 'petra-schmid'],
};

function backgroundMail(g: Gen): void {
  const humanWork = () => g.items.filter((x) => x.source === 'gmail' && x.account === ACCOUNTS.work && g.tins.get(x.id)!.kind !== 'noise' && x.render.mode !== 'template').length;
  const labels = Object.keys(MAIL_SUBJECTS);
  const weights: [string, number][] = labels.map((l) => [l, l.endsWith('/admin') && l !== 'brightwell/admin' ? 0.4 : l.startsWith('unregistered:') ? 0.8 : 1]);
  let guard = 0;
  while (humanWork() < 262 && guard++ < 500) {
    const label = g.weighted(weights);
    const day = g.pick(WORKDAYS);
    if (label === 'unregistered:zermatt-pitch' && week(day) < 3) continue;
    const contact = g.pick(MAIL_CONTACTS[label]!);
    const subject = g.pick(MAIL_SUBJECTS[label]!);
    const n = g.weighted([[1, 0.35], [2, 0.4], [3, 0.18], [4, 0.07]] as const);
    const mails: MailIn[] = [];
    const startsWithClient = contact !== SUBJECT && g.chance(0.6);
    for (let i = 0; i < n; i++) {
      const fromClient = (i % 2 === 0) === startsWithClient;
      const by = fromClient ? contact : SUBJECT;
      const toP = fromClient ? SUBJECT : contact;
      const k: TruthKind = i === 0 ? g.weighted([['question', 0.35], ['request', 0.3], ['info', 0.3], ['noise', 0.05]] as const) : g.weighted([['answer', 0.55], ['info', 0.2], ['commitment', 0.1], ['question', 0.1], ['noise', 0.05]] as const);
      const s = g.pick(TOPICS[label] ?? ['the topic']);
      const lang = g.langOf(by, undefined, [toP]);
      const cc = g.chance(0.3) ? [OWNER[label] && OWNER[label] !== by && OWNER[label] !== toP && g.isPerson(OWNER[label]!) ? OWNER[label]! : 'jonas-brandt'].filter((x) => x !== by && x !== toP) : [];
      mails.push({ by, to: [toP], cc, kind: k, brief: k === 'noise' ? 'a short thank-you note, nothing else' : fillAct(g, k, s, firstName(g, toP), plusDays(day, g.int(1, 6)), lang), addressee: k === 'noise' ? nobody() : to([toP], 'explicit'), ...(k === 'noise' ? { label: 'none', noise: ['small_talk' as NoiseTag] } : {}), ...(k === 'commitment' ? { commit: { owner: by, to: [toP], due: plusDays(day, g.int(1, 6)), outcome: g.weighted([['kept', 0.6], ['missed', 0.15], ['open', 0.25]] as const), what: s } } : {}), gap: g.int(30, 1400) });
    }
    const tags: NoiseTag[] = label.startsWith('unregistered:') ? ['unregistered'] : [];
    g.mailThread('work', subject, day, g.int(7 * 60 + 30, 19 * 60), mails, { storyline: 'background', label, noise: tags, reply: g.person(contact).langs[0] === 'de' && g.chance(0.5) ? 'AW' : 'Re' });
  }
}

function machineMail(g: Gen): void {
  const W = 'work';
  // Newsletters: 10 senders at their cadence; two overlap client vocabulary.
  const NL: [string, number, string[]][] = [
    ['nl-webweekly', 2, ['This week: container queries in practice', 'Fast image formats compared', 'Accessibility checklists for 2026']],
    ['nl-frontend', 2, ['Frontend Focus #612', 'Frontend Focus #613: view transitions', 'Frontend Focus #614']],
    ['nl-saas', 1, ['Pricing pages that convert', 'Churn in small SaaS']],
    ['nl-hoteltech', 2, ['Booking widget conversion: 7 tactics for hotels', 'Direct bookings vs. OTAs in autumn', 'Room pages that sell']],
    ['nl-bookingtools', 3, ['How to embed a booking widget without slowing your site', 'Rate plans explained', 'Availability calendars and caching', 'New: multi-property booking widget']],
    ['nl-swissdigital', 2, ['Digitalisierung in der Hotellerie', 'Events in Zürich im Oktober']],
    ['nl-devops', 2, ['DevOps Digest: managed Kubernetes pricing', 'Backups you can restore', 'Zero-downtime database moves']],
    ['nl-cms', 2, ['Headless CMS migrations: lessons', 'Editorial workflows that scale']],
    ['nl-ecom', 6, ['Today in e-commerce', 'Checkout trends', 'Shipping costs and conversion', 'Marketplace news']],
    ['nl-ux', 2, ['UX Notes: forms', 'UX Notes: onboarding flows']],
  ];
  for (const [id, perWeek, subjects] of NL) {
    const b = BOT.get(id)!;
    const overlap = id === 'nl-hoteltech' || id === 'nl-bookingtools';
    for (const day of DAYS) {
      if (!g.chance(perWeek / 7)) continue;
      const subj = g.pick(subjects);
      g.mailMsg({ storyline: 'noise', label: 'none', kind: 'noise', noiseType: 'newsletter', acct: W, ts: at(day, g.int(5 * 60, 9 * 60)), by: id, to: [ACCOUNTS.work], subject: subj, folder: g.chance(0.15) ? 'archive' : 'inbox',
        body: { text: `${b.label}\n\n${subj}\n\nRead online: https://${b.address!.split('@')[1]}/issues/${hex(`${id}:${day}`, 6)}\n\nYou receive this newsletter because you subscribed with ${ACCOUNTS.work}. Unsubscribe: https://${b.address!.split('@')[1]}/u/${hex(`u:${id}`, 10)}` },
        noise: ['newsletter', ...(overlap ? ['newsletter_overlap' as NoiseTag] : [])], addressee: nobody({ broadcast: true }), family: `newsletter:${id}`, rung: 'rule' });
    }
  }
  // YouTrack / Jira mail notifications for ticket events (key in subject → links to the stored ticket).
  for (const tk of g.items.filter((x) => x.type === 'task').slice()) {
    const spec = g.task.get(tk.id)!;
    for (const cId of spec.comments) {
      const c = g.byId.get(cId)!;
      if (c.authorPerson === SUBJECT || c.day < SINCE || !g.chance(spec.tracker === 'jira' ? 0.7 : 0.55)) continue;
      const key = c.keys[0]!;
      const sender = spec.tracker === 'jira' ? 'jira-mail' : 'yt-mail';
      const who = g.isPerson(c.authorPerson!) ? g.person(c.authorPerson!).name : 'someone';
      const tk0 = g.tins.get(tk.id)!;
      g.mailMsg({ storyline: 'noise', label: tk0.label, shares: tk0.shares, kind: 'noise', noiseType: 'notification', acct: W, ts: addMin(c.ts, g.int(1, 4)), by: sender, to: [ACCOUNTS.work], subject: `[${spec.tracker === 'jira' ? 'JIRA' : 'YouTrack'}] ${key} ${tk.title}`,
        body: { text: `${who} commented on ${key} "${tk.title}".\n\nView: ${spec.tracker === 'jira' ? `https://${ACCOUNTS.jira}/browse/${key}` : `https://${ACCOUNTS.youtrack}/issue/${key}`}\n\nYou are receiving this because you watch this issue.` },
        noise: ['notification', 'integration'], addressee: nobody(), family: `${sender}:${spec.project}` }).keys.push(key);
    }
  }
  const notif = (id: string, n: number, mk: (i: number, day: string) => { subject: string; text: string; label: string }) => {
    for (let i = 0; i < n; i++) {
      const day = g.pick(DAYS);
      const x = mk(i, day);
      g.mailMsg({ storyline: 'noise', label: x.label, kind: 'noise', noiseType: 'notification', acct: W, ts: at(day, g.int(6 * 60, 22 * 60)), by: id, to: [ACCOUNTS.work], subject: x.subject, body: { text: x.text }, noise: ['notification'], addressee: nobody(), family: `${id}` });
    }
  };
  const repos = g.world.repos;
  notif('gh-mail', 70, () => {
    const r = g.pick(repos);
    const name = r.container.replace(/^[^/]+\//, '');
    const pr = g.int(100, 480);
    return { subject: `[${name}] ${g.pick(['Review requested', 'CI failed', 'PR merged'])} (#${pr})`, text: `Repository ${name}, pull request #${pr}.\nView it on GitHub: https://github.example/${name}/pull/${pr}`, label: r.initiative };
  });
  notif('docs-mail', 30, () => {
    const l = g.pick(['alpenhof/relaunch', 'klartext/content-hub', 'unregistered:zermatt-pitch', 'brightwell/booker']);
    const doc = l === 'alpenhof/relaunch' ? 'Alpenhof Texte Relaunch' : l === 'klartext/content-hub' ? 'Content-Modell Dossiers' : l === 'brightwell/booker' ? 'Booker 1.9 release notes' : 'Pitch Zermatt Konzept';
    return { subject: `New comment in "${doc}"`, text: `A comment was added to the document "${doc}".\nOpen: https://docs.workspace.example/d/${hex(doc, 12)}`, label: l };
  });
  notif('sentry-mail', 40, () => {
    const a = g.pick(['booker-api', 'swl-portal', 'medtrack-api', 'velonord-shop', 'erp-bridge']);
    return { subject: `[Sentry] New issue in ${a}`, text: `A new issue was detected in ${a}. ${g.int(5, 300)} events in the last hour.\nhttps://sentry.example/organizations/brightwell/issues/${g.int(1000, 9999)}/`, label: ASSET.get(a)!.initiative };
  });
  notif('uptime-mail', 30, (_i, day) => {
    const h0 = g.pick(Object.keys(HOST_RULES));
    const h = hostAt(h0, at(day, '12:00'));
    return { subject: `Monitor is DOWN: ${h}`, text: `Your monitor ${h} is currently DOWN (connection timeout).\nhttps://uptimerobot.example/dashboard`, label: ASSET.get(h0)!.initiative };
  });
  notif('slack-mail', 10, () => ({ subject: 'You have unread messages in Brightwell Digital', text: 'You have unread messages and mentions in the Brightwell Digital workspace.\nhttps://brightwell-digital.slack.example/', label: 'none' }));
  // Receipts → admin buckets (personal receipts go to the personal mailbox below).
  const RC: [string, string, number][] = [['rc-cloudhost', 'Invoice September – CloudHost', 4], ['rc-design', 'Your DesignBoard receipt', 4], ['rc-workspace', 'Workspace invoice for September', 2], ['rc-nordhost', 'Nordhost invoice – staging cluster', 2], ['rc-rail', 'Ihr Ticket Zürich HB – Lindquell', 12]];
  for (const [id, subj, n] of RC) {
    for (let i = 0; i < n; i++) {
      const day = g.pick(DAYS);
      const amount = `CHF ${g.int(12, 640)}.${String(g.int(0, 99)).padStart(2, '0')}`;
      const label = id === 'rc-nordhost' ? 'unregistered:hosting-migration' : 'brightwell/admin';
      g.mailMsg({ storyline: 'noise', label, kind: 'noise', noiseType: 'notification', acct: W, ts: at(day, g.int(0, 23 * 60)), by: id, to: [ACCOUNTS.work], subject: subj, body: { text: `${BOT.get(id)!.label}\n\n${subj}\nAmount: ${amount}\nThank you for your payment.` }, noise: ['receipt', 'notification', ...(label.startsWith('unregistered:') ? ['unregistered' as NoiseTag] : [])], addressee: nobody(), family: `receipt:${id}` });
    }
  }
  // Digest series (one dedup cluster per series).
  const DG: [string, string, string, number][] = [['dg-analytics', 'Weekly site report: www.alpenhof-hotels.example', 'alpenhof/retainer', 4], ['dg-booker', 'Booker weekly KPIs', 'brightwell/booker', 4], ['dg-sentry', 'Weekly report for Brightwell', 'brightwell/infra', 4], ['dg-timesheet', 'Reminder: submit your timesheet', 'brightwell/admin', 4], ['dg-yt', 'YouTrack weekly digest', 'none', 4], ['dg-bank', 'Kontoauszug September', 'brightwell/admin', 1], ['dg-uptime', 'Monthly uptime report', 'brightwell/infra', 1]];
  for (const [id, subj, label, n] of DG) {
    const cluster = `digest-${id}`;
    for (let i = 0; i < n; i++) {
      const day = n === 1 ? '2026-10-01' : wd(i * 5);
      g.mailMsg({ storyline: 'noise', label, kind: 'noise', noiseType: 'notification', acct: W, ts: at(day, '06:00'), by: id, to: [ACCOUNTS.work], subject: subj, body: { text: `${subj}\nPeriod ending ${day}.\nSummary: ${g.int(10, 900)} items, ${g.int(0, 40)} changes since last report.` }, noise: ['digest', 'notification'], addressee: nobody(), cluster, dedupType: 'digest', canonical: i === 0, family: `digest:${id}` });
    }
  }
  // Calendar invitations / responses for events with external attendees.
  const events = g.items.filter((x) => x.type === 'event' && g.event.get(x.id)!.attendees.length > 1);
  for (const ev of events) {
    const spec = g.event.get(ev.id)!;
    const evT = g.tins.get(ev.id)!;
    const created = spec.createdAt;
    if (spec.organizer.pid !== SUBJECT && spec.organizer.pid !== 'system') {
      g.mailMsg({ storyline: 'noise', label: evT.label, shares: evT.shares, kind: 'noise', noiseType: 'notification', acct: W, ts: created, by: spec.organizer.pid, to: [SUBJECT], subject: `Invitation: ${ev.title} @ ${dateToken(ev.day, 'en')}`, body: { text: `You have been invited to: ${ev.title}\nWhen: ${spec.start}\nJoin: https://meet.workspace.example/${hex(ev.id, 10)}` }, noise: ['invite', 'notification'], addressee: nobody(), family: 'invite' });
    } else if (spec.organizer.pid === SUBJECT && g.chance(0.85)) {
      const who = g.pick(spec.attendees.filter((a) => a.pid !== SUBJECT && a.pid !== 'system'));
      if (!who) continue;
      g.mailMsg({ storyline: 'noise', label: evT.label, shares: evT.shares, kind: 'noise', noiseType: 'notification', acct: W, ts: addMin(created, g.int(30, 600)), by: who.pid, to: [SUBJECT], subject: `${g.pick(['Accepted', 'Accepted', 'Declined', 'Akzeptiert'])}: ${ev.title} @ ${dateToken(ev.day, 'en')}`, body: { text: `${g.person(who.pid).name} has responded to the invitation.` }, noise: ['invite', 'notification'], addressee: nobody(), family: 'invite-reply' });
    }
  }
  // Out-of-office autoreplies to Mara's sent mails (person addresses, machine text).
  const sent = g.items.filter((x) => x.source === 'gmail' && x.author === ACCOUNTS.work && g.mail.get(x.id)!.to.some((t) => ['claudia-steiner', 'kai-lund', 'daniel-weber', 'paul-keller'].includes(t.pid)));
  for (const s of sent.filter((_, i) => i % 3 === 0).slice(0, 10)) {
    const m = g.mail.get(s.id)!;
    const who = m.to.find((t) => ['claudia-steiner', 'kai-lund', 'daniel-weber', 'paul-keller'].includes(t.pid))!;
    const de = g.person(who.pid).langs[0] === 'de';
    g.mailMsg({ storyline: 'noise', label: 'none', kind: 'noise', noiseType: 'autoreply', acct: W, ts: addMin(s.ts, 1), by: who.pid, to: [SUBJECT], subject: `${de ? 'Abwesenheitsnotiz' : 'Automatic reply'}: ${m.subject}`, threadOf: s, body: { text: de ? `Vielen Dank für Ihre Nachricht. Ich bin bis ${dateToken(plusDays(s.day, 4), 'de')} abwesend und habe nur beschränkt Zugriff auf E-Mails.` : `Thanks for your message. I am out of office until ${dateToken(plusDays(s.day, 4), 'en')} with limited access to e-mail.` }, noise: ['autoreply'], addressee: nobody(), family: 'autoreply' });
  }
}

function personalMail(g: Gen): void {
  const P = 'personal';
  const add = (id: string, n: number, subj: () => string, text: () => string, label: string, noiseType: NoiseType, tags: NoiseTag[]) => {
    for (let i = 0; i < n; i++) {
      const day = g.pick(DAYS);
      const s = subj();
      g.mailMsg({ storyline: 's7-personal', label, kind: 'noise', noiseType, acct: P, ts: at(day, g.int(6 * 60, 21 * 60)), by: id, to: [ACCOUNTS.personal], subject: s, body: { text: text() }, noise: tags, addressee: nobody(), family: `personal:${id}` });
    }
  };
  add('p-bank', 8, () => g.pick(['Belastungsanzeige', 'Gutschrift erhalten', 'Neue Karte unterwegs', 'Kontoauszug verfügbar']), () => `Bank Zürichsee\nIhr Konto wurde mit CHF ${g.int(20, 2400)}.${String(g.int(0, 99)).padStart(2, '0')} belastet.`, 'personal/personal', 'notification', ['notification']);
  add('p-shop', 10, () => g.pick(['Bestellbestätigung 2026-', 'Ihre Rechnung', 'Danke für Ihre Bestellung']) + g.int(1000, 9999), () => `Bergsport Shop\nBestellung über CHF ${g.int(30, 400)}.90 eingegangen.`, 'personal/personal', 'notification', ['receipt', 'notification']);
  add('p-post', 10, () => `Ihre Sendung ${g.int(10_000_000, 99_999_999)} ist unterwegs`, () => 'Paketdienst\nIhre Sendung wird morgen zugestellt.', 'personal/personal', 'notification', ['notification']);
  add('p-school', 5, () => g.pick(['Elternabend 1. Klasse', 'Schulreise: Informationen', 'Herbstferien Betreuung']), () => 'Schule Wolkenhain\nLiebe Eltern, anbei die Informationen.', 'personal/personal', 'notification', ['notification']);
  add('p-nl-running', 4, () => 'Laufclub News September', () => 'Laufclub Zürich – News, Termine, Trainings.', 'none', 'newsletter', ['newsletter']);
  add('p-nl-kultur', 4, () => 'Kulturagenda: Tipps fürs Wochenende', () => 'Kulturagenda – Ausstellungen, Konzerte, Theater.', 'none', 'newsletter', ['newsletter']);
}

function calendar(g: Gen): void {
  // Recurring series (not recorded every time) + focus blocks + private + cancellations + all-day.
  const series: { title: string; dowN: number; time: string; minutes: number; attendees: string[]; organizer: string; label: string; skipDays?: string[] }[] = [
    { title: 'Booker Planning', dowN: 1, time: '13:30', minutes: 45, attendees: ['mara-keller', 'lea-vogt', 'chiara-romano', 'dmitry-sokolov'], organizer: 'lea-vogt', label: 'brightwell/booker' },
    { title: 'Alpenhof Weekly', dowN: 2, time: '09:30', minutes: 30, attendees: ['mara-keller', 'lea-vogt', 'claudia-steiner'], organizer: 'lea-vogt', label: 'alpenhof/relaunch' },
    { title: 'Jour fixe SWL', dowN: 3, time: '10:00', minutes: 45, attendees: ['mara-keller', 'tobias-hofer', 'marco-bernasconi'], organizer: 'tobias-hofer', label: 'swl/portal', skipDays: [wd(12), wd(17)] },
    { title: '1:1 Jonas / Mara', dowN: 4, time: '08:30', minutes: 45, attendees: ['mara-keller', 'jonas-brandt'], organizer: 'jonas-brandt', label: 'none', skipDays: [wd(8)] },
    { title: 'Booker Sync', dowN: 5, time: '11:00', minutes: 30, attendees: ['mara-keller', 'chiara-romano', 'sebastian-kraus'], organizer: 'mara-keller', label: 'brightwell/booker' },
  ];
  const cancelled = new Set<string>();
  for (const s of series) {
    const sid = b32(`series:${s.title}`, 22);
    for (const day of WORKDAYS.filter((d) => dow(d) === s.dowN)) {
      if (s.skipDays?.includes(day)) continue;
      const start = at(day, s.time);
      const cancel = !cancelled.has(s.title) && g.chance(0.18);
      if (cancel) cancelled.add(s.title);
      const label = s.label === 'none' ? (g.chance(0.5) ? 'brightwell/admin' : 'brightwell/sales') : s.label;
      g.calEvent({ storyline: 'background', label, kind: null, start, minutes: s.minutes, title: s.title, attendees: s.attendees, organizer: s.organizer, idSeed: `${sid}_${start.replace(/[-:]/g, '').slice(0, 15)}Z`,
        noise: ['recurring', ...(cancel ? ['cancelled' as NoiseTag] : []), ...(s.title === 'Booker Sync' ? ['over_broad_title' as NoiseTag] : [])], ...(cancel ? { cancelledAt: addMin(start, -g.int(2, 30) * 60) } : {}) });
    }
  }
  // Focus blocks and admin slots (no attendees).
  const FOCUS: [string, string][] = [['Fokus: Booker Preislogik', 'brightwell/booker'], ['Pitch-Deck vorbereiten', 'unregistered:zermatt-pitch'], ['Angebot Händlerportal', 'unregistered:velonord-b2b-portal'], ['Review Migrationsplan', 'unregistered:hosting-migration'], ['MWST-Belege sammeln', 'brightwell/admin'], ['Release-Plan MedTrack 2.4', 'medtrack/app'], ['DNS-Plan Alpenhof', 'alpenhof/relaunch'], ['Content-Modell lesen', 'klartext/content-hub'], ['Incident-Report SWL gegenlesen', 'swl/portal'], ['Bewerbungen sichten', 'brightwell/hiring']];
  for (let i = 0; i < 20; i++) {
    const [title, label] = FOCUS[i % FOCUS.length]!;
    const day = g.pick(WORKDAYS);
    g.calEvent({ storyline: 'background', label, kind: null, start: at(day, g.pick(['07:30', '13:00', '16:00', '17:00'])), minutes: g.pick([60, 90, 120]), title, attendees: [], organizer: SUBJECT, noise: label.startsWith('unregistered:') ? ['unregistered'] : [] });
  }
  // Private (personal/personal) incl. the dentist move (cancel + new) and the apartment viewing.
  const priv: [string, string, string, number, string[]][] = [
    ['Zahnarzt Kontrolle', wd(8), '07:30', 45, []], ['Zahnarzt Kontrolle', wd(18), '07:30', 45, []], ['Besichtigung Wohnung Hottingen', '2026-09-19', '10:00', 60, ['stefan-keller']],
    ['Elternabend', wd(11), '19:30', 90, ['stefan-keller']], ['Abendessen mit Freunden', '2026-09-26', '19:00', 180, ['stefan-keller']], ['Laufen', wd(3), '18:30', 60, []], ['Laufen', wd(13), '18:30', 60, []], ['Geburtstag Mama', '2026-09-27', '12:00', 240, ['stefan-keller']], ['Coiffeur', wd(14), '17:30', 60, []],
  ];
  for (const [title, day, time, minutes, att] of priv) {
    const cancel = title === 'Zahnarzt Kontrolle' && day === wd(8);
    g.calEvent({ storyline: 's7-personal', label: 'personal/personal', kind: null, start: at(day, time), minutes, title, attendees: att.length ? ['mara-keller', ...att] : [], organizer: SUBJECT, noise: ['private', ...(cancel ? ['cancelled' as NoiseTag] : [])], ...(cancel ? { cancelledAt: at(wd(7), '12:30') } : {}) });
  }
  // One-off client calls that were not recorded.
  const ONE: [string, string, string, number, string[], string, string][] = [
    ['Velo Nord Shop Review', wd(2), '15:00', 45, ['mara-keller', 'kai-lund', 'felix-wagner'], 'mara-keller', 'velonord/shop'],
    ['Kieselfeder Redaktion Check-in', wd(7), '11:00', 30, ['mara-keller', 'tobias-hofer', 'ines-wolf'], 'tobias-hofer', 'klartext/content-hub'],
    ['Trial day Elena', wd(19), '09:00', 480, ['mara-keller', 'elena-popescu', 'nina-brunner'], 'mara-keller', 'brightwell/hiring'],
    ['Pitch Probe', wd(17), '16:00', 60, ['mara-keller', 'jonas-brandt', 'nina-brunner'], 'jonas-brandt', 'unregistered:zermatt-pitch'],
    ['Steuerberatung Schmid', wd(14), '10:30', 60, ['mara-keller', 'petra-schmid'], 'petra-schmid', 'brightwell/admin'],
    ['Cutover-Planung Nordhost', wd(18), '14:00', 60, ['mara-keller', 'aleksandr-petrov', 'lars-eriksen'], 'aleksandr-petrov', 'unregistered:hosting-migration'],
    ['Velo Nord ERP Monitoring Review', wd(14), '11:00', 30, ['mara-keller', 'mette-hansen', 'aleksandr-petrov'], 'mara-keller', 'velonord/erp-sync'],
  ];
  for (const [title, day, time, minutes, att, org, label] of ONE) {
    const cancel = title === 'Velo Nord Shop Review';
    g.calEvent({ storyline: 'background', label, kind: null, start: at(day, time), minutes, title, attendees: att, organizer: org, noise: [...(label.startsWith('unregistered:') ? ['unregistered' as NoiseTag] : []), ...(cancel ? ['cancelled' as NoiseTag] : [])], ...(cancel ? { cancelledAt: addMin(at(day, time), -180) } : {}) });
  }
  // All-day markers.
  g.calEvent({ storyline: 's1-alpenhof', label: 'alpenhof/relaunch', kind: null, start: at(wd(16), '00:00'), minutes: 1440, allDay: true, title: 'Go-Live Alpenhof', attendees: [], organizer: SUBJECT });
  g.calEvent({ storyline: 's7-personal', label: 'personal/personal', kind: null, start: at('2026-10-02', '00:00'), minutes: 1440, allDay: true, title: 'Mara frei', attendees: [], organizer: SUBJECT, noise: ['private'] });
  g.calEvent({ storyline: 's6-internal', label: 'unregistered:zermatt-pitch', kind: null, start: at(wd(18), '00:00'), minutes: 1440, allDay: true, title: 'Zermatt (Pitch)', attendees: [], organizer: SUBJECT, noise: ['unregistered'] });
  // Fill up to ~90 with short internal syncs (mixed topics).
  let guard = 0;
  while (g.items.filter((x) => x.type === 'event').length < 90 && guard++ < 100) {
    const l = g.pick(['brightwell/booker', 'medtrack/app', 'swl/portal', 'alpenhof/retainer', 'brightwell/infra', 'brightwell/sales']);
    const day = g.pick(WORKDAYS);
    const owner = OWNER[l] ?? SUBJECT;
    g.calEvent({ storyline: 'background', label: l, kind: null, start: at(day, g.pick(['10:30', '14:30', '15:30', '16:30'])), minutes: g.pick([15, 30]), title: g.pick(['Kurzer Abgleich', 'Quick check', 'Abstimmung']) + ` ${l.split('/')[1]!.replace(/-/g, ' ')}`, attendees: uniq([SUBJECT, owner]), organizer: owner });
  }
}

function activity(g: Gen): void {
  const SUBJ: Record<string, string[]> = {
    'git.brightwell.example/brightwell/alpenhof-web': ['Add redirect map for old URLs', 'Spa page layout', 'Fix carousel lazy loading', 'Cookie banner texts DE/EN', 'Room overview filter'],
    'git.brightwell.example/brightwell/booker': ['Fix CHF rounding in embed mode', 'Rate plan caching', 'iCal export: skip cancelled', 'Release 1.9 changelog', 'Multi-property shared rate plans'],
    'git.brightwell.example/brightwell/infra': ['Rotate VPN certificates', 'CI runner image update', 'Backup retention 30 days', 'Status page config'],
    'git.brightwell.example/brightwell/nordhost-migration': ['Nordhost namespaces', 'DB dump/restore script', 'Cutover runbook draft', 'DNS TTL inventory'],
    'git.brightwell.example/brightwell/swl-portal': ['Session TTL back to 30 minutes', 'Outage banner component', 'Invoice download streaming'],
    'git.brightwell.example/brightwell/klartext-cms': ['Latin-1 to UTF-8 import conversion', 'Author profile importer'],
    'git.brightwell.example/brightwell/velonord-erp-bridge': ['Second sync worker', 'Queue length metric', 'Fix encoding in article export'],
    'git.brightwell.example/brightwell/velonord-shop': ['Shop domain switch', 'Norway shipping zone'],
    'git.brightwell.example/medtrack/app': ['Replace stale push tokens on heartbeat', 'Release plan 2.4 notes'],
    'git.brightwell.example/brightwell/zermatt-demo': [],
  };
  const PROMPTS: Record<string, string[]> = {
    'git.brightwell.example/brightwell/booker': ['why does the widget skip the rounding rule in embed mode', 'write a test for CHF rounding', 'review the rate plan cache invalidation'],
    'git.brightwell.example/brightwell/infra': ['plan the move of our sites to Nordhost managed kubernetes', 'estimate the cutover order for client sites', 'write a runbook for the database dump and restore', 'compare backup retention options'],
    'git.brightwell.example/brightwell/nordhost-migration': ['generate kubernetes manifests for the status page', 'script to dump and restore postgres per client'],
    'git.brightwell.example/brightwell/alpenhof-web': ['generate nginx redirect rules from this csv', 'check the dns cutover plan'],
    'git.brightwell.example/brightwell/swl-portal': ['why does the session store time out under load', 'draft an incident report timeline'],
    'git.brightwell.example/medtrack/app': ['how to detect stale fcm tokens on the backend'],
  };
  const target = 60;
  let guard = 0;
  while (g.items.filter((x) => x.type === 'activity').length < target && guard++ < 300) {
    const source = g.chance(0.42) ? 'git' : 'claude';
    const pool = Object.keys(source === 'git' ? SUBJ : PROMPTS).filter((r) => (source === 'git' ? SUBJ : PROMPTS)[r]!.length);
    const repo = g.pick(pool);
    const day = g.pick(WORKDAYS);
    const start = g.pick(['07:40', '13:10', '17:30', '19:45', '21:00']);
    const subjects = (source === 'git' ? SUBJ : PROMPTS)[repo]!;
    const n = g.int(1, Math.min(4, subjects.length));
    const picked = Array.from({ length: n }, (_, i) => subjects[(i + g.int(0, subjects.length - 1)) % subjects.length]!);
    const repoTruth = g.world.repos.find((r) => r.container === repo)?.initiative ?? 'none';
    // Claude sessions in the infra repo about the Nordhost move are migration work (unregistered), not infra.
    const migration = source === 'claude' && repo.endsWith('/infra') && picked.some((p) => /nordhost|cutover|dump/.test(p));
    const label = migration ? 'unregistered:hosting-migration' : repoTruth;
    g.work({ storyline: 'background', label, source, repo, day, start, minutes: g.int(20, 150), subjects: uniq(picked), noise: label.startsWith('unregistered:') ? ['unregistered'] : [], ...(migration ? { rung: 'content' as DecidableBy } : {}) });
  }
}

// =========================================================================================================
// Noise injection on human items (duplicates, bumps, near repeats, cross-posts, forwards, edits, tombstones).
// =========================================================================================================

function injectNoise(g: Gen): void {
  const humanMail = g.items.filter((x) => x.source === 'gmail' && x.account === ACCOUNTS.work && x.render.mode === 'human' && x.authorPerson !== SUBJECT && !g.tins.get(x.id)!.dedupType);
  const humanSlack = g.items.filter((x) => x.source === 'slack' && x.render.mode === 'human' && !g.slack.get(x.id)!.bot);
  // Exact duplicates: the same mail delivered twice (direct + via the team list).
  for (const m of pickN(g, humanMail, 15)) {
    const cluster = `dup-${m.id}`;
    const spec = g.mail.get(m.id)!;
    g.mailMsg({ storyline: g.tins.get(m.id)!.storyline, label: g.tins.get(m.id)!.label, shares: g.tins.get(m.id)!.shares, kind: g.tins.get(m.id)!.kind, acct: 'work', ts: addMin(m.ts, g.int(1, 3)), by: m.authorPerson!, fromRaw: spec.from, to: [LIST_ADDR], subject: spec.subject, threadOf: m, body: { derived: { from: m.id, op: {} } }, noise: [...(g.tins.get(m.id)!.noise ?? []), 'exact_dup'], addressee: g.tins.get(m.id)!.addressee ?? null, cluster, dedupType: 'exact', canonical: false });
    Object.assign(g.tins.get(m.id)!, { cluster, dedupType: 'exact' as DedupType, canonical: true });
  }
  // Bumps: "any update?" on unanswered questions/requests (Slack replies and mail replies).
  const BUMP: Record<Lang, string[]> = { de: ['Gibt es hier schon Neuigkeiten?', 'Kurzer Nachtrag: gibt es ein Update?'], en: ['Any update on this?', 'Friendly bump – any news?'], ru: ['Есть новости по этому?', 'Напомню про вопрос выше'], it: ['Ci sono novità?'], fr: ['Des nouvelles ?'] };
  const unanswered = humanSlack.filter((x) => ['question', 'request'].includes(g.tins.get(x.id)!.kind ?? '') && !g.answered.has(x.id) && !g.slack.get(x.id)!.rootId && x.authorPerson !== SUBJECT);
  for (const q of pickN(g, unanswered, 7)) {
    const lang = q.render.mode === 'human' ? q.render.beat.lang : 'en';
    const cluster = `bump-${q.id}`;
    g.slackMsg({ storyline: g.tins.get(q.id)!.storyline, label: g.tins.get(q.id)!.label, shares: g.tins.get(q.id)!.shares, kind: 'request', lang, ch: g.slack.get(q.id)!.ch.name, ts: addMin(q.ts, g.int(24 * 60, 48 * 60)), by: q.authorPerson!, root: q, body: { text: g.pick(BUMP[lang]) }, noise: ['bump'], addressee: g.tins.get(q.id)!.addressee ?? null, cluster, dedupType: 'bump', canonical: false, expectsReply: true });
    Object.assign(g.tins.get(q.id)!, { cluster, dedupType: 'bump' as DedupType, canonical: true });
  }
  const unansweredMail = humanMail.filter((x) => ['question', 'request'].includes(g.tins.get(x.id)!.kind ?? '') && !g.answered.has(x.id) && !g.tins.get(x.id)!.dedupType);
  for (const q of pickN(g, unansweredMail, 5)) {
    const lang = q.render.mode === 'human' ? q.render.beat.lang : 'en';
    const spec = g.mail.get(q.id)!;
    const cluster = `bump-${q.id}`;
    g.mailMsg({ storyline: g.tins.get(q.id)!.storyline, label: g.tins.get(q.id)!.label, shares: g.tins.get(q.id)!.shares, kind: 'request', acct: 'work', ts: addMin(q.ts, g.int(36 * 60, 72 * 60)), by: q.authorPerson!, to: spec.to.map((t) => (t.pid === 'system' ? t.raw : t.pid)), subject: spec.subject.startsWith('Re:') ? spec.subject : `Re: ${spec.subject}`, threadOf: q, body: { derived: { from: q.id, op: { prefix: `${g.pick(BUMP[lang])}\n\n`, quote: true } } }, noise: ['bump'], addressee: g.tins.get(q.id)!.addressee ?? null, cluster, dedupType: 'bump', canonical: false, expectsReply: true });
    Object.assign(g.tins.get(q.id)!, { cluster, dedupType: 'bump' as DedupType, canonical: true });
  }
  // Near repeats: a request re-sent with a short preface (different thread, same content).
  for (const m of pickN(g, humanMail.filter((x) => g.tins.get(x.id)!.kind === 'request' && !g.tins.get(x.id)!.dedupType), 6)) {
    const spec = g.mail.get(m.id)!;
    const lang = m.render.mode === 'human' ? m.render.beat.lang : 'en';
    const cluster = `near-${m.id}`;
    g.mailMsg({ storyline: g.tins.get(m.id)!.storyline, label: g.tins.get(m.id)!.label, shares: g.tins.get(m.id)!.shares, kind: 'request', acct: 'work', ts: addMin(m.ts, g.int(2 * 24 * 60, 4 * 24 * 60)), by: m.authorPerson!, to: spec.to.map((t) => (t.pid === 'system' ? t.raw : t.pid)), subject: spec.subject, body: { derived: { from: m.id, op: { prefix: lang === 'de' ? 'Nochmals, falls das untergegangen ist:\n\n' : 'Resending in case this got lost:\n\n' } } }, noise: ['near_repeat'], addressee: g.tins.get(m.id)!.addressee ?? null, cluster, dedupType: 'near', canonical: false, expectsReply: true });
    Object.assign(g.tins.get(m.id)!, { cluster, dedupType: 'near' as DedupType, canonical: true });
  }
  // Cross-posts: a client mail pasted into the client channel by Mara; a #general announcement into a client channel.
  const XCH: Record<string, string> = { 'alpenhof/relaunch': 'ext-alpenhof', 'alpenhof/retainer': 'ext-alpenhof', 'velonord/shop': 'ext-velonord', 'velonord/erp-sync': 'ext-velonord', 'swl/portal': 'ext-swl', 'medtrack/app': 'ext-medtrack', 'klartext/content-hub': 'ext-klartext-cms' };
  for (const m of pickN(g, humanMail.filter((x) => XCH[g.tins.get(x.id)!.label ?? ''] && !g.tins.get(x.id)!.dedupType), 6)) {
    const cluster = `xp-${m.id}`;
    const chn = XCH[g.tins.get(m.id)!.label!]!;
    g.slackMsg({ storyline: g.tins.get(m.id)!.storyline, label: g.tins.get(m.id)!.label, kind: 'info', ch: chn, ts: addMin(m.ts, g.int(10, 180)), by: SUBJECT, body: { derived: { from: m.id, op: { prefix: 'Aus dem Mail-Verkehr, zur Info:\n', quote: true } } }, noise: ['crosspost'], addressee: nobody({ broadcast: true }), cluster, dedupType: 'crosspost', canonical: false });
    Object.assign(g.tins.get(m.id)!, { cluster, dedupType: 'crosspost' as DedupType, canonical: true });
  }
  const general = humanSlack.filter((x) => g.slack.get(x.id)!.ch.name === 'general' && g.tins.get(x.id)!.kind === 'info' && !g.slack.get(x.id)!.rootId && !g.tins.get(x.id)!.dedupType);
  for (const m of pickN(g, general, 3)) {
    const cluster = `xp-${m.id}`;
    g.slackMsg({ storyline: g.tins.get(m.id)!.storyline, label: g.tins.get(m.id)!.label, kind: 'info', ch: 'booker', ts: addMin(m.ts, g.int(2, 30)), by: m.authorPerson!, body: { derived: { from: m.id, op: {} } }, noise: ['crosspost'], addressee: g.tins.get(m.id)!.addressee ?? null, cluster, dedupType: 'crosspost', canonical: false });
    Object.assign(g.tins.get(m.id)!, { cluster, dedupType: 'crosspost' as DedupType, canonical: true });
  }
  // Forwards: client mails Mara forwards to a colleague.
  for (const m of pickN(g, humanMail.filter((x) => !g.tins.get(x.id)!.dedupType && OWNER[g.tins.get(x.id)!.label ?? ''] && OWNER[g.tins.get(x.id)!.label!] !== SUBJECT), 7)) {
    const spec = g.mail.get(m.id)!;
    const owner = OWNER[g.tins.get(m.id)!.label!]!;
    const cluster = `fwd-${m.id}`;
    g.mailMsg({ storyline: g.tins.get(m.id)!.storyline, label: g.tins.get(m.id)!.label, shares: g.tins.get(m.id)!.shares, kind: 'request', acct: 'work', ts: addMin(m.ts, g.int(15, 240)), by: SUBJECT, to: [owner], subject: `Fwd: ${spec.subject}`,
      body: { derived: { from: m.id, op: { prefix: `${g.pick(['Kannst du das übernehmen?', 'FYI, can you take this?', 'Zur Info, bitte kurz anschauen.'])}\n\n---------- Forwarded message ---------\nFrom: ${spec.from}\nSubject: ${spec.subject}\n\n` } } },
      noise: ['forward'], addressee: to([owner], 'explicit'), cluster, dedupType: 'forward', canonical: false, expectsReply: false });
    Object.assign(g.tins.get(m.id)!, { cluster, dedupType: 'forward' as DedupType, canonical: true });
  }
  // Tombstones: a handful of human Slack messages deleted minutes after posting (wrong channel, pasted secret).
  for (const m of pickN(g, humanSlack.filter((x) => !g.slack.get(x.id)!.replies.length && !g.slack.get(x.id)!.edit && !g.tins.get(x.id)!.dedupType && !g.answered.has(x.id) && ![...g.answered.values()].includes(x.id)), 6)) {
    g.slack.get(m.id)!.deleteAt = addMin(m.ts, g.int(1, 20));
    g.tins.get(m.id)!.noise = [...(g.tins.get(m.id)!.noise ?? []), 'tombstone'];
  }
  // Edits beyond the background ones, so ~16 re-emits in total.
  const editsNow = () => [...g.slack.values()].filter((s) => s.edit).length;
  for (const m of humanSlack) {
    if (editsNow() >= 16) break;
    const s = g.slack.get(m.id)!;
    if (!s.edit && !s.deleteAt && g.chance(0.05)) s.edit = { at: addMin(m.ts, g.int(2, 25)), op: g.pick(['typo', 'truncate'] as const) };
  }
}
function pickN<T>(g: Gen, xs: T[], n: number): T[] {
  const pool = [...xs];
  const out: T[] = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(g.r() * pool.length), 1)[0]!);
  return out;
}

// =========================================================================================================
// Final pass: raw lines, identities, truth.
// =========================================================================================================

const SCRUB = { withheld: false, kinds: [] as string[], redactions: 0 };

function slackLines(g: Gen, it: PlannedItem): void {
  const s = g.slack.get(it.id)!;
  const team = ACCOUNTS.slackTeam;
  const rootSpec = s.rootId ? g.slack.get(s.rootId)! : undefined;
  const occ: IdentityOcc[] = [];
  const parts: string[] = [];
  const pushPart = (raw: string, pid: string, field: IdentityOcc['field']) => {
    if (parts.includes(raw)) return;
    parts.push(raw);
    if (pid === 'system') occ.push(g.sysOcc(field, raw));
    else {
      const p = g.person(pid);
      const f = p.forms.find((x) => x.raw === raw && (x.form === 'slack_label' || x.form === 'opaque_id')) ?? g.register(p, raw, 'slack_label', 'slack');
      occ.push(g.occOf(field, pid, f));
    }
  };
  const lbl = (pid: string) => (pid === 'marco-rossi' && s.opaque ? 'U0BWMRSGST1' : g.label(pid, it.day));
  // Puller order: author (users), DM/mpim members, mentions, reply_users; a bot author is unshifted first.
  if (s.bot) pushPart(s.author, 'system', 'author');
  else pushPart(s.author, s.authorPid, 'author');
  if (s.ch.kind === 'dm' || s.ch.kind === 'mpim') for (const m of s.ch.members) pushPart(lbl(m), m, 'participant');
  for (const m of s.mentions) if (m !== 'aven') pushPart(lbl(m), m, 'participant');
  for (const r of s.replies) {
    const rs = g.slack.get(r)!;
    if (!rs.bot) pushPart(rs.author, rs.authorPid, 'participant');
  }
  g.occ.set(it.id, occ);
  const rawRef = `slack:${team}/${s.ch.id}/${s.tsStr}${rootSpec ? `#${rootSpec.tsStr}` : ''}`;
  const permalink = `${ACCOUNTS.slackUrl}archives/${s.ch.id}/p${s.tsStr.replace('.', '')}${rootSpec ? `?thread_ts=${rootSpec.tsStr}&cid=${s.ch.id}` : ''}`;
  const record = (): Record<string, unknown> => {
    const r: Record<string, unknown> = { source: 'slack', account: team, container: it.container, id: `${s.ch.id}:${s.tsStr}`, ts: it.ts, author: s.author, participants: parts };
    if (rootSpec) r.subject = null;
    r.text = it.rendered ? it.text : null;
    r.permalink = permalink;
    r.raw_ref = rawRef;
    if (s.botFlag) r.is_bot = true;
    r.scrub = SCRUB;
    return r;
  };
  const fills = (op?: DeriveOp): Fill[] => [...(rootSpec ? [{ path: 'subject', item: s.rootId!, part: 'text' as const, op: { re60: true } }] : []), ...(!it.rendered || op ? [{ path: 'text', item: it.id, part: 'text' as const, ...(op ? { op } : {}) }] : [])];
  const file = 'slack/slack.messages.jsonl';
  const emit = addMin(it.ts, 3);
  if (s.edit) {
    const first = record();
    first.text = null;
    it.lines.push({ file, at: emit, record: first, fill: fills({ perturb: s.edit.op }) });
    it.lines.push({ file, at: s.edit.at > emit ? s.edit.at : addMin(emit, 1), record: record(), fill: fills() });
  } else it.lines.push({ file, at: emit, record: record(), fill: fills() });
  if (s.deleteAt) it.lines.push({ file, at: s.deleteAt > emit ? s.deleteAt : addMin(emit, 1), record: { source: 'slack', account: team, id: `${s.ch.id}:${s.tsStr}`, deleted: true }, fill: [] });
}

function mailLines(g: Gen, it: PlannedItem): void {
  const m = g.mail.get(it.id)!;
  const participants = uniq([m.from, ...m.to.map((x) => x.raw), ...m.cc.map((x) => x.raw)].map((x) => x.toLowerCase()));
  const record: Record<string, unknown> = {
    source: 'gmail',
    account: m.acct,
    container: m.folder,
    id: m.msgId,
    ts: it.ts,
    author: m.from.toLowerCase(),
    participants,
    subject: m.subject,
    text: it.rendered ? it.text : null,
    permalink: `https://mail.google.com/mail/?authuser=${encodeURIComponent(m.acct)}#all/${m.msgId}`,
    raw_ref: `gmail:${m.acct}/${m.threadId}/${m.msgId}`,
    scrub: SCRUB,
  };
  it.lines.push({ file: `google/${m.acct}/messages.jsonl`, at: addMin(it.ts, 2), record, fill: it.rendered ? [] : [{ path: 'text', item: it.id, part: 'text' }] });
}

function taskLines(g: Gen, it: PlannedItem): void {
  const s = g.task.get(it.id)!;
  const account = it.account;
  const comments = s.comments.map((id) => g.byId.get(id)!).sort((a, b) => a.ts.localeCompare(b.ts));
  const lastComment = comments.length ? comments[comments.length - 1]!.ts : it.ts;
  const times = uniq([...s.statuses.map((x) => x.at), ...(lastComment > s.statuses[s.statuses.length - 1]!.at ? [lastComment] : []), ...(s.renameAt && it.ts < s.renameAt && s.statuses[s.statuses.length - 1]!.at < s.renameAt ? [addMin(s.renameAt, 5)] : [])]).sort();
  for (const t of times) {
    const st = [...s.statuses].reverse().find((x) => x.at <= t) ?? s.statuses[0]!;
    const renamed = s.renameAt && t >= s.renameAt;
    const project = renamed ? 'KH' : s.project;
    const key = `${project}-${s.num}`;
    const cs = comments.filter((c) => c.ts <= t);
    const record: Record<string, unknown> = {
      source: s.tracker,
      account,
      id: s.taskId,
      key,
      title: it.title,
      status: st.status,
      statusCategory: categoryFromName(st.status),
      assignee: s.assignee?.raw ?? '',
      reporter: s.reporter.raw,
      due: s.due,
      created: it.ts,
      updated: t,
      project,
      url: s.tracker === 'jira' ? `https://${account}/browse/${key}` : `https://${account}/issue/${key}`,
      labels: s.labels,
      text: it.rendered ? it.text : null,
      comments: cs.map((c) => ({ id: g.comment.get(c.id)!.commentId, author: g.comment.get(c.id)!.author.raw, ts: c.ts, text: c.rendered ? c.text : null })),
      scrub: SCRUB,
    };
    const fill: Fill[] = [...(it.rendered ? [] : [{ path: 'text', item: it.id, part: 'text' as const }]), ...cs.map((c, i) => ({ path: `comments.${i}.text`, item: c.id, part: 'text' as const })).filter((f) => !g.byId.get(f.item)!.rendered)];
    it.lines.push({ file: `${s.tracker}/${account}/tasks.jsonl`, at: addMin(t, 1), record, fill });
  }
}

function eventLines(g: Gen, it: PlannedItem): void {
  const e = g.event.get(it.id)!;
  const file = `google/${ACCOUNTS.work}/events.jsonl`;
  const link = `https://calendar.workspace.example/event?eid=${hex(e.eventId, 24)}`;
  it.lines.push({ file, at: e.createdAt, record: { source: 'gcal', account: ACCOUNTS.work, id: e.eventId, calendar: ACCOUNTS.work, start: e.start, end: e.end, title: it.title, attendees: uniq(e.attendees.map((a) => a.raw.toLowerCase())), organizer: e.organizer.raw.toLowerCase(), link }, fill: [] });
  if (e.cancelledAt) it.lines.push({ file, at: e.cancelledAt, record: { source: 'gcal', account: ACCOUNTS.work, id: e.eventId, calendar: ACCOUNTS.work, start: e.start, end: '', title: '', attendees: [], organizer: '', link, deleted: true }, fill: [] });
}

function meetingLines(g: Gen, it: PlannedItem): void {
  const m = g.meet.get(it.id)!;
  const record: Record<string, unknown> = {
    source: m.recorder,
    account: it.account,
    id: m.meetingId,
    title: it.title,
    start: m.start,
    end: m.end,
    attendees: m.attendees,
    summary: null,
    next_steps: null,
    transcript: null,
    url: m.url,
    text: null,
    scrub: { ...SCRUB, transcript: 'passthrough' },
  };
  it.lines.push({ file: `meetings/${m.recorder}/${it.account}/meetings.jsonl`, at: m.emitAt, record, fill: [
    { path: 'summary', item: it.id, part: 'summary' },
    { path: 'next_steps', item: it.id, part: 'next_steps' },
    { path: 'transcript', item: it.id, part: 'transcript' },
    { path: 'text', item: it.id, part: 'flatten' },
  ] });
}

function activityLines(g: Gen, it: PlannedItem): void {
  const a = g.act.get(it.id)!;
  it.lines.push({ file: 'local/activity.jsonl', at: addMin(a.end, 15), record: { source: a.source, account: it.account, id: it.ref.split(':').pop(), container: a.container, start: a.start, end: a.end, minutes: a.minutes, title: it.title, items: a.items, scrub: { kinds: [], redactions: 0 } }, fill: [] });
}

/** Who must act on a human item when the script did not say: DM/mpim partner, the root's author, To:, assignee, the other side of a ticket. */
function defaultAddressee(g: Gen, it: PlannedItem, label: string): Addressee {
  const me = it.authorPerson;
  const others = (xs: (string | undefined | null)[]) => uniq(xs.filter((x): x is string => !!x && x !== me && x !== 'system' && g.isPerson(x)));
  if (it.source === 'slack') {
    const s = g.slack.get(it.id)!;
    if (s.ch.kind === 'dm' || s.ch.kind === 'mpim') return to(others(s.ch.members));
    if (s.rootId) {
      const root = others([g.byId.get(s.rootId)!.authorPerson]);
      if (root.length) return to(root);
    }
    const owner = others([OWNER[label]]);
    return owner.length ? to(owner, 'implicit', me && g.isPerson(me) && g.person(me).side !== 'us' ? { side: 'brightwell' } : {}) : nobody({ broadcast: true });
  }
  if (it.source === 'gmail') {
    const m = g.mail.get(it.id)!;
    const pids = others(m.to.map((x) => x.pid));
    return pids.length ? to(pids, 'explicit') : nobody();
  }
  if (it.type === 'task') {
    const s = g.task.get(it.id)!;
    const a = others([s.assignee?.pid, OWNER[label], SUBJECT]);
    return a.length ? to([a[0]!]) : nobody();
  }
  if (it.type === 'comment') {
    const s = g.task.get(g.comment.get(it.id)!.task)!;
    const o = others([me === s.reporter.pid ? s.assignee?.pid : s.reporter.pid, s.assignee?.pid, OWNER[label]]);
    return o.length ? to([o[0]!]) : nobody();
  }
  return nobody();
}

/** Which rung SHOULD decide an item, judged against what the GIVEN tenant knows (a simplified ladder). */
function rungOf(g: Gen, it: PlannedItem, t: TIn, label: string, multi: boolean): DecidableBy {
  if (t.rung) return t.rung;
  if (label === 'none') return it.render.mode === 'human' ? 'content' : 'rule';
  if (multi) return 'content';
  const keysTo = (k: string): string[] => Object.entries(GIVEN_SOURCES).filter(([, s]) => s.youtrack_prefixes.includes(k) || s.jira_keys.includes(k)).map(([id]) => (id === 'klartext/cms-migration' ? 'klartext/content-hub' : id));
  // 1. tenant rules (container rules, key rules) — first match
  const container = it.source === 'slack' ? it.container : null;
  const rule = GIVEN_RULES.find((r) => (r.when.container && container && r.when.container === container) || (r.when.project_key && it.keys.some((k) => k.split('-')[0] === r.when.project_key)));
  if (rule?.then.initiative) return rule.then.initiative === label ? (rule.when.container ? 'rule' : 'key') : 'content';
  if (rule?.then.candidates) return 'content';
  // 2. exclusive markers among the non-subject participants
  const pids = uniq([...(g.occ.get(it.id) ?? []).map((o) => o.truth).filter((x) => x !== 'system' && x !== SUBJECT && !x.includes('+'))]);
  const excl = uniq(pids.filter((p) => g.person(p).marker?.type === 'exclusive').flatMap((p) => g.person(p).marker!.initiatives));
  if (excl.length === 1) return excl[0] === label ? 'marker' : 'content';
  // 3. registry: repo, channel, keys, title
  if (it.type === 'activity') {
    const repo = it.container?.replace(/^[^/]+\//, '') ?? '';
    const hit = Object.entries(GIVEN_SOURCES).filter(([, s]) => s.repos.includes(repo)).map(([id]) => (id === 'klartext/cms-migration' ? 'klartext/content-hub' : id));
    if (hit.length === 1) return hit[0] === label ? 'rule' : 'content';
    return 'content';
  }
  if (container) {
    const hit = Object.entries(GIVEN_SOURCES).filter(([, s]) => s.slack_channels.includes(container)).map(([id]) => id);
    if (hit.length === 1) return hit[0] === label ? 'channel' : 'content';
  }
  const ks = uniq(it.keys.flatMap((k) => keysTo(k.split('-')[0]!)));
  if (ks.length === 1) return ks[0] === label ? 'key' : 'content';
  if ((it.type === 'meeting' || it.type === 'event') && it.title) {
    const tl = it.title.toLowerCase();
    const hit = uniq(Object.entries(GIVEN_SOURCES).filter(([, s]) => s.calendar_title_patterns.some((p) => tl.includes(p.toLowerCase()))).map(([id]) => (id === 'klartext/cms-migration' ? 'klartext/content-hub' : id)));
    if (hit.length === 1) return hit[0] === label ? 'title' : 'content';
  }
  if (it.thread && it.thread.index > 0 && it.render.mode === 'human') return 'context';
  return 'content';
}

function finalize(g: Gen): Truth {
  // Raw lines (identities of Slack items are fixed here, once replies are known).
  for (const it of g.items) {
    if (it.source === 'slack') slackLines(g, it);
    else if (it.source === 'gmail') mailLines(g, it);
    else if (it.type === 'task') taskLines(g, it);
    else if (it.type === 'event') eventLines(g, it);
    else if (it.type === 'meeting') meetingLines(g, it);
    else if (it.type === 'activity') activityLines(g, it);
  }
  // Thread sizes of comments (known only now).
  for (const s of g.task.values()) s.comments.forEach((c, i) => {
    const it = g.byId.get(c)!;
    it.thread = { root: it.thread!.root, index: i + 1, size: s.comments.length + 1 };
  });
  // Derived texts whose source is a template are final already; propagate once more in plan order.
  for (const it of g.items) {
    if (it.render.mode === 'derived' && !it.rendered && it.type !== 'meeting') {
      const src = g.byId.get(it.render.from);
      if (src?.rendered && src.text !== null) {
        it.text = applyDerive(src.text, it.render.op);
        it.rendered = true;
      }
    }
  }
  // Truth per item.
  // Ticket chains: the description (a request/incident) and every question/request comment are answered by the next
  // comment of someone else that is not itself a question.
  for (const s of g.task.values()) {
    const task = [...g.byId.values()].find((x) => g.task.get(x.id) === s)!;
    const chain = [task, ...s.comments.map((c) => g.byId.get(c)!).sort((a, b) => a.ts.localeCompare(b.ts))];
    chain.forEach((it, i) => {
      const k = g.tins.get(it.id)!.kind;
      if (!(k === 'question' || k === 'request' || k === 'incident') || g.answered.has(it.id)) return;
      const ans = chain.slice(i + 1).find((x) => x.authorPerson !== it.authorPerson && !['question', 'noise'].includes(g.tins.get(x.id)!.kind ?? ''));
      if (ans) g.answered.set(it.id, ans.id);
    });
  }
  // Commitments made in messages/comments join the call commitments; "kept by" links resolve by description.
  for (const it of g.items) {
    const t = g.tins.get(it.id)!;
    if (t.commit && t.kind === 'commitment') g.commitments.push({ id: `cm-${it.id}`, owner: t.commit.owner ?? it.authorPerson ?? SUBJECT, to: t.commit.to ?? [], due: t.commit.due, outcome: t.commit.outcome, keptBy: null, ref: it.ref, what: t.commit.what, item: it.id });
  }
  for (const c of g.commitments) c.keptBy = g.keptLinks.get(c.what) ?? c.keptBy ?? null;
  const commitmentsByItem = new Map<string, CommitmentTruth[]>();
  for (const c of g.commitments) commitmentsByItem.set(c.item, [...(commitmentsByItem.get(c.item) ?? []), { id: c.id, owner: c.owner, to: c.to, due: c.due, outcome: c.outcome, keptBy: c.keptBy ?? null }]);
  for (const it of g.items) {
    const t = g.tins.get(it.id)!;
    let shares = t.shares && t.shares.length ? aggregateShares(t.shares) : t.label && t.label !== 'none' ? one(t.label) : [];
    if (t.label === 'none') shares = [];
    const label = shares[0]?.id ?? 'none';
    const fromSubject = it.authorPerson === SUBJECT;
    const fromAgent = it.author === 'Aven';
    // Human = a person wrote it (template bumps and copies of human mail included); machine text sent from a
    // person's address (autoreplies, invitation responses) is not.
    const personAuthor = !!it.authorPerson && g.isPerson(it.authorPerson);
    const human = it.type === 'meeting' ? true : it.type === 'event' || it.type === 'activity' ? false : personAuthor && !fromAgent && !(t.noise ?? []).some((n) => n === 'autoreply' || n === 'invite');
    const multi = shares.length > 1;
    const noise = uniq([...(t.noise ?? []), ...(multi ? ['multi_initiative' as NoiseTag] : []), ...(label.startsWith('unregistered:') ? ['unregistered' as NoiseTag] : [])]);
    const occ = g.occ.get(it.id) ?? [];
    if (occ.some((o) => o.form === 'opaque_id')) noise.push('opaque_id');
    if (occ.some((o) => ['transliteration', 'umlaut_variant', 'typo', 'nickname', 'order_swapped', 'alias_email', 'login', 'login_org_suffix', 'first_name', 'role_mailbox'].includes(o.form))) noise.push('identity_variant');
    if (g.slack.get(it.id)?.edit) noise.push('edit');
    if (g.slack.get(it.id)?.deleteAt && !noise.includes('tombstone')) noise.push('tombstone');
    if (g.event.get(it.id)?.cancelledAt && !noise.includes('cancelled')) noise.push('cancelled');
    if (it.source === 'slack' && it.container === '#ops-alerts' && label !== 'brightwell/infra' && !noise.includes('stale_rule')) noise.push('stale_rule');
    const kind = it.type === 'event' || it.type === 'activity' || it.type === 'meeting' ? null : t.kind ?? (human ? 'info' : 'noise');
    const noiseType = kind === 'noise' ? t.noiseType ?? (human ? 'small_talk' : 'notification') : undefined;
    if (noiseType === 'small_talk' && !noise.includes('small_talk')) noise.push('small_talk');
    const expectsReply = t.expectsReply ?? (kind === 'question' || kind === 'request' || (kind === 'incident' && human));
    const answer = g.answered.get(it.id) ?? null;
    const commitments: CommitmentTruth[] = [...(commitmentsByItem.get(it.id) ?? [])];
    // Meeting copies carry the call's commitments.
    if (it.type === 'meeting') {
      const call = g.calls.find((c) => c.id === it.meeting!.call)!;
      const primary = g.byId.get(call.copies[0]!)!;
      if (primary.id !== it.id) commitments.push(...(commitmentsByItem.get(primary.id) ?? []));
    }
    const lang = it.render.mode === 'human' ? it.render.beat.lang : it.render.mode === 'derived' ? (() => { const s = g.byId.get(it.render.from); return s?.render.mode === 'human' ? s.render.beat.lang : t.lang ?? null; })() : t.lang ?? null;
    const truth: ItemTruth = {
      label,
      shares,
      decidableBy: rungOf(g, it, t, label, multi),
      cluster: t.cluster ?? it.ref,
      dedupType: t.dedupType ?? null,
      canonical: t.canonical ?? true,
      family: t.family ?? null,
      kind,
      ...(noiseType ? { noiseType } : {}),
      addressee: kind === null ? null : t.addressee ?? (kind === 'noise' ? nobody() : defaultAddressee(g, it, label)),
      expectsReply: kind === null ? false : expectsReply,
      answeredBy: answer,
      commitments,
      lang,
      human,
      fromSubject,
      fromAgent,
      incoming: human && !fromSubject && !fromAgent && it.type !== 'meeting',
      noise: uniq(noise),
      storyline: t.storyline,
      deleted: !!g.slack.get(it.id)?.deleteAt || !!g.event.get(it.id)?.cancelledAt,
      identities: occ,
    };
    it.truth = truth;
  }
  // Cluster ids → member refs (the canonical first); the canonical of a planned cluster is its first created member.
  const clusters = new Map<string, PlannedItem[]>();
  for (const it of g.items) if (it.truth.dedupType) clusters.set(it.truth.cluster, [...(clusters.get(it.truth.cluster) ?? []), it]);
  const dedup: DedupRow[] = [];
  for (const [id, members] of clusters) {
    if (members.length < 2) {
      for (const m of members) Object.assign(m.truth, { cluster: m.ref, dedupType: null, canonical: true });
      continue;
    }
    const canonical = members.find((m) => m.truth.canonical) ?? members[0]!;
    for (const m of members) m.truth.canonical = m === canonical;
    const type = members.find((m) => m !== canonical)?.truth.dedupType ?? canonical.truth.dedupType!;
    for (const m of members) m.truth.dedupType = type;
    dedup.push({ cluster_id: id, type, members: members.map((m) => m.ref), canonical: canonical.ref });
  }
  // Commitment keptBy refs, answers as refs in truth rows.
  const refOfId = (id: string | null | undefined) => (id ? g.byId.get(id)?.ref ?? null : null);
  const items: TruthItemRow[] = [];
  for (const it of g.items) {
    const t = it.truth;
    items.push({
      ref: it.ref, plan: it.id, unit: it.type === 'task' ? 'task' : it.type === 'comment' ? 'comment' : it.type, day: it.day, label: t.label, initiatives: t.shares, decidable_by: t.decidableBy, kind: t.kind, ...(t.noiseType ? { noise_type: t.noiseType } : {}),
      addressee: t.addressee, expects_reply: t.expectsReply, answered_by: refOfId(t.answeredBy), ...(t.commitments.length ? { commitments: t.commitments } : {}), lang: t.lang, noise: t.noise, cluster: t.cluster, storyline: t.storyline, human: t.human, incoming: t.incoming, deleted: t.deleted,
    });
    if (it.type === 'meeting') {
      const call = g.calls.find((c) => c.id === it.meeting!.call)!;
      if (call.topics.length > 1 && it.meeting!.recorder === 'granola') {
        call.topics.forEach((tp, i) => items.push({ ref: `${it.altRef}#${i + 1}`, plan: it.id, unit: 'meeting_topic', day: it.day, label: tp.label, initiatives: one(tp.label), decidable_by: 'content', kind: null, addressee: null, expects_reply: false, answered_by: null, lang: t.lang, noise: [], cluster: t.cluster, storyline: t.storyline, human: true, incoming: false, deleted: false }));
      }
    }
  }
  // Thread-level rows for multi-message store threads (Slack replies, mail threads).
  const byThread = new Map<string, PlannedItem[]>();
  for (const it of g.items) if (it.type === 'message') byThread.set(it.threadId, [...(byThread.get(it.threadId) ?? []), it]);
  for (const [tid, members] of byThread) {
    if (members.length < 2) continue;
    const live = members.filter((m) => !m.truth.deleted);
    const shares = aggregateShares(live.flatMap((m) => m.truth.shares.map((x) => ({ id: x.id, share: x.share }))));
    items.push({ ref: `thread:${tid}`, plan: members[0]!.id, unit: 'thread', day: members[0]!.day, label: shares[0]?.id ?? 'none', initiatives: shares, decidable_by: members[0]!.truth.decidableBy, kind: null, addressee: null, expects_reply: false, answered_by: null, lang: members[0]!.truth.lang, noise: uniq(live.flatMap((m) => m.truth.noise)), cluster: `thread:${tid}`, storyline: members[0]!.truth.storyline, human: live.some((m) => m.truth.human), incoming: false, deleted: false });
  }
  // Identities: one row per raw string as the store sees it.
  const idRows = new Map<string, IdentityRow & { truths: Set<string> }>();
  for (const it of g.items) {
    for (const o of it.truth.identities) {
      const row = idRows.get(o.raw);
      if (row) {
        row.seen++;
        if (!row.fields.includes(o.field)) row.fields.push(o.field);
        if (!row.sources.includes(it.source)) row.sources.push(it.source);
        row.truths.add(o.truth);
        continue;
      }
      const persons = o.truth === 'system' ? [] : o.truth.split('+');
      idRows.set(o.raw, { raw: o.raw, truth: o.truth, given: persons.length > 0 && persons.every((p) => g.person(p).given), form: o.form, expected: o.expected, fields: [o.field], sources: [it.source], seen: 1, first_ref: it.ref, ...(o.ambiguous ? { ambiguous: o.ambiguous } : {}), truths: new Set([o.truth]) });
    }
  }
  const identities: IdentityRow[] = [...idRows.values()].map(({ truths, ...r }) => (truths.size > 1 ? { ...r, truth: `ambiguous:${sorted([...truths]).join(',')}`, expected: 'question' as const, ambiguous: sorted([...truths]) } : r)).sort((a, b) => a.raw.localeCompare(b.raw));
  const roster = truthRoster(g.world);
  // Pattern members: fill the widget-price pattern from its cluster; the Nordhost pattern from its alerts and tickets.
  for (const p of g.patterns) if (!p.members.length) p.members = g.items.filter((x) => x.truth.cluster === 'tdup-widget-prices').map((x) => x.ref);
  const nh = g.items.filter((x) => (x.text ?? '').includes('nh-k8s-01.nordhost.example') && x.truth.canonical && x.source === 'slack').slice(0, 6);
  const ops = g.items.filter((x) => x.type === 'task' && x.truth.label === 'unregistered:hosting-migration');
  if (nh.length) g.patterns.push({ pattern_id: 'p-nordhost-cluster', initiative: 'unregistered:hosting-migration', members: [...nh, ...ops].map((x) => x.ref), first_seen: nh[0]!.day, last_seen: nh[nh.length - 1]!.day, note: 'new hosting cluster: alerts on an unregistered host + OPS tickets the key routes to infra' });
  const commitments = g.commitments.map((c) => ({ id: c.id, owner: c.owner, to: c.to, due: c.due, outcome: c.outcome, keptBy: refOfId(c.keptBy), ref: c.ref, what: c.what }));
  return { items, dedup, identities, roster, patterns: g.patterns, commitments };
}

/** The truth roster: every person with every surface form (and whether the GIVEN people file lists it). */
export function truthRoster(world: World): RosterEntry[] {
  return world.people.map((p) => ({ person_id: p.id, name: p.name, company: p.company, side: p.side, given: p.given, forms: p.forms }));
}

// =========================================================================================================
// The GIVEN tenant (spec §2.7): what the pipeline is handed — imperfect on purpose.
// =========================================================================================================

interface GivenRule {
  id: string;
  when: { container?: string; project_key?: string };
  then: { initiative?: string; candidates?: string[] };
}
const GIVEN_RULES: GivenRule[] = [
  { id: 'r-ext-alpenhof', when: { container: '#ext-alpenhof' }, then: { initiative: 'alpenhof/relaunch' } }, // retainer items misroute
  { id: 'r-ext-velonord', when: { container: '#ext-velonord' }, then: { initiative: 'velonord/shop' } }, // erp-sync and dealer-portal items misroute
  { id: 'r-ext-swl', when: { container: '#ext-swl' }, then: { initiative: 'swl/portal' } },
  { id: 'r-ext-medtrack', when: { container: '#ext-medtrack' }, then: { initiative: 'medtrack/app' } },
  { id: 'r-ext-klartext', when: { container: '#ext-klartext-cms' }, then: { initiative: 'klartext/content-hub' } }, // stale after the channel rename
  { id: 'r-booker', when: { container: '#booker' }, then: { initiative: 'brightwell/booker' } },
  { id: 'r-hiring', when: { container: '#hiring' }, then: { initiative: 'brightwell/hiring' } },
  { id: 'r-sales', when: { container: '#sales' }, then: { initiative: 'brightwell/sales' } }, // the Zermatt pitch hides here
  { id: 'r-ops-alerts', when: { container: '#ops-alerts' }, then: { initiative: 'brightwell/infra' } }, // stale: wrong per item
  { id: 'r-deploys', when: { container: '#deploys' }, then: { candidates: ['alpenhof/relaunch', 'velonord/shop', 'velonord/erp-sync', 'swl/portal', 'brightwell/booker', 'klartext/content-hub', 'medtrack/app', 'brightwell/infra'] } },
  { id: 'r-key-swl', when: { project_key: 'SWL' }, then: { initiative: 'swl/portal' } },
  { id: 'r-key-mt', when: { project_key: 'MT' }, then: { initiative: 'medtrack/app' } },
  { id: 'r-key-kh', when: { project_key: 'KH' }, then: { initiative: 'klartext/content-hub' } },
  { id: 'r-key-kt', when: { project_key: 'KT' }, then: { initiative: 'klartext/content-hub' } },
  { id: 'r-key-bkr', when: { project_key: 'BKR' }, then: { initiative: 'brightwell/booker' } }, // support tickets misroute
  { id: 'r-key-ops', when: { project_key: 'OPS' }, then: { initiative: 'brightwell/infra' } }, // migration tickets misroute
];

export function givenTenant(world: World): GivenTenant {
  const umbrellaName: Record<string, string> = { alpenhof: 'Alpenhof Hotels', velonord: 'Velo Nord', swl: 'Stadtwerke Lindquell', medtrack: 'MedTrack', klartext: 'Kieselfeder Verlag', brightwell: 'Brightwell Digital (internal)', personal: 'Private' };
  const billing: Record<string, string> = { alpenhof: '30 h/month retainer + fixed-price relaunch', velonord: 'hourly, report only', swl: '60 h/month + SLA', medtrack: 'T&M in half-days', klartext: 'fixed price', brightwell: 'non-billable', personal: 'not work' };
  const peopleOf = (id: string) => world.people.filter((p) => p.given && p.marker?.initiatives.includes(id)).map((p) => ({ email_or_name: p.email ?? p.name, role: p.role }));
  const registered = world.initiatives.filter((i) => i.registered);
  const initiatives = [
    ...registered.map((i) => {
      const s = GIVEN_SOURCES[i.id]!;
      return {
        id: i.id, umbrella: i.umbrella, company: i.company, name: i.name, status: i.status, billing_code: i.billing_code,
        sources: { repos: s.repos, jira_keys: s.jira_keys, confluence_spaces: [], youtrack_prefixes: s.youtrack_prefixes, slack_channels: s.slack_channels, teams_channels: [], calendar_title_patterns: s.calendar_title_patterns, local_paths: [] },
        people: peopleOf(i.id), provenance: [{ kind: 'manual', ref: 'bench-agency seed' }],
      };
    }),
    // The pre-rename id lives on as an alias, carrying the old key, repo and title pattern.
    (() => {
      const s = GIVEN_SOURCES['klartext/cms-migration']!;
      return { id: 'klartext/cms-migration', umbrella: 'klartext', company: 'klartext', name: 'CMS migration (renamed to Content Hub)', status: 'alias', billing_code: 'KT-HUB', sources: { repos: s.repos, jira_keys: [], confluence_spaces: [], youtrack_prefixes: s.youtrack_prefixes, slack_channels: [], teams_channels: [], calendar_title_patterns: s.calendar_title_patterns, local_paths: [] }, people: [], provenance: [{ kind: 'manual', ref: `renamed ${RENAME_DAY}` }], notes: 'Renamed by the client; history stays attributable through the alias.', alias_of: 'klartext/content-hub' };
    })(),
  ];
  const umbrellas = Object.fromEntries(Object.keys(umbrellaName).map((u) => [u, { name: umbrellaName[u], billing: billing[u] }]));
  const companies = world.companies.filter((c) => c.umbrella).map((c) => ({ id: c.id, umbrella: c.umbrella, name: c.name, notes: c.domains.join(', ') }));
  const registry = { generated: UNTIL, schema: 'bench-agency/initiatives v1 (synthetic, hand-seeded)', umbrellas, companies, initiatives, people: {}, identities: {}, notes: { scope: 'Snapshot as of the end of the window; deliberately incomplete (see the lab spec 05 §2.7).' } };
  const people = world.people.filter((p) => p.given).map((p) => ({
    person_id: p.id,
    name: p.name,
    company: p.company,
    identities: uniq(p.forms.filter((f) => f.given).map((f) => (f.form === 'slack_label' ? `slack:${f.raw}` : f.raw))),
    ...(p.marker ? { marker: p.marker } : {}),
  }));
  const rules = GIVEN_RULES.map((r) => ({ ...r, origin: 'owner', created: '2026-09-01', note: 'seeded for the bench' }));
  const attribution = {
    subject: world.subject,
    since: world.since,
    threadGapMinutes: 45,
    substance: true,
    admin: ADMIN_OF,
    parallelSessions: 'sum',
    pinAfterDays: 1,
    budgets: [
      { umbrella: 'alpenhof', unit: 'hour', unitMinutes: 60, perMonth: 30, by: 'initiative' },
      { umbrella: 'swl', unit: 'hour', unitMinutes: 60, perMonth: 60, by: 'initiative' },
      { umbrella: 'medtrack', unit: 'half_day', unitMinutes: 240, by: 'initiative' },
    ],
  };
  return {
    'initiatives.json': registry,
    'annotations/people.json': people,
    'annotations/rules.json': rules,
    'annotations/attribution.json': attribution,
    'annotations/fragments.jsonl': '',
  };
}

// =========================================================================================================
// Meetings: style one call's rendered content per recorder (deterministic).
// =========================================================================================================

/** Summary / transcript / next steps of a meeting copy in its recorder's style, from the call's rendered content. */
export function formatCopy(copy: PlannedItem, content: CallContent): { summary: string; transcript: string; next_steps: string[] } {
  const style = copy.meeting!.style;
  const multi = content.topics.length > 1;
  let summary: string;
  if (style === 'granola') {
    const topics = content.topics.map((t) => (multi ? `## ${t.heading}\n\n${bullets(t.body)}` : bullets(t.body))).join('\n\n');
    const steps = content.nextSteps.map((s) => `- ${s.text} (${s.ownerLabel})`).join('\n');
    summary = `${content.intro}\n\n${topics}${steps ? `\n\n### Next Steps\n\n${steps}` : ''}`;
  } else if (style === 'gmeet') {
    const day = copy.ts.slice(0, 10);
    const topics = content.topics.map((t) => `${t.heading}\n${bullets(t.body, '* ')}`).join('\n\n');
    // Gemini mostly writes "<Name> will …" (which the production parser skips); bracketed owners on alternate copies.
    const bracket = fnv1a(copy.id) % 2 === 0;
    const steps = content.nextSteps.map((s) => (bracket ? `* [${s.ownerLabel}] ${s.text}` : `* ${s.ownerLabel} will ${s.text}`)).join('\n');
    summary = `📝 Notes\n${day}\nInvited ${copy.meeting!.invited ?? ''}\nAttachments ${copy.title}\nMeeting records Transcript\n\nSummary\n${content.intro}\n\n${topics}${steps ? `\n\nSuggested next steps\n${steps}` : ''}`;
  } else {
    const topics = content.topics.map((t) => `### ${t.heading}\n${bullets(t.body)}`).join('\n\n');
    const steps = content.nextSteps.map((s) => `- (${s.ownerLabel}) ${s.text}`).join('\n');
    summary = `${content.intro}\n\n${topics}${steps ? `\n\n### Next Steps\n${steps}` : ''}`;
  }
  const transcript = style === 'granola'
    ? content.transcript.map((x) => `${x.speaker === 'Mara Keller' ? 'Me' : 'Them'}: ${x.text}`).join('\n')
    : style === 'gmeet'
      ? `${copy.ts.slice(0, 10)}\n${copy.title} - Transcript\n\n${content.transcript.map((x) => `${x.speaker}: ${x.text}`).join('\n')}`
      : `<<<transcript>>>\n${content.transcript.map((x) => `${x.speaker}: ${x.text}`).join('\n')}`;
  return { summary, transcript, next_steps: extractNextSteps(summary) };
}
function bullets(body: string, mark = '- '): string {
  return body
    .split(/\n+|(?<=[.!?])\s+(?=[A-ZÄÖÜА-Я])/u)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `${mark}${s}`)
    .join('\n');
}
/** The meeting record's `text` field as the puller computes it. */
export const meetingText = (title: string, summary: string, nextSteps: string[]): string => flatten({ title, summary, next_steps: nextSteps });

// =========================================================================================================
// Build + write.
// =========================================================================================================

export function buildPlan(seed = 1): Plan {
  const g = new Gen(seed);
  s1Alpenhof(g);
  s2VeloNord(g);
  s3Swl(g);
  s4MedTrack(g);
  s5KlarText(g);
  s6Internal(g);
  s7Personal(g);
  s8Ambiguity(g);
  backgroundTickets(g);
  backgroundSlack(g);
  backgroundAgent(g);
  backgroundBots(g);
  backgroundMail(g);
  calendar(g);
  activity(g);
  machineMail(g);
  personalMail(g);
  injectNoise(g);
  // Plan order = time order (ties by creation): readers replay days in order.
  const order = new Map(g.items.map((x, i) => [x.id, i]));
  g.items.sort((a, b) => a.ts.localeCompare(b.ts) || order.get(a.id)! - order.get(b.id)!);
  const truth = finalize(g);
  return { world: g.world, items: g.items, truth };
}

export interface PlanCounts {
  bySource: Record<string, number>;
  byKind: Record<string, number>;
  byNoise: Record<string, number>;
  byLabel: Record<string, number>;
  byLang: Record<string, number>;
  toRender: { total: number; bySource: Record<string, number> };
  dedupClusters: Record<string, number>;
  identities: { rows: number; byExpected: Record<string, number>; byForm: Record<string, number> };
  lines: number;
}
const inc = (m: Record<string, number>, k: string, n = 1) => (m[k] = (m[k] ?? 0) + n);

/** Volume keys the bench targets (reduced spec §2.3). */
export function volumeOf(items: PlannedItem[]): Record<string, number> {
  const v: Record<string, number> = {};
  for (const it of items) {
    if (it.source === 'slack') inc(v, it.author === 'Aven' ? 'slack_agent' : it.truth.human || (it.render.mode === 'human') ? 'slack_human' : 'slack_bot');
    else if (it.source === 'gmail') inc(v, it.account === ACCOUNTS.work ? 'gmail_work' : 'gmail_personal');
    else if (it.type === 'task') inc(v, `${it.source}_tickets`);
    else if (it.type === 'comment') inc(v, `${it.source}_comments`);
    else if (it.type === 'event') inc(v, 'gcal_events');
    else if (it.type === 'meeting') inc(v, 'meeting_copies');
    else if (it.type === 'activity') inc(v, 'activity_blocks');
  }
  v.gmail_work_human = items.filter((x) => x.source === 'gmail' && x.account === ACCOUNTS.work && x.truth.human).length;
  v.calls = new Set(items.filter((x) => x.meeting).map((x) => x.meeting!.call)).size;
  return v;
}

export function countPlan(plan: Plan): PlanCounts {
  const c: PlanCounts = { bySource: {}, byKind: {}, byNoise: {}, byLabel: {}, byLang: {}, toRender: { total: 0, bySource: {} }, dedupClusters: {}, identities: { rows: plan.truth.identities.length, byExpected: {}, byForm: {} }, lines: 0 };
  for (const it of plan.items) {
    inc(c.bySource, it.source);
    inc(c.byKind, it.truth.kind ?? '(n/a)');
    for (const n of it.truth.noise) inc(c.byNoise, n);
    inc(c.byLabel, it.truth.label);
    if (it.truth.lang) inc(c.byLang, it.truth.lang);
    if (it.render.mode === 'human') {
      c.toRender.total++;
      inc(c.toRender.bySource, it.source);
    }
    c.lines += it.lines.length;
  }
  for (const d of plan.truth.dedup) inc(c.dedupClusters, d.type);
  for (const r of plan.truth.identities) {
    inc(c.identities.byExpected, r.expected);
    inc(c.identities.byForm, r.form);
  }
  return c;
}

const jsonl = (rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');

/** Write plan.jsonl, world.json, tenant/ (GIVEN files) and truth/ to outDir. Returns the counts. */
export function writePlan(outDir: string, seed = 1): PlanCounts & { volumes: Record<string, number>; hash: string } {
  const plan = buildPlan(seed);
  mkdirSync(join(outDir, 'tenant', 'annotations'), { recursive: true });
  mkdirSync(join(outDir, 'truth'), { recursive: true });
  const planText = jsonl(plan.items);
  writeFileSync(join(outDir, 'plan.jsonl'), planText);
  writeFileSync(join(outDir, 'world.json'), `${JSON.stringify(plan.world, null, 2)}\n`);
  for (const [path, content] of Object.entries(givenTenant(plan.world))) {
    mkdirSync(join(outDir, 'tenant', path, '..'), { recursive: true });
    writeFileSync(join(outDir, 'tenant', path), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  writeFileSync(join(outDir, 'truth', 'items.jsonl'), jsonl(plan.truth.items));
  writeFileSync(join(outDir, 'truth', 'dedup.jsonl'), jsonl(plan.truth.dedup));
  writeFileSync(join(outDir, 'truth', 'identities.jsonl'), jsonl(plan.truth.identities));
  writeFileSync(join(outDir, 'truth', 'roster.json'), `${JSON.stringify(plan.truth.roster, null, 2)}\n`);
  writeFileSync(join(outDir, 'truth', 'patterns.jsonl'), jsonl(plan.truth.patterns));
  writeFileSync(join(outDir, 'truth', 'commitments.jsonl'), jsonl(plan.truth.commitments));
  return { ...countPlan(plan), volumes: volumeOf(plan.items), hash: createHash('sha256').update(planText).digest('hex').slice(0, 16) };
}

// CLI: node --import tsx src/lab/synth/plan.ts [outDir] [seed] — outDir defaults to $LAB_DIR/synth/bench-agency.
if (process.argv[1] && /synth\/plan\.ts$/.test(process.argv[1])) {
  const out = writePlan(process.argv[2] || join(process.env.LAB_DIR || 'data/lab', 'synth', 'bench-agency'), Number(process.argv[3] ?? 1));
  console.log(JSON.stringify(out, null, 2));
}
