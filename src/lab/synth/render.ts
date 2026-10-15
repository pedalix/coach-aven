// The bench-agency renderer — BENCH ONLY: it calls a model (through ../llm.ts) on the owner's machine; production
// never does. It fills the plan's human texts (`render.mode: 'human'`, `text: null`) with prose and nothing else:
// truth was written from the plan's skeleton, so a text may only SAY its beat — the validator below rejects a
// missing required token (a ticket key the key rung needs, an @mention the addressee truth relies on), a forbidden
// one (another ticket's key, label vocabulary) and an invented ticket key or URL, retries once naming the failure,
// and patches what still fails so a label can never depend on how well a model followed instructions.
//
// Batching: one call per conversation — a Slack thread or DM exchange (the plan's `thread.root`), a mail thread, a
// ticket with its comments, a call — beats in conversation order, so replies answer what was actually written.
// Small chat/mail conversations of the same source and local day share a call (≤ 12 beats, ≤ 6 conversations):
// half the calls for the same text, each conversation still its own section. A call renders once, on its primary
// copy (CallContent); every recorder copy styles that content with plan.ts formatCopy, so copies stay copies.
//
// Determinism: prompts depend on the plan only (typo choice = a hash of the item id), and llm.ts caches by prompt —
// a re-run replays from the cache for free, and a changed prompt re-renders only its own batch.

import { fnv1a } from '../metrics.js';
import type { LlmLike } from '../types.js';
import { applyDerive, dateToken, formatCopy } from './plan.js';
import type { Beat, CallContent, Lang, Person, PlannedItem, World } from './types.js';

/** A row of plan.rendered.jsonl: the plan item with its final text; a call's primary copy also carries the content. */
export interface RenderedItem extends PlannedItem {
  call?: CallContent;
}

export interface Conversation {
  key: string;
  items: string[]; // plan ids of the human beats, in conversation order
}

export interface Batch {
  id: string; // '<kind>:<first beat id>'
  kind: 'chat' | 'mail' | 'ticket' | 'meeting';
  convs: Conversation[];
  deps: string[]; // batches whose texts this one quotes as earlier context
}

export const BATCH_LIMITS = { maxBeats: 12, maxConvs: 6, chunk: 20 };

// --- batching (pure) -----------------------------------------------------------------------------------------

/** The conversation an item belongs to: a call, a ticket (description + comments), a planned exchange, a store thread. */
export function conversationKey(it: PlannedItem): string {
  if (it.type === 'meeting') return `call:${it.meeting?.call ?? it.id}`;
  if (it.type === 'task') return `ticket:${it.ref}`;
  if (it.type === 'comment') return `ticket:${it.ref.replace(/#c[^#]*$/, '')}`;
  if (it.thread) return `conv:${it.thread.root}`;
  return `thread:${it.threadId}`;
}

const kindOf = (it: PlannedItem): Batch['kind'] => (it.type === 'meeting' ? 'meeting' : it.type === 'task' || it.type === 'comment' ? 'ticket' : it.source === 'slack' ? 'chat' : 'mail');

export function planBatches(items: readonly PlannedItem[], limits = BATCH_LIMITS, tzDay: (iso: string) => string = (iso) => iso.slice(0, 10)): Batch[] {
  const human = items.filter((i) => i.render.mode === 'human');
  const convs = new Map<string, PlannedItem[]>();
  for (const it of human) {
    const k = conversationKey(it);
    const list = convs.get(k);
    if (list) list.push(it);
    else convs.set(k, [it]);
  }
  const batches: Batch[] = [];
  const own = (kind: Batch['kind'], conv: { key: string; items: PlannedItem[] }) => {
    for (let i = 0; i < conv.items.length; i += limits.chunk) {
      const part = conv.items.slice(i, i + limits.chunk);
      batches.push({ id: `${kind}:${part[0]!.id}`, kind, convs: [{ key: conv.key, items: part.map((x) => x.id) }], deps: [] });
    }
  };
  // Packing: small chat/mail conversations of one source and local day, in time order.
  let open: Batch | null = null;
  let openKey = '';
  let beats = 0;
  for (const [key, list] of convs) {
    const kind = kindOf(list[0]!);
    if (kind === 'meeting' || kind === 'ticket' || list.length > limits.maxBeats) {
      own(kind, { key, items: list });
      continue;
    }
    const pack = `${list[0]!.source}|${tzDay(list[0]!.ts)}`;
    if (!open || openKey !== pack || beats + list.length > limits.maxBeats || open.convs.length >= limits.maxConvs) {
      open = { id: `${kind}:${list[0]!.id}`, kind, convs: [], deps: [] };
      openKey = pack;
      beats = 0;
      batches.push(open);
    }
    open.convs.push({ key, items: list.map((x) => x.id) });
    beats += list.length;
  }
  // Dependencies: a beat that has seen an item rendered in another batch waits for that batch.
  const owner = new Map<string, string>();
  for (const b of batches) for (const c of b.convs) for (const id of c.items) owner.set(id, b.id);
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const b of batches) {
    const deps = new Set<string>();
    for (const c of b.convs) for (const id of c.items) {
      const it = byId.get(id)!;
      if (it.render.mode !== 'human') continue;
      for (const ctx of it.render.beat.context) {
        const o = owner.get(ctx);
        if (o && o !== b.id) deps.add(o);
        // A derived context item waits for its source.
        const src = byId.get(ctx);
        const from = src?.render.mode === 'derived' ? owner.get(src.render.from) : undefined;
        if (from && from !== b.id) deps.add(from);
      }
    }
    b.deps = [...deps].sort();
  }
  return batches;
}

// --- prompts (pure) ------------------------------------------------------------------------------------------

const LANG: Record<Lang, string> = { de: 'German', en: 'English', ru: 'Russian', it: 'Italian', fr: 'French' };
const GLOBAL_FORBIDDEN = ['initiative', 'unregistered', 'synthetic', 'bench', 'truth', 'dataset'];

export const SYSTEM_CHAT = `You write the raw text of workplace messages — Slack posts, e-mails, tracker tickets and comments — for an invented company, to build a realistic test corpus. Every person, company, product, host and domain is fictional. You get a setting, persona cards and a list of beats; for each beat write exactly the text that person would have sent at that moment, in their own voice.

Rules
1. Say what the brief says, nothing more. Never add facts: no ticket keys, URLs, e-mail addresses, phone numbers, amounts, prices, version numbers, calendar dates, host, app or repository names, companies or people that are not in the brief, the subject or title, the required tokens or the conversation so far. Relative time words ("tomorrow", "next week", "on Friday") are fine.
2. Every required token appears verbatim (exact characters and case). A forbidden token must not appear in any form or case. Never use the words ${GLOBAL_FORBIDDEN.map((w) => `"${w}"`).join(', ')}.
3. Write in the beat's language. "translit" = Russian typed in Latin letters (e.g. "privet, posmotryu zavtra"). "mix" = slip one or two words or a short phrase of that language in.
4. Keep to the length range (in words) and the register, and follow the persona card: greeting habit, emoji use, signature, notes. Swiss writers spell "ss", never "ß". "typo" = exactly one natural typo (a swapped, missing or doubled letter), never inside a required token.
5. Slack: plain chat text — no subject, no signature, no greeting unless it opens a conversation; mention people only as the required tokens give them ("@Name"); emoji as Slack shortcodes (":+1:", ":tada:") and only if the persona uses emoji. A reply continues the exchange; never repeat an earlier message.
6. E-mail: the body only — no subject line, no headers, no quoted earlier mail. Open with a greeting to the person named in "greet"; with "sign", end with a short closing and the persona's signature block (the first name alone when the card has none).
7. Tracker: a ticket description states the problem or wish concretely (context, what happens, what is expected) in a tracker's usual style; comments are short and to the point.
8. Small talk carries no work content at all.
9. The beats of one conversation form one coherent exchange, in order. Separate conversations are unrelated unless their briefs connect them.

Answer with JSON only — no prose, no code fences:
{"items":[{"id":"<beat id>","text":"<the message text>"}]}
One entry per beat, in the order given; use \\n for line breaks inside a text.`;

export const SYSTEM_MEETING = `You write the content of a meeting's notes for an invented company, to build a realistic test corpus. Every person, company, product and domain is fictional. You get the meeting (title, time, duration, language), the participants with persona cards, the topics in order with their briefs and target lengths, and the agreed next steps. Write what an AI note-taker produces from such a call: a short overview, one body per topic, the next steps and a short transcript excerpt.

Rules
1. Cover exactly the given topics, in the given order, under exactly the given headings. Each body is 2-6 plain sentences in the meeting's language (no bullets, no headings inside a body), roughly the target length.
2. Never add facts beyond the briefs: no ticket keys, URLs, e-mail addresses, phone numbers, amounts, version numbers, calendar dates, host, app or repository names, companies or people that are not given. Relative time words are fine. Never use the words ${GLOBAL_FORBIDDEN.map((w) => `"${w}"`).join(', ')}.
3. Next steps: one per given step, same order. "text" is a short infinitive phrase in the meeting's language WITHOUT the owner's name — it is printed as "<owner> will <text>" and as "- <text> (<owner>)" — e.g. English "send the contract draft by 15 Sep", German "den Vertragsentwurf bis 15.09. schicken". A given due date appears in the text verbatim.
4. Transcript: 1,500-3,000 characters of spoken lines in the meeting's language that walk through the topics in order; speaker labels exactly as given; every participant speaks at least once; owners voice their next steps. Spoken style: short turns, a little filler, no stage directions, no timestamps.
5. Required tokens appear verbatim in the overview, a topic body or a next step.

Answer with JSON only — no prose, no code fences:
{"intro":"<1-3 sentence overview>","topics":[{"heading":"<given heading>","body":"<sentences>"}],"next_steps":[{"owner":"<given owner label>","text":"<infinitive phrase>"}],"transcript":[{"speaker":"<given speaker label>","text":"<spoken line>"}]}`;

export interface PromptCtx {
  world: World;
  byId: ReadonlyMap<string, PlannedItem>;
  /** Final text of an item rendered (or templated, or derived) so far; undefined while it is not. */
  textOf: (id: string) => string | undefined;
}

const personMap = new WeakMap<World, Map<string, Person>>();
function people(world: World): Map<string, Person> {
  let m = personMap.get(world);
  if (!m) personMap.set(world, (m = new Map(world.people.map((p) => [p.id, p]))));
  return m;
}
const nameOf = (world: World, pid: string | null | undefined): string => (pid ? people(world).get(pid)?.name ?? pid : '?');
const companyName = (world: World, id: string): string => world.companies.find((c) => c.id === id)?.name ?? id;

/** Whether this item's text gets its writer's one typo: a hash of the id under the persona's rate. */
export function typoFor(it: PlannedItem, world: World): boolean {
  if (it.render.mode !== 'human') return false;
  const rate = people(world).get(it.render.beat.persona)?.persona.typoRate ?? 0;
  return fnv1a(`typo:${it.id}`) % 10_000 < rate * 10_000;
}

// World roles carry planner notes ("the subject", "not yet in the tenant people file"): a writer must never see them.
export const cleanRole = (role: string, subject: string): string =>
  role
    .replace(/\s*\([^)]*\b(tenant|subject|collision|second)\b[^)]*\)/gi, '')
    .replace(/;\s*the subject\b[^;]*/gi, '')
    .replace(/\bthe subject's\b/gi, `${subject}'s`)
    .replace(/\bstarted in W\d\b/g, 'started this month')
    .trim();

export function personaCard(p: Person, world: World): string {
  const s = p.persona;
  const bits = [
    `${cleanRole(p.role, nameOf(world, world.subject))}${['candidate', 'personal'].includes(world.companies.find((c) => c.id === p.company)?.side ?? '') ? '' : `, ${companyName(world, p.company)}`}`,
    `writes ${p.langs.join('/')}`,
    `register ${s.register}`,
    `emoji ${s.emoji}`,
    ...(s.greeting ? [`usual greeting "${s.greeting}"`] : []),
    ...(s.swiss ? ['Swiss spelling'] : []),
    ...(s.notes ? [s.notes.replace(/numbers and hostnames/g, 'numbers')] : []),
  ];
  return `- ${p.name}: ${bits.join('; ')}.${s.signature ? ` Signature block: "${s.signature.replace(/\n/g, ' / ')}".` : ''}`;
}

function localStamp(iso: string, tz: string): string {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('weekday')} ${g('day')} ${g('month')} ${g('hour')}:${g('minute')}`;
}

/** The raw strings of a record → the names a reader would see (identity truth of the item, else the raw). */
function namesOf(it: PlannedItem, world: World, raws: readonly string[]): string[] {
  const byRaw = new Map(it.truth.identities.map((o) => [o.raw, o.truth]));
  return raws.map((r) => {
    const t = byRaw.get(r);
    if (!t || t === 'system' || t.includes('+')) return r;
    return nameOf(world, t);
  });
}

const ownThread = (it: PlannedItem): string => {
  const [, team, ch, ts] = it.ref.split(':');
  return `slack:${team}/${ch}/${ts}`;
};

function placeOf(list: readonly PlannedItem[], ctx: PromptCtx, size: number): string {
  const it = list[0]!;
  const w = ctx.world;
  const rec = it.lines[0]?.record ?? {};
  if (it.source === 'slack') {
    const chId = it.ref.split(':')[2] ?? '';
    const ch = w.channels.find((c) => c.id === chId);
    const members = (ch?.members ?? []).map((m) => nameOf(w, m));
    const threaded = list.some((x) => x.threadId !== ownThread(x));
    const exchange = size > 1 ? (threaded ? `a thread of ${size} messages (replies under the first)` : `an exchange of ${size} messages`) : 'a single message';
    if (!ch) return `Slack, ${it.container}; ${exchange}.`;
    if (ch.kind === 'dm') return `Slack direct messages between ${members.join(' and ')}; ${exchange}.`;
    if (ch.kind === 'mpim') return `Slack group DM of ${members.join(', ')}; ${exchange}.`;
    if (ch.kind === 'connect') {
      const ext = [...new Set((ch.members ?? []).map((m) => people(w).get(m)?.company).filter((c): c is string => !!c && c !== w.agency))].map((c) => companyName(w, c));
      return `Slack Connect channel ${it.container} (Brightwell Digital with ${ext.join(', ') || 'a client'}); ${exchange}.`;
    }
    return `Brightwell's internal Slack channel ${it.container}; ${exchange}.`;
  }
  if (it.source === 'gmail') {
    const box = it.account === w.accounts.personal ? `Mara Keller's private mailbox (${it.account})` : `Mara Keller's work mailbox (${it.account})`;
    return `E-mail thread in ${box}; ${size > 1 ? `${size} mails of it are written below` : 'one mail'}.`;
  }
  if (it.type === 'task' || it.type === 'comment') {
    const tracker = it.source === 'jira' ? "the client MedTrack's Jira" : "Brightwell's YouTrack";
    const task = it.type === 'task' ? it : ctx.byId.get(it.thread?.root ?? '') ?? it;
    const r = (task.lines[0]?.record ?? rec) as Record<string, unknown>;
    const labels = Array.isArray(r.labels) && r.labels.length ? `; labels ${(r.labels as string[]).join(', ')}` : '';
    const who = namesOf(task, w, [String(r.reporter ?? ''), String(r.assignee ?? '')]);
    return `Ticket ${task.keys[0] ?? r.key} "${task.title ?? r.title}" in ${tracker} (reporter ${who[0]}${r.assignee ? `; assignee ${who[1]}` : ''}${labels}).`;
  }
  return `${it.source} ${it.container ?? ''}`.trim();
}

function beatLines(it: PlannedItem, ctx: PromptCtx, inBatch: ReadonlySet<string>, n: number, size: number): string[] {
  if (it.render.mode !== 'human') return [];
  const b = it.render.beat;
  const w = ctx.world;
  const rec = (it.lines[0]?.record ?? {}) as Record<string, unknown>;
  const author = nameOf(w, b.persona);
  let role = '';
  if (it.type === 'task') role = 'ticket description';
  else if (it.type === 'comment') role = `comment ${it.thread?.index ?? ''}`.trim();
  else if (it.source === 'gmail') {
    const to = namesOf(it, w, ((rec.participants as string[]) ?? []).filter((p) => p !== rec.author));
    role = `mail to ${to.join(', ') || '?'}; subject "${String(rec.subject ?? it.title ?? '')}"`;
  } else role = n === 0 ? (size > 1 ? 'opens the exchange' : 'message') : `message ${n + 1} of ${size}`;
  const style = [
    `${LANG[b.lang]}${b.translit ? ' (translit)' : ''}${b.mix ? ` (mix: ${LANG[b.mix]})` : ''}`,
    `register ${b.register}`,
    `${b.words[0]}–${b.words[1]} words`,
    ...(b.mail ? [`greet "${b.mail.greet}"`, ...(b.mail.signOff ? ['sign'] : [])] : []),
    ...(b.smallTalk ? ['small talk'] : []),
    ...(typoFor(it, w) ? ['typo'] : []),
  ];
  const seen = b.context.filter((c) => inBatch.has(c));
  const forbidden = b.forbidden.filter((f) => !GLOBAL_FORBIDDEN.includes(f.toLowerCase()));
  return [
    `  [${it.id}] ${author} · ${localStamp(it.ts, w.tz)} · ${role}${seen.length ? ` · has read ${seen.join(', ')}` : ''}`,
    `    ${style.join(' · ')}`,
    ...(b.required.length ? [`    required: ${b.required.map((r) => JSON.stringify(r)).join(', ')}`] : []),
    ...(forbidden.length ? [`    forbidden: ${forbidden.map((r) => JSON.stringify(r)).join(', ')}`] : []),
    `    brief: ${b.brief}`,
  ];
}

/** The user prompt of a chat / mail / ticket batch. */
export function batchPrompt(batch: Batch, ctx: PromptCtx): string {
  const w = ctx.world;
  const its = batch.convs.flatMap((c) => c.items.map((id) => ctx.byId.get(id)!));
  const inBatch = new Set(its.map((i) => i.id));
  const authors = [...new Set(its.map((i) => (i.render.mode === 'human' ? i.render.beat.persona : '')).filter(Boolean))];
  const out: string[] = [
    `Company: Brightwell Digital, a 14-person web and app agency in Zurich, Switzerland; Mara Keller is its CTO and co-founder. Times are local (${w.tz}).`,
    '',
    'Persona cards (the writers of these beats):',
    ...authors.map((pid) => people(w).get(pid)).filter((p): p is Person => !!p).map((p) => personaCard(p, w)),
  ];
  batch.convs.forEach((conv, ci) => {
    const list = conv.items.map((id) => ctx.byId.get(id)!);
    const first = list[0]!;
    const size = Math.max(list.length, first.thread?.size ?? 0, first.render.mode === 'human' ? first.render.beat.pos?.of ?? 0 : 0);
    out.push('', `Conversation ${ci + 1} — ${placeOf(list, ctx, size)}`);
    // Earlier messages this conversation's writers have read that are not written in this batch.
    const earlier = [...new Set(list.flatMap((i) => (i.render.mode === 'human' ? i.render.beat.context : [])))].filter((id) => !inBatch.has(id));
    const shown = earlier.map((id) => ctx.byId.get(id)).filter((x): x is PlannedItem => !!x && ctx.textOf(x.id) !== undefined);
    if (shown.length) {
      out.push('  Earlier in this conversation:');
      for (const e of shown) out.push(`  [${e.id}] ${nameOf(w, e.authorPerson)} · ${localStamp(e.ts, w.tz)}: ${ctx.textOf(e.id)!.replace(/\n+/g, ' ⏎ ').slice(0, 600)}`);
    }
    if (first.type === 'comment' && ctx.textOf(first.thread?.root ?? '') !== undefined && !inBatch.has(first.thread!.root)) {
      out.push(`  Ticket description: ${ctx.textOf(first.thread!.root)!.replace(/\n+/g, ' ⏎ ').slice(0, 800)}`);
    }
    list.forEach((it, n) => out.push(...beatLines(it, ctx, inBatch, it.thread?.index ?? n, size)));
  });
  out.push('', `Write all ${its.length} beat${its.length > 1 ? 's' : ''}: ${its.map((i) => i.id).join(', ')}.`);
  return out.join('\n');
}

/** The user prompt of a call (rendered once, on its primary copy). */
export function meetingPrompt(it: PlannedItem, ctx: PromptCtx): string {
  if (it.render.mode !== 'human' || !it.render.beat.meeting) throw new Error(`${it.id}: not a call beat`);
  const b = it.render.beat;
  const m = b.meeting!;
  const w = ctx.world;
  const total = Math.round((b.words[0] + b.words[1]) / 2);
  const byName = new Map(w.people.map((p) => [p.name, p]));
  const out = [
    `Company: Brightwell Digital, a 14-person web and app agency in Zurich, Switzerland; Mara Keller is its CTO and co-founder.`,
    '',
    `Meeting "${it.title}" · ${localStamp(it.ts, w.tz)} (${w.tz}) · ${m.minutes} minutes · language ${LANG[b.lang]}${b.mix ? ` (with some ${LANG[b.mix]})` : ''}.`,
    `What it is: ${b.brief}`,
    '',
    'Participants (speaker labels exactly as written):',
    ...m.speakers.map((s) => {
      const p = byName.get(s);
      return p ? personaCard(p, w) : `- ${s}`;
    }),
    '',
    `Topics, in order (the bodies together about ${total} words):`,
    ...m.topics.map((t, i) => `  ${i + 1}. heading "${t.heading}" · about ${Math.max(25, Math.round(t.share * total))} words · ${t.brief}`),
    '',
    'Next steps, in order:',
    ...(m.nextSteps.length ? m.nextSteps.map((s, i) => `  ${i + 1}. owner "${s.ownerLabel}" · ${s.brief}${s.due ? ` · due "${dateToken(s.due, b.lang)}"` : ''}`) : ['  (none)']),
    ...(b.required.length ? ['', `Required tokens: ${b.required.map((r) => JSON.stringify(r)).join(', ')}`] : []),
  ];
  return out.join('\n');
}

// --- validation (pure) ---------------------------------------------------------------------------------------

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const KEY_RE = /(?<![\p{L}\p{N}_-])([A-Z][A-Z0-9]{1,9})-(\d+)(?![\p{L}\p{N}_])/gu;
const URL_RE = /https?:\/\/[^\s<>|"'`)\]]+/g;
export const wordCount = (s: string): number => s.split(/\s+/).filter(Boolean).length;

/** A forbidden token as a whole word, any case: "ALP-31" never matches inside "ALP-310", "bench" not in "benchmark". */
export function hasToken(text: string, token: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${esc(token)}(?![\\p{L}\\p{N}_])`, 'iu').test(text);
}

export interface Allowed {
  prefixes: ReadonlySet<string>; // tracker key prefixes of the world (ALP, SWL, …): a key with one is a fact
  keys: ReadonlySet<string>; // keys this text may carry (its own required + what its writer has read)
  urls: readonly string[];
}

/** What is wrong with one text against its beat (empty = fine). */
export function checkText(text: string, beat: Beat, allowed: Allowed): string[] {
  const out: string[] = [];
  if (!text.trim()) return ['empty text'];
  for (const r of beat.required) if (!text.includes(r)) out.push(`missing required token ${JSON.stringify(r)}`);
  for (const f of [...beat.forbidden, ...GLOBAL_FORBIDDEN]) if (hasToken(text, f)) out.push(`contains forbidden ${JSON.stringify(f)}`);
  for (const m of text.matchAll(KEY_RE)) if (allowed.prefixes.has(m[1]!) && !allowed.keys.has(m[0])) out.push(`invented ticket key ${JSON.stringify(m[0])}`);
  for (const m of text.matchAll(URL_RE)) if (!allowed.urls.some((u) => m[0].startsWith(u) || u.startsWith(m[0].replace(/[.,;:!?]+$/, '')))) out.push(`invented URL ${JSON.stringify(m[0])}`);
  const n = wordCount(text);
  if (n > beat.words[1] * 2 + 15) out.push(`too long: ${n} words, the range is ${beat.words[0]}–${beat.words[1]}`);
  return [...new Set(out)];
}

/** Last resort after the retry: add what is missing, cut what is forbidden — truth must never depend on prose. */
export function patchText(text: string, beat: Beat): string {
  let t = text;
  for (const f of [...beat.forbidden, ...GLOBAL_FORBIDDEN]) t = t.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${esc(f)}(?![\\p{L}\\p{N}_])`, 'giu'), '').replace(/[ \t]{2,}/g, ' ');
  const missing = beat.required.filter((r) => !t.includes(r));
  const mentions = missing.filter((r) => r.startsWith('@'));
  const rest = missing.filter((r) => !r.startsWith('@'));
  if (mentions.length) t = `${mentions.join(' ')} ${t}`;
  if (rest.length) t = `${t.trimEnd()} (${rest.join(', ')})`;
  return t.trim();
}

export function allowedFor(it: PlannedItem, byId: ReadonlyMap<string, PlannedItem>, prefixes: ReadonlySet<string>): Allowed {
  if (it.render.mode !== 'human') return { prefixes, keys: new Set(), urls: [] };
  const seen = it.render.beat.context.map((c) => byId.get(c)).filter((x): x is PlannedItem => !!x);
  const task = it.type === 'comment' ? byId.get(it.thread?.root ?? '') : undefined;
  const reqs = [it, ...seen, ...(task ? [task] : [])].flatMap((x) => [...x.keys, ...(x.render.mode === 'human' ? x.render.beat.required : [])]);
  return { prefixes, keys: new Set(reqs), urls: reqs.filter((r) => /^https?:\/\//.test(r)) };
}

/**
 * Every top-level JSON object/array in a model answer, in order. A model that corrects itself ("Wait — … Corrected:")
 * writes the fix LAST, so readers take the last value of the expected shape (llm.ts parseJsonLoose takes the first).
 */
export function jsonValues(text: string): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < text.length; i++) {
    const open = text[i];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let end = -1;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (ch === '\\') j++;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) {
        end = j;
        break;
      }
    }
    if (end < 0) continue;
    try {
      out.push(JSON.parse(text.slice(i, end + 1)));
      i = end;
    } catch {
      /* not JSON from this opener — try the next one */
    }
  }
  return out;
}

/** Parse a chat batch answer → id → text (unknown ids ignored); the last JSON value with items wins. */
export function parseItems(answer: string): Map<string, string> {
  const listOf = (j: unknown): unknown[] => (Array.isArray(j) ? j : j && typeof j === 'object' && Array.isArray((j as { items?: unknown }).items) ? (j as { items: unknown[] }).items : []);
  const values = jsonValues(answer);
  for (let k = values.length - 1; k >= 0; k--) {
    const out = new Map<string, string>();
    for (const x of listOf(values[k])) {
      if (!x || typeof x !== 'object') continue;
      const o = x as Record<string, unknown>;
      if (typeof o.id === 'string' && typeof o.text === 'string') out.set(o.id.trim().replace(/^\[|\]$/g, ''), o.text.replace(/\r\n/g, '\n').trim());
    }
    if (out.size) return out;
  }
  return new Map();
}

/** A call answer → CallContent with the PLANNED headings/owners (by position), plus what is wrong with it. */
export function parseCall(answer: string, beat: Beat, allowed: Allowed): { content: CallContent | null; problems: string[] } {
  const m = beat.meeting!;
  const objects = jsonValues(answer).filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v));
  const j = [...objects].reverse().find((v) => 'topics' in v || 'intro' in v) ?? objects[objects.length - 1];
  if (!j) return { content: null, problems: ['the answer is not a JSON object'] };
  const problems: string[] = [];
  const arr = (k: string) => (Array.isArray(j[k]) ? (j[k] as unknown[]).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []);
  const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const topics = arr('topics');
  const steps = arr(Array.isArray(j.next_steps) ? 'next_steps' : 'nextSteps');
  const lines = arr('transcript').map((x) => ({ speaker: s(x.speaker), text: s(x.text).replace(/\s*\n+\s*/g, ' ') })).filter((x) => x.speaker && x.text);
  const intro = s(j.intro);
  if (!intro) problems.push('"intro" is empty');
  if (topics.length !== m.topics.length) problems.push(`${topics.length} topics, expected ${m.topics.length}`);
  m.topics.forEach((t, i) => {
    if (!s(topics[i]?.body)) problems.push(`topic ${i + 1} ("${t.heading}") has no body`);
  });
  if (steps.length !== m.nextSteps.length) problems.push(`${steps.length} next steps, expected ${m.nextSteps.length}`);
  m.nextSteps.forEach((st, i) => {
    const text = s(steps[i]?.text);
    if (!text) problems.push(`next step ${i + 1} is empty`);
    else if (st.due && !text.includes(dateToken(st.due, beat.lang))) problems.push(`next step ${i + 1} must contain the due date "${dateToken(st.due, beat.lang)}"`);
  });
  const speakers = new Set(m.speakers);
  const bad = [...new Set(lines.map((l) => l.speaker).filter((x) => !speakers.has(x)))];
  if (bad.length) problems.push(`unknown speaker labels ${bad.map((b) => JSON.stringify(b)).join(', ')} (use exactly: ${m.speakers.join(', ')})`);
  const silent = m.speakers.filter((x) => !lines.some((l) => l.speaker === x));
  if (silent.length) problems.push(`these participants never speak: ${silent.join(', ')}`);
  const chars = lines.reduce((a, l) => a + l.speaker.length + 2 + l.text.length + 1, 0);
  if (chars < 1200 || chars > 3600) problems.push(`transcript is ${chars} characters, keep it within 1,500–3,000`);
  const content: CallContent = {
    intro,
    topics: m.topics.map((t, i) => ({ heading: t.heading, body: s(topics[i]?.body) })),
    nextSteps: m.nextSteps.map((st, i) => ({ ownerLabel: st.ownerLabel, text: s(steps[i]?.text) || st.brief })),
    transcript: lines.filter((l) => speakers.has(l.speaker)),
  };
  const all = [content.intro, ...content.topics.map((t) => t.body), ...content.nextSteps.map((x) => x.text), ...content.transcript.map((x) => x.text)].join('\n');
  const notes = [content.intro, ...content.topics.map((t) => t.body), ...content.nextSteps.map((x) => x.text)].join('\n');
  for (const r of beat.required) if (!notes.includes(r)) problems.push(`missing required token ${JSON.stringify(r)}`);
  for (const f of [...beat.forbidden, ...GLOBAL_FORBIDDEN]) if (hasToken(all, f)) problems.push(`contains forbidden ${JSON.stringify(f)}`);
  for (const k of all.matchAll(KEY_RE)) if (allowed.prefixes.has(k[1]!) && !allowed.keys.has(k[0])) problems.push(`invented ticket key ${JSON.stringify(k[0])}`);
  for (const u of all.matchAll(URL_RE)) problems.push(`invented URL ${JSON.stringify(u[0])}`);
  return { content, problems: [...new Set(problems)] };
}

/** Patch a call's content after the retry: forbidden words out, required tokens into the overview. */
export function patchCall(c: CallContent, beat: Beat): CallContent {
  const cut = (t: string) => [...beat.forbidden, ...GLOBAL_FORBIDDEN].reduce((acc, f) => acc.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${esc(f)}(?![\\p{L}\\p{N}_])`, 'giu'), ''), t).replace(/[ \t]{2,}/g, ' ');
  const out: CallContent = {
    intro: cut(c.intro) || beat.brief,
    topics: c.topics.map((t, i) => ({ heading: t.heading, body: cut(t.body) || beat.meeting!.topics[i]!.brief })),
    nextSteps: c.nextSteps.map((s) => ({ ownerLabel: s.ownerLabel, text: cut(s.text) })),
    transcript: c.transcript.map((x) => ({ speaker: x.speaker, text: cut(x.text) })),
  };
  const notes = [out.intro, ...out.topics.map((t) => t.body), ...out.nextSteps.map((x) => x.text)].join('\n');
  const missing = beat.required.filter((r) => !notes.includes(r));
  if (missing.length) out.intro = `${out.intro} (${missing.join(', ')})`;
  beat.meeting!.nextSteps.forEach((st, i) => {
    const tok = st.due ? dateToken(st.due, beat.lang) : '';
    if (tok && !out.nextSteps[i]!.text.includes(tok)) out.nextSteps[i]!.text = `${out.nextSteps[i]!.text} (${tok})`;
  });
  return out;
}

// --- assembly (pure) -------------------------------------------------------------------------------------------

/**
 * Plan items + rendered texts + call contents → plan.rendered.jsonl rows. Derived items get their final text here
 * (applyDerive of their source's final text; a recorder copy: its call's content in its own style), so the file is
 * complete and the raw writer never needs a model. Items whose text is still missing stay `text: null`.
 */
export function assemble(items: readonly PlannedItem[], texts: ReadonlyMap<string, string>, calls: ReadonlyMap<string, CallContent>): RenderedItem[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const memo = new Map<string, string | null>();
  const finalText = (id: string, depth = 0): string | null => {
    if (memo.has(id)) return memo.get(id)!;
    const it = byId.get(id);
    let t: string | null = null;
    if (!it || depth > 10) t = null;
    else if (it.type === 'meeting') {
      const c = it.meeting ? calls.get(it.meeting.call) : undefined;
      t = c ? formatCopy(it, c).summary : null;
    } else if (it.render.mode === 'template') t = it.text;
    else if (it.render.mode === 'human') t = texts.get(id) ?? null;
    else {
      const src = finalText(it.render.from, depth + 1);
      t = src === null ? null : applyDerive(src, it.render.op);
    }
    memo.set(id, t);
    return t;
  };
  return items.map((it) => {
    const text = finalText(it.id);
    const row: RenderedItem = { ...it, text, rendered: text !== null };
    if (it.type === 'meeting' && it.meeting?.primary && calls.has(it.meeting.call)) row.call = calls.get(it.meeting.call)!;
    return row;
  });
}

// --- the run -----------------------------------------------------------------------------------------------------

export interface RenderOpts {
  llm: LlmLike;
  model?: string; // default 'opus'
  only?: (b: Batch) => boolean; // smoke runs: render just these batches
  log?: (msg: string) => void;
  /** Texts already final from an earlier run (plan.rendered.jsonl): kept, not re-asked. */
  prior?: ReadonlyMap<string, { text?: string | null; call?: CallContent }>;
}

export interface BatchReport {
  id: string;
  beats: number;
  ok: boolean;
  calls: number;
  costUsd: number;
  cached: boolean;
  retried: boolean;
  patched: string[]; // beat ids whose text had to be patched after the retry
  problems: string[]; // first answer's problems (before the retry)
  error?: string;
}

export interface RenderStats {
  batches: number;
  rendered: number; // batches done
  failed: string[];
  calls: number;
  cachedCalls: number;
  retried: number;
  patchedBeats: number;
  costUsd: number; // as recorded by the cache: what the run cost (or would have cost) fresh
  beats: number;
  missing: number; // human items still without text
  reports: BatchReport[];
}

export function keyPrefixes(items: readonly PlannedItem[]): Set<string> {
  const out = new Set<string>();
  for (const it of items) for (const k of it.keys) {
    const m = /^([A-Z][A-Z0-9]{1,9})-\d+$/.exec(k);
    if (m) out.add(m[1]!);
  }
  return out;
}

export async function renderPlan(items: readonly PlannedItem[], world: World, opts: RenderOpts): Promise<{ items: RenderedItem[]; stats: RenderStats }> {
  const log = opts.log ?? (() => {});
  const model = opts.model ?? 'opus';
  const byId = new Map(items.map((i) => [i.id, i]));
  const prefixes = keyPrefixes(items);
  const dayOf = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: world.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  const batches = planBatches(items, BATCH_LIMITS, dayOf);
  const texts = new Map<string, string>();
  const calls = new Map<string, CallContent>();
  for (const [id, p] of opts.prior ?? []) {
    const it = byId.get(id);
    if (!it || it.render.mode !== 'human') continue;
    if (it.type === 'meeting' && p.call && it.meeting) calls.set(it.meeting.call, p.call);
    else if (typeof p.text === 'string') texts.set(id, p.text);
  }
  // What a prompt may quote: human texts rendered so far, template texts, derived texts of rendered sources.
  const textOf = (id: string, depth = 0): string | undefined => {
    const it = byId.get(id);
    if (!it || depth > 10) return undefined;
    if (it.render.mode === 'template') return it.text ?? undefined;
    if (it.render.mode === 'human') return texts.get(id);
    if (it.type === 'meeting') return undefined;
    const src = textOf(it.render.from, depth + 1);
    return src === undefined ? undefined : applyDerive(src, it.render.op);
  };
  const ctx: PromptCtx = { world, byId, textOf };
  const stats: RenderStats = { batches: batches.length, rendered: 0, failed: [], calls: 0, cachedCalls: 0, retried: 0, patchedBeats: 0, costUsd: 0, beats: 0, missing: 0, reports: [] };
  const done = new Map<string, Promise<void>>();
  const isDone = (b: Batch) => b.convs.every((c) => c.items.every((id) => (byId.get(id)!.type === 'meeting' ? calls.has(byId.get(id)!.meeting!.call) : texts.has(id))));
  const selected = batches.filter((b) => (opts.only ? opts.only(b) : true));
  const want = new Set(selected.map((b) => b.id));
  const all = new Map(batches.map((b) => [b.id, b]));
  // Smoke runs pull in the batches their selection depends on.
  for (const b of selected) for (const d of b.deps) if (!want.has(d)) {
    want.add(d);
    selected.push(all.get(d)!);
  }
  let finished = 0;
  const ask = async (system: string, prompt: string) => {
    const r = await opts.llm.call({ model, system, prompt, timeoutMs: 600_000 });
    stats.calls++;
    if (r.cached) stats.cachedCalls++;
    stats.costUsd += r.costUsd;
    return r;
  };

  const runBatch = async (b: Batch): Promise<void> => {
    for (const d of b.deps) await done.get(d);
    const beats = b.convs.flatMap((c) => c.items);
    stats.beats += beats.length;
    const rep: BatchReport = { id: b.id, beats: beats.length, ok: false, calls: 0, costUsd: 0, cached: true, retried: false, patched: [], problems: [] };
    stats.reports.push(rep);
    if (isDone(b)) {
      rep.ok = true;
      return;
    }
    const callAndTrack = async (system: string, prompt: string) => {
      const r = await ask(system, prompt);
      rep.calls++;
      rep.costUsd += r.costUsd;
      rep.cached &&= r.cached;
      return r;
    };
    try {
      if (b.kind === 'meeting') {
        const it = byId.get(beats[0]!)!;
        if (it.render.mode !== 'human') return;
        const allowed = allowedFor(it, byId, prefixes);
        const prompt = meetingPrompt(it, ctx);
        const r1 = await callAndTrack(SYSTEM_MEETING, prompt);
        if (r1.error) throw new Error(r1.error);
        let res = parseCall(r1.text, it.render.beat, allowed);
        rep.problems = res.problems;
        if (res.problems.length) {
          rep.retried = true;
          stats.retried++;
          const r2 = await callAndTrack(SYSTEM_MEETING, `${prompt}\n\nYour previous answer:\n${r1.text}\n\nIt has these problems:\n${res.problems.map((p) => `- ${p}`).join('\n')}\n\nWrite the whole answer again with these fixed, in the same JSON format.`);
          if (!r2.error) {
            const res2 = parseCall(r2.text, it.render.beat, allowed);
            if (res2.content && (res2.problems.length <= res.problems.length || !res.content)) res = res2;
          }
          if (res.problems.length) rep.patched.push(it.id);
        }
        if (!res.content) throw new Error(`unusable call answer: ${res.problems.join('; ')}`);
        calls.set(it.meeting!.call, res.problems.length ? patchCall(res.content, it.render.beat) : res.content);
      } else {
        const prompt = batchPrompt(b, ctx);
        const r1 = await callAndTrack(SYSTEM_CHAT, prompt);
        if (r1.error) throw new Error(r1.error);
        const first = parseItems(r1.text);
        const check = (id: string, t: string | undefined): string[] => {
          const it = byId.get(id)!;
          if (it.render.mode !== 'human') return [];
          return t === undefined ? ['no text in the answer'] : checkText(t, it.render.beat, allowedFor(it, byId, prefixes));
        };
        const bad = beats.map((id) => ({ id, problems: check(id, first.get(id)) })).filter((x) => x.problems.length);
        rep.problems = bad.flatMap((x) => x.problems.map((p) => `${x.id}: ${p}`));
        let second = new Map<string, string>();
        if (bad.length) {
          rep.retried = true;
          stats.retried++;
          const r2 = await callAndTrack(SYSTEM_CHAT, `${prompt}\n\nYour previous answer:\n${r1.text}\n\nIt has these problems:\n${rep.problems.map((p) => `- ${p}`).join('\n')}\n\nWrite ALL ${beats.length} beats again with these fixed (keep the good ones as they were), in the same JSON format.`);
          if (!r2.error) second = parseItems(r2.text);
        }
        for (const id of beats) {
          const it = byId.get(id)!;
          if (it.render.mode !== 'human') continue;
          const a = first.get(id);
          const c = second.get(id);
          // The first version that passes wins; else the retry's (else the first's) text, patched.
          let t = a !== undefined && !check(id, a).length ? a : c !== undefined && !check(id, c).length ? c : undefined;
          if (t === undefined) {
            const base = c ?? a;
            if (base === undefined) continue; // nothing usable: the beat stays unrendered (reported)
            t = patchText(base, it.render.beat);
            rep.patched.push(id);
          }
          texts.set(id, t);
        }
      }
      stats.patchedBeats += rep.patched.length;
      rep.ok = isDone(b);
      if (!rep.ok) stats.failed.push(b.id);
    } catch (e) {
      rep.error = e instanceof Error ? e.message : String(e);
      stats.failed.push(b.id);
    } finally {
      finished++;
      if (rep.error || !rep.cached || finished % 25 === 0) log(`render ${finished}/${selected.length} ${b.id} (${beats.length} beats)${rep.cached ? ' cached' : ''}${rep.retried ? ' retried' : ''}${rep.patched.length ? ` patched ${rep.patched.length}` : ''}${rep.error ? ` ERROR ${rep.error.slice(0, 200)}` : ''} · $${stats.costUsd.toFixed(2)}`);
    }
  };
  // Every batch starts at once; the runner's own concurrency limit queues the calls, dependencies wait above.
  for (const b of selected) done.set(b.id, runBatch(b));
  await Promise.all(done.values());
  stats.rendered = stats.reports.filter((r) => r.ok).length;
  const out = assemble(items, texts, calls);
  stats.missing = out.filter((i) => i.render.mode === 'human' && !i.rendered).length;
  stats.reports.sort((a, b) => a.id.localeCompare(b.id));
  return { items: out, stats };
}
