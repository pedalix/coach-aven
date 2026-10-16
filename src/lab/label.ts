// The silver labeller — BENCH ONLY (it calls a model through llm.ts; nothing outside src/lab may import
// it). Owner-given gold is a few dozen answers, so a strong model with the tenant's full context labels
// the bench units instead, under protocol v1:
//   - pass A shows a batch in its natural order, pass B shows the same batch in a seeded shuffle; the two
//     calls are independent samples (different prompts, so the cache cannot hand B the answer of A);
//   - where A and B disagree after alias resolution, a third call sees the unit with both answers and
//     their reasons and gives the final label or 'unsure';
//   - the result is the 'opus' gold tier: agree = 1 where A = B, 0.5 where the adjudicator settled it.
//     'unsure' writes no row at all: a missing row costs coverage, a wrong row poisons every variant's
//     precision, and precision at a floor is the headline metric.
// Why the prompts look the way they do:
//   - The tenant context (registry, roster, rules, subject, zone) is the SYSTEM prompt, byte-identical
//     for every batch of a dataset and placed before the task text — the model knows what a human
//     reviewer would know, and the CLI's prompt cache serves the long prefix cheaply on every call.
//   - Units appear under short handles (u1…, p1…): long store refs get mangled by models. Today's
//     production answer for a unit (ladder state, resolved addressees, resolved mention) is never
//     shown — silver gold that peeks at the baseline would score the baseline against itself.
//   - Units are taken in a hash order and cut into batches from the front, so --limit is a uniform
//     sample and a larger limit re-uses every earlier full batch from the cache (a batch prompt depends
//     only on its own units, never on the run's size).
//   - Every label is checked against the task's closed list; a rejected answer gets one retry that
//     names the error, then counts as 'invalid'.

import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJsonl, writeJsonl } from './dataset.js';
import { benchToken, LlmRunner, parseJsonLoose } from './llm.js';
import { fnv1a, rng, setKey } from './metrics.js';
import { KINDS, NONE, SYSTEM, UNKNOWN, UNREGISTERED } from './types.js';
import type { DatasetMeta, FragmentUnit, GoldRow, ItemUnit, LlmLike, MentionUnit, TaskId, Unit, UnitKind } from './types.js';

export const PROTOCOL = 'silver-v1';

// 't4' labels kind and addressee in one call; 't2-pairs' judges candidate pairs (real-data dedup gold).
export type LabelTask = 't1-fragment' | 't1-item' | 't3-identity' | 't4' | 't2-pairs';
export const LABEL_TASKS: readonly LabelTask[] = ['t1-fragment', 't1-item', 't3-identity', 't4', 't2-pairs'];
const UNIT_KIND: Record<LabelTask, UnitKind> = { 't1-fragment': 'fragment', 't1-item': 'item', 't3-identity': 'mention', t4: 'item', 't2-pairs': 'item' };

export const UNSURE = 'unsure'; // adjudication only: no gold row
export const SAME = 'same';
export const DIFFERENT = 'different';

const TEXT_MAX = 1200;
const FRAGMENT_TEXT_MAX = 2000;
const CONTEXT_MAX = 200;
const PAIR_TEXT_MAX = 700;
const SEP = '\n\n---\n\n';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : []);

export function clip(s: string | null | undefined, n: number): string {
  const t = (s ?? '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > n ? `${t.slice(0, n).trimEnd()}…` : t;
}
const oneLine = (s: string | null | undefined, n: number): string => clip((s ?? '').replace(/\s+/g, ' '), n);
const words = (s: string, n: number): string => s.split(/\s+/).filter(Boolean).slice(0, n).join(' ');

// --- tenant ------------------------------------------------------------------------------------------

export interface Tenant {
  initiatives: Obj[];
  umbrellas: Obj[];
  companies: Obj[];
  notes: [string, string][]; // registry-level notes
  people: Obj[];
  rules: Obj[];
  attribution: Obj | null;
}

// A list may come bare, wrapped ({initiatives: […]}) or — umbrellas in one tenant, companies maybe in the
// next — as a map keyed by id. The labeller must read every layout a tenant actually ships.
function asList(v: unknown, key?: string): Obj[] {
  if (Array.isArray(v)) return v.filter(isObj);
  if (!isObj(v)) return [];
  if (key) return Array.isArray(v[key]) ? (v[key] as unknown[]).filter(isObj) : [];
  return Object.entries(v).map(([id, x]) => (isObj(x) ? { id, ...x } : { id, name: str(x) }));
}

export function normaliseTenant(raw: { registry?: unknown; people?: unknown; rules?: unknown; attribution?: unknown }): Tenant {
  const reg = raw.registry;
  return {
    initiatives: asList(reg, 'initiatives').filter((i) => typeof i.id === 'string' && !!i.id),
    umbrellas: isObj(reg) ? asList(reg.umbrellas) : [],
    companies: isObj(reg) ? asList(reg.companies) : [],
    notes: isObj(reg) && isObj(reg.notes) ? Object.entries(reg.notes).filter((e): e is [string, string] => typeof e[1] === 'string') : [],
    people: asList(raw.people, 'people').filter((p) => typeof p.person_id === 'string' && !!p.person_id),
    rules: asList(raw.rules, 'rules').filter((r) => typeof r.id === 'string'),
    attribution: isObj(raw.attribution) ? raw.attribution : null,
  };
}

export function readTenant(tenantDir: string): Tenant {
  const read = (rel: string): unknown => {
    const p = join(tenantDir, rel);
    if (!existsSync(p)) return undefined;
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch (e) {
      throw new Error(`${p}: ${(e as Error).message}`);
    }
  };
  return normaliseTenant({ registry: read('initiatives.json'), people: read('annotations/people.json'), rules: read('annotations/rules.json'), attribution: read('annotations/attribution.json') });
}

// --- label space -------------------------------------------------------------------------------------

export interface LabelSpace {
  initiatives: string[]; // t1 closed list (alias-resolved registry ids incl. admin buckets and personal)
  aliases: Record<string, string[]>; // registry id outside the list → what it means: [target] (alias_of) or the split parts, largest first
  people: string[]; // t3 / t4-addressee closed list
  subject: string | null;
  personal: string | null; // the private-life initiative, when the registry has one
  admin: Record<string, string>; // umbrella → its admin bucket (attribution.json)
}

const PERSONAL_RE = /\b(personal|private|privat)\b/i;

export function labelSpaceOf(meta: DatasetMeta, t: Tenant): LabelSpace {
  const byId = new Map(t.initiatives.map((i) => [str(i.id), i]));
  const given = meta.labelSpace?.initiatives ?? [];
  const initiatives = given.length ? [...given] : t.initiatives.filter((i) => !i.alias_of && !i.split_into).map((i) => str(i.id));
  const inSpace = new Set(initiatives);
  const resolveId = (id: string, depth: number): string[] => {
    if (inSpace.has(id)) return [id];
    const ini = byId.get(id);
    if (!ini || depth > 5) return [];
    if (isObj(ini.split_into)) return Object.entries(ini.split_into).sort((a, b) => Number(b[1]) - Number(a[1])).flatMap(([x]) => resolveId(x, depth + 1));
    return typeof ini.alias_of === 'string' ? resolveId(ini.alias_of, depth + 1) : [];
  };
  const aliases: Record<string, string[]> = {};
  for (const id of byId.keys()) {
    if (inSpace.has(id)) continue;
    const r = [...new Set(resolveId(id, 0))];
    if (r.length) aliases[id] = r;
  }
  const att = t.attribution;
  const subject = meta.subject ?? (typeof att?.subject === 'string' ? att.subject : null);
  const people = [...new Set([...(meta.labelSpace?.people ?? []), ...t.people.map((p) => str(p.person_id)), ...(subject ? [subject] : [])])];
  const personal = initiatives.find((id) => PERSONAL_RE.test(`${id} ${str(byId.get(id)?.name)} ${str(byId.get(id)?.umbrella)}`)) ?? null;
  const admin: Record<string, string> = {};
  const adm = att?.admin;
  if (isObj(adm)) for (const [u, x] of Object.entries(adm)) if (typeof x === 'string' && x) admin[u] = x;
  return { initiatives, aliases, people, subject, personal, admin };
}

// --- context pack ------------------------------------------------------------------------------------

const ROUTE_NAMES: Record<string, string> = {
  repos: 'repos',
  local_paths: 'paths',
  slack_channels: 'slack channels',
  teams_channels: 'teams channels',
  jira_keys: 'jira keys',
  youtrack_prefixes: 'youtrack keys',
  youtrack_projects: 'youtrack projects',
  calendar_title_patterns: 'call titles',
  asana_projects: 'asana projects',
  confluence_spaces: 'confluence spaces',
};

// An initiative's routing sources as one phrase. Entries come as strings, {id, name} channel objects
// (which the production registry parser drops — the labeller must not) or {KEY: name} maps.
export function routeSummary(sources: unknown): string {
  if (!isObj(sources)) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(sources)) {
    const raw = Array.isArray(v) ? v : isObj(v) ? Object.entries(v).map(([key, name]) => (typeof name === 'string' && name ? `${key} (${name})` : key)) : [v];
    const vals = raw
      .map((x) => (isObj(x) ? str(x.name ?? x.id) : typeof x === 'string' || typeof x === 'number' ? String(x) : '').trim())
      .filter(Boolean)
      .map((x) => (k === 'calendar_title_patterns' ? JSON.stringify(x) : oneLine(x, 100)));
    if (!vals.length) continue;
    const shown = vals.length > 40 ? [...vals.slice(0, 40), `+${vals.length - 40} more`] : vals;
    parts.push(`${ROUTE_NAMES[k] ?? k.replace(/_/g, ' ')}: ${shown.join(', ')}`);
  }
  return parts.join('; ');
}

function objFacts(o: Obj, skip: string[]): string {
  const name = typeof o.name === 'string' ? o.name : '';
  const rest = Object.entries(o)
    .filter(([k, v]) => !skip.includes(k) && k !== 'name' && (typeof v === 'string' || typeof v === 'number') && String(v).trim())
    .map(([k, v]) => `${k}: ${oneLine(String(v), 160)}`);
  return [name, ...rest].filter(Boolean).join(' · ') || '(no details)';
}

function initiativePeople(v: unknown): string {
  if (!Array.isArray(v)) return '';
  const xs = v
    .map((x) => (typeof x === 'string' ? x : isObj(x) ? [str(x.email_or_name ?? x.person_id ?? x.name ?? x.id), x.role ? `(${str(x.role)})` : ''].filter(Boolean).join(' ') : ''))
    .filter(Boolean);
  return xs.length > 12 ? `${xs.slice(0, 12).join(', ')} +${xs.length - 12} more` : xs.join(', ');
}

export function initiativeLines(i: Obj, space?: LabelSpace): string[] {
  const id = str(i.id);
  const alias = typeof i.alias_of === 'string' ? ` — alias of \`${i.alias_of}\` (answer that id)` : '';
  const split = isObj(i.split_into) ? ` — split into ${Object.entries(i.split_into).map(([k, w]) => `\`${k}\` ${Math.round(Number(w) * 100)}%`).join(' / ')} (answer the parts)` : '';
  const outside = space && !alias && !split && !space.initiatives.includes(id) && !space.aliases[id] ? ' — not in the label list' : '';
  const facts = [i.name ? `"${oneLine(str(i.name), 120)}"` : '', i.umbrella ? `umbrella ${str(i.umbrella)}` : '', i.company ? `company ${str(i.company)}` : '', i.billing_code ? `billing ${str(i.billing_code)}` : '', i.status ? `status ${str(i.status)}` : ''].filter(Boolean);
  const lines = [`- \`${id}\`${alias}${split}${outside}${facts.length ? ` — ${facts.join(' · ')}` : ''}`];
  const routes = routeSummary(i.sources);
  if (routes) lines.push(`    routes: ${routes}`);
  const ppl = initiativePeople(i.people);
  if (ppl) lines.push(`    people: ${ppl}`);
  const notes = Array.isArray(i.notes) ? strs(i.notes).join('; ') : str(i.notes);
  if (notes) lines.push(`    notes: ${oneLine(notes, 300)}`);
  return lines;
}

export function personLine(p: Obj, subject: string | null): string {
  const id = str(p.person_id);
  const m = isObj(p.marker) ? p.marker : null;
  const marker = m
    ? `marker ${str(m.type)}${strs(m.initiatives).length ? ` → ${strs(m.initiatives).join(', ')}` : ''}`
    : typeof p.default_initiative === 'string'
      ? `marker broad → ${p.default_initiative}`
      : '';
  const facts = [oneLine(str(p.name), 80), p.company ? `company ${str(p.company)}` : '', marker, id === subject ? 'THE SUBJECT' : ''].filter(Boolean);
  const ids = strs(p.identities).map((x) => oneLine(x, 80));
  return [`- \`${id}\` — ${facts.join(' · ')}`, ids.length ? `    identities: ${ids.join(', ')}` : '', p.note ? `    note: ${oneLine(str(p.note), 160)}` : ''].filter(Boolean).join('\n');
}

// A tenant rule as a sentence: {when: {container, title_re, …}, then: {initiative | candidates}}.
export function ruleLine(r: Obj): string {
  const w = isObj(r.when) ? r.when : {};
  const t = isObj(r.then) ? r.then : {};
  const conds = Object.entries(w)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => {
      const s = str(v);
      if (k === 'person') return `participant ${s}`;
      if (k === 'container') return `container = ${JSON.stringify(s)}`;
      if (k === 'title_re') return `title ~ /${s}/i`;
      if (k === 'repo') return `repo = ${s}`;
      if (k === 'project_key') return `tracker key prefix = ${s}`;
      if (k === 'source') return `source = ${s}`;
      return `${k} = ${JSON.stringify(v)}`;
    });
  const cands = strs(t.candidates);
  const then = cands.length ? `one of ${cands.join(' | ')} (content decides)` : str(t.initiative) || '?';
  const note = str(r.note);
  return `- ${str(r.id)}: ${conds.join(' AND ') || '(no condition)'} → ${then}${note ? ` — ${oneLine(note, 140)}` : ''}`;
}

const READING = `## Reading the units
- Each unit starts with a handle in brackets ([u1], [p1]); answer with that handle as "id".
- Times are local to the tenant zone. Chat containers: "#name" is a channel; "dm:@handle" a direct conversation of the account owner with @handle; "mpim:@a+@b" a group DM of the owner with them; "chat:…" a Teams chat. Mail containers: inbox, sent, archive, spam.
- "[bot]" marks an author the store flags as a bot or integration (the flag misses some). "(= id)" after an author is the roster person that string resolves to.`;

// Everything a careful human reviewer of this tenant would know, rendered once per dataset. It is the
// shared system-prompt prefix of every call, so it must be deterministic (no clocks, no run options).
export function buildContextPack(meta: DatasetMeta, t: Tenant, space: LabelSpace): string {
  const out: string[] = [];
  const section = (title: string, lines: string[]) => {
    if (lines.length) out.push(`## ${title}\n${lines.join('\n')}`);
  };
  const subj = space.subject ? t.people.find((p) => p.person_id === space.subject) : undefined;
  const subjFacts = subj ? ` — ${str(subj.name)}${subj.company ? `, ${str(subj.company)}` : ''}; identities: ${strs(subj.identities).join(', ') || '(none listed)'}` : '';
  out.push(
    [
      `# Tenant context — ${meta.tenant}`,
      `Time zone: ${meta.tz || 'UTC'} (every time and day shown is local to it). Window: ${meta.since} … ${meta.until}.`,
      space.subject
        ? `Subject — the owner whose stream this is: \`${space.subject}\`${subjFacts}.`
        : 'No single subject: a team tenant whose stream is shared channels, trackers and mailboxes.',
    ].join('\n'),
  );
  section('Umbrellas (billing frames)', t.umbrellas.map((u) => `- \`${str(u.id)}\` — ${objFacts(u, ['id'])}`));
  section('Companies', t.companies.map((c) => `- \`${str(c.id)}\` — ${objFacts(c, ['id'])}`));
  section('Initiatives (the registry)', t.initiatives.flatMap((i) => initiativeLines(i, space)));
  const known = new Set(t.initiatives.map((i) => str(i.id)));
  section('Further initiative labels (no registry entry)', space.initiatives.filter((id) => !known.has(id)).map((id) => `- \`${id}\``));
  section('Admin buckets (non-billable money, contract, tax and visa matters, per umbrella)', Object.entries(space.admin).map(([u, id]) => `- umbrella ${u} → \`${id}\``));
  let budget = 3000;
  section(
    'Registry notes',
    t.notes.map(([k, v]) => `- ${k}: ${oneLine(v, 300)}`).filter((l) => (budget -= l.length) >= 0),
  );
  section('People (the roster)', t.people.map((p) => personLine(p, space.subject)));
  section('Tenant routing rules (first match wins; usually right, sometimes stale or too broad)', t.rules.map(ruleLine));
  out.push(READING);
  out.push(
    `## Closed lists\nInitiative labels: ${[...space.initiatives, NONE, UNREGISTERED].map((x) => `\`${x}\``).join(', ')}\nPerson ids: ${space.people.map((x) => `\`${x}\``).join(', ') || '(none)'}`,
  );
  return out.join('\n\n');
}

// --- task instructions ---------------------------------------------------------------------------------

const PREAMBLE = `You are a meticulous annotator. You are building the reference ("gold") labels a bench uses to score an automated pipeline that reads one tenant's work stream — chat, e-mail, tracker tickets, calendars, call notes, work sessions — and must attribute work to initiatives, recognise people, classify incoming items and catch repeats. The pipeline is scored against your labels, so:
- Decide from the evidence shown and the tenant context below. Do not invent facts, and do not follow a channel name or a pattern when the content says otherwise.
- Be calibrated: "confidence" is your probability that the answer is right — 0.9 or more only when the evidence is explicit, 0.6–0.85 for a sound inference, 0.5 or less when you are mostly guessing.
- Texts mix English, German, Russian, Italian and other languages. Secrets were scrubbed: "[REDACTED:…]" and "[BODY WITHHELD…]" are placeholders, not content.
- Keep every rationale to 20 words or fewer.`;

function t1Rules(space: LabelSpace): string {
  return `Labels (closed list — anything else is rejected):
- an initiative id exactly as listed under Initiatives or Further initiative labels (for an alias, answer its target);
- "${NONE}" — nothing to attribute: not work at all (spam, newsletters, marketing, automated noise) or content-free chatter (greetings, thanks, "joining in 5", pure scheduling);
- "${UNREGISTERED}" — clearly work, but on a topic no initiative covers (a new client or lead, a project the registry does not list yet).
${space.personal ? `Private life (family, health, home, personal finance or shopping) → "${space.personal}".` : `Private life (family, health, home, personal finance or shopping) → "${NONE}" (this registry has no personal initiative).`}${Object.keys(space.admin).length ? `\nMoney, invoices, payments, contracts, taxes or visas with or about a client → that client umbrella's admin bucket (see Admin buckets); the subject's own private paperwork → the personal initiative when there is one.` : ''}

How to decide:
1. Content first: what is being worked on — product, client, system, repository, ticket key, topic. People are hints, not proof: most people work across several initiatives.
2. Hard signals: a repository or local path an initiative lists; a tracker key whose prefix an initiative lists (ABC-123 → the initiative listing ABC). Softer: channel names and call-title patterns (a broad pattern also matches unrelated calls).
3. Tenant rules are the tenant's shortcuts — usually right, sometimes stale or too broad. Content that clearly contradicts a rule wins.
4. Person markers: exclusive = that person always means those initiatives; narrow = one of those, content picks; broad = a weak hint only.
5. When the unit genuinely belongs to several initiatives (a call covering two projects, a thread about two clients), put the main one (most of the time or content) in "label" and the others in "alts". Never use alts to hedge between options you cannot tell apart — pick one and lower the confidence.
6. Initiatives with status done, dormant or planned remain valid answers when the content is about them.`;
}

function instructions(task: LabelTask, space: LabelSpace): string {
  const subject = space.subject ? ` (the subject, \`${space.subject}\`)` : '';
  switch (task) {
    case 't1-fragment':
      return `## Task: attribute each FRAGMENT of the subject's time to an initiative
A fragment is a piece of the subject's own working time: a call or one topic section of a call ("topic share" is its part of the call), a run of messages the subject wrote in one conversation, or a block of hands-on work (commits, coding or writing sessions in a repository or folder). Which initiative did this time go to?

${t1Rules(space)}`;
    case 't1-item':
      return `## Task: attribute each ITEM of the stream to an initiative
An item is one record of the stream — a chat message or thread, an e-mail, a ticket or ticket comment, a meeting or calendar event — usually written by someone other than the subject. Which initiative is it about, i.e. where would its work be filed?
Automated items: an alert, deploy notice, error report or tracker notification about a specific system, site, host, app or ticket belongs to the initiative that owns it (use host names, app names, repos and keys); if no initiative owns it, "${UNREGISTERED}". Generic automated mail with no work in it (newsletters, marketing, social or tool-account notices) → "${NONE}"; private orders, bills and bank notices → the personal initiative when there is one.

${t1Rules(space)}`;
    case 't3-identity':
      return `## Task: resolve each participant MENTION to a person
A mention is a raw string an integration stored for a participant: a chat author label, an e-mail address (possibly "Name <addr>"), a tracker login, a calendar or meeting attendee entry, an organizer, a commitment owner. Meeting tools sometimes glue several attendees into one string without separators ("Ann Lee Bo Chen", "Ann Lee ann@x.example Bo Chen").

Labels (closed list — anything else is rejected):
- a person_id from the roster;
- several person_ids joined with "+" in alphabetical order when the string glues several people together ("ann-lee+bo-chen"); a glued person who is not in the roster joins as "${UNKNOWN}" ("ann-lee+${UNKNOWN}");
- "${SYSTEM}" — not a person: a bot, an integration or automated sender, a role or shared mailbox (support@, noreply@, billing@, team lists), a meeting room or resource;
- "${UNKNOWN}" — a real person who is not in the roster.

How to decide:
1. Exact identities first: the e-mails, handles and display names listed in the roster.
2. Then names with spelling variance: diacritics or their absence (ü / ue / u), Cyrillic vs Latin transliteration, swapped order ("Lee, Ann"), nicknames and short forms, typos, a "| Company" suffix.
3. A first name alone, initials, or a name two roster people could carry: use the context — the record's title, the other mentions on the same record, the linked calendar event's attendees, the transcript speakers. Answer the best-supported person with a confidence that shows the doubt; answer "${UNKNOWN}" when nothing ties the string to a roster person.
4. Never map by e-mail domain or company alone: an address at a known company that is not in the roster is "${UNKNOWN}" (or "${SYSTEM}" for a role mailbox).`;
    case 't4':
      return `## Task: classify each INCOMING item — kind and addressee
Each unit is an item someone else wrote or a system sent: a chat message, an e-mail, a ticket or comment, an event. Give its kind and the people expected to respond to it.

kind — exactly one; when several fit, take the first that applies in this order: incident, request, question, commitment, info, noise.
- incident: reports something broken, failing or degraded that needs attention — an outage, error, bug, failed job or payment, a firing alert about a real problem. "Checkout returns 500 since 10:00" · "Die Seite lädt seit heute Morgen nicht" · "На проде упал деплой" · "Il sito è giù". A "resolved" or "recovered" notice is not an incident, and a message that only asks for work on an already-known bug is a request.
- request: asks someone to DO something — a change, a fix, a review, a call, a payment, a decision, a file. A polite question that asks for an action is a request. "Can you deploy the fix today?" · "Kannst du mir die Rechnung schicken?" · "Посмотри, пожалуйста, PR" · "Puoi aggiornare il ticket?"
- question: asks for INFORMATION or an opinion; answering is the whole action. "Is the API live on staging?" · "Wann ist das Meeting?" · "Где лежит дамп базы?" · "Hai già visto i log?"
- commitment: the AUTHOR promises to do something, often with a time. "I'll send the draft by Friday" · "Ich kümmere mich morgen darum" · "Сделаю до вечера" · "Lo sistemo domani"
- info: status, FYI, an answer, a decision, a report or a confirmation — worth knowing, no action expected. "Deployed v2.3 to prod" · "Der Vertrag ist unterschrieben" · "Готово, залил на сервер" · "Ho caricato i file"
- noise: nothing to act on and nothing worth knowing — small talk, thanks, greetings, emoji, routine automated notifications (CI passed, deploy done, resolved alerts, sign-ups, digests), newsletters and marketing. "Thanks!" · "Guten Morgen zusammen" · "Спасибо!" · "Grazie mille"

addressee — the roster person_ids the item is addressed to: those expected to act on it or answer it, or to whom a promise or an answer is directed; [] when nobody in particular.
- A direct message (dm:@…, mpim:@…) or a personal e-mail (not a list, newsletter or notification) addresses the account owner${subject}, unless the text clearly turns to someone else.
- People @mentioned or named as the ones to act ("Lea, can you…", "@Jonas") are addressees; people merely talked about are not.
- A reply that answers someone's question addresses the asker.
- [] for noise, for automated notifications, for posts to a channel or list that address nobody in particular ("anyone?", "@here"), and when the addressed person is not in the roster.
- The author is never their own addressee.`;
    case 't2-pairs':
      return `## Task: does item B repeat item A?
Each unit shows two items of the stream, A and B (B is not earlier than A). Is B a repeat of A for triage purposes — the same notification, event or request re-sent, cross-posted to another channel, forwarded, or the same alert rule flapping on the same host — so that deciding A also decides B?

Labels: "${SAME}" or "${DIFFERENT}".
- ${SAME}: duplicates and near-duplicates of one message; the same alert or notification fired again for the same rule and target; a warning followed by its "resolved" for the same rule and host; a cross-post or forward of the same content; a bump that re-sends the same request ("any update on X?") with nothing new. Identical automated notifications with no distinguishing detail count as ${SAME}.
- ${DIFFERENT}: a new event of the same kind (another error, ticket, order, customer, host or rule — same template, different substance); a reply or follow-up that adds information or changes the request; two messages that only share a template ("Daily report", "New sign-up") but report different facts that each need their own triage.
Judge by substance: identifiers (ticket keys, hosts, error names, amounts, people) matter; timestamps and counters alone do not.`;
  }
}

const T1_FORMAT = `[{"id": "u1", "label": "<initiative id | ${NONE} | ${UNREGISTERED}>", "alts": [], "confidence": 0.8, "rationale": "<= 20 words"}]
"alts" lists other initiatives the unit genuinely also belongs to; [] when there are none.`;
const FORMAT: Record<LabelTask, string> = {
  't1-fragment': T1_FORMAT,
  't1-item': T1_FORMAT,
  't3-identity': `[{"id": "u1", "label": "<person_id | id+id | ${SYSTEM} | ${UNKNOWN}>", "confidence": 0.8, "rationale": "<= 20 words"}]`,
  t4: `[{"id": "u1", "kind": "<${KINDS.join(' | ')}>", "addressee": ["<person_id>"], "confidence": 0.8, "rationale": "<= 20 words"}]
"addressee" is [] when nobody in particular; "confidence" covers kind and addressee together.`,
  't2-pairs': `[{"id": "p1", "label": "<${SAME} | ${DIFFERENT}>", "confidence": 0.8, "rationale": "<= 20 words"}]`,
};

// Shared prefix first (preamble + tenant pack: identical for every task of a dataset), task text after.
export function systemPrompt(task: LabelTask, pack: string, space: LabelSpace): string {
  return [PREAMBLE, pack, instructions(task, space), `## Answer format\nReturn ONLY a JSON array — one object per unit, every unit exactly once, no prose, no code fences:\n${FORMAT[task]}`].join('\n\n');
}

// --- unit rendering ------------------------------------------------------------------------------------

export interface RenderCtx {
  tz: string;
  names: Map<string, string>; // person_id → display name (the roster)
}

export function renderCtx(meta: DatasetMeta, t: Tenant): RenderCtx {
  return { tz: meta.tz || 'UTC', names: new Map(t.people.map((p) => [str(p.person_id), str(p.name)])) };
}

// 'YYYY-MM-DD HH:MM' in the tenant zone; an unparsable stamp is shown as given.
export function localTime(iso: string | null | undefined, tz: string): string {
  const d = new Date(iso ?? '');
  if (!iso || Number.isNaN(d.getTime())) return iso ?? '';
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

const list = (xs: string[], n: number): string => (xs.length > n ? `${xs.slice(0, n).join(', ')} +${xs.length - n} more` : xs.join(', '));

export function renderFragment(u: FragmentUnit, handle: string, ctx: RenderCtx): string {
  const who = (id: string) => (ctx.names.get(id) ? `${ctx.names.get(id)} (${id})` : id);
  return [
    `[${handle}] ${u.kind} fragment · ${localTime(u.start, ctx.tz)} · ${u.minutes} min${u.weight > 0 && u.weight < 1 ? ` · topic share ${Math.round(u.weight * 100)}%` : ''}`,
    `source: ${u.source}${u.container ? ` · container: ${u.container}` : ''}${u.repo ? ` · repo: ${u.repo}` : ''}`,
    u.title ? `title: ${oneLine(u.title, 200)}` : '',
    `participants: ${u.participants.length ? list(u.participants.map(who), 15) : '(none resolved)'}`,
    u.projectKeys?.length ? `tracker keys: ${list(u.projectKeys, 12)}` : '',
    `text:\n${clip(u.text, FRAGMENT_TEXT_MAX) || '(empty)'}`,
  ]
    .filter(Boolean)
    .join('\n');
}

// Raw participants, not production's resolved addressees (toPersons): those are the T4 baseline.
export function renderItem(u: ItemUnit, handle: string, ctx: RenderCtx, max = TEXT_MAX): string {
  const author = u.author ? `${oneLine(u.author, 120)}${u.authorPerson ? ` (= ${u.authorPerson})` : ''}` : '(unknown)';
  const others = (u.participants ?? []).filter((p) => p && p !== u.author).map((p) => oneLine(p, 80));
  return [
    `[${handle}] ${u.type} · ${localTime(u.ts, ctx.tz)} · ${u.source}${u.container ? ` · ${u.container}` : ''}`,
    `from: ${author}${u.isBot ? ' [bot]' : ''}${u.fromSubject ? ' [the subject]' : ''}`,
    others.length ? `participants: ${list(others, 12)}` : '',
    u.subject ? `subject: ${oneLine(u.subject, 200)}` : '',
    u.keys?.length ? `keys/links: ${list(u.keys.map((k) => oneLine(k, 120)), 8)}` : '',
    u.context?.length ? `earlier in the thread:\n${u.context.map((c) => `  · ${localTime(c.ts, ctx.tz)} ${c.author ?? '?'}: ${oneLine(c.text, CONTEXT_MAX)}`).join('\n')}` : '',
    `text:\n${clip(u.text, max) || '(empty)'}`,
  ]
    .filter(Boolean)
    .join('\n');
}

// Never shows `production` (today's resolution): that is the T3 baseline.
export function renderMention(u: MentionUnit, handle: string, ctx: RenderCtx): string {
  const c = u.context ?? {};
  const on = [c.title ? JSON.stringify(oneLine(c.title, 160)) : '', c.start ? localTime(c.start, ctx.tz) : '', c.container ?? ''].filter(Boolean);
  const ev = c.linkedEvent;
  return [
    `[${handle}] ${u.field} mention · ${u.source} · seen ${u.seen}× · first ${u.day}`,
    `raw: ${JSON.stringify(u.raw)}`,
    on.length ? `on: ${on.join(' · ')}` : '',
    c.coMentions?.length ? `other mentions on the record: ${list(c.coMentions.map((x) => JSON.stringify(oneLine(x, 80))), 15)}` : '',
    ev ? `linked calendar event: ${JSON.stringify(oneLine(ev.title, 120))} ${localTime(ev.start, ctx.tz)} · attendees: ${list(ev.attendees ?? [], 20) || '(none)'}` : '',
    c.speakers?.length ? `transcript speakers: ${list(c.speakers, 12)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

const gap = (mins: number): string => (mins < 120 ? `${mins} min` : mins < 2880 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / 1440)} days`);

export function renderPair(handle: string, a: ItemUnit, b: ItemUnit, ctx: RenderCtx): string {
  const side = (tag: string, u: ItemUnit) =>
    [
      `${tag}: ${u.type} · ${localTime(u.ts, ctx.tz)} · ${u.source}${u.container ? ` · ${u.container}` : ''} · from ${oneLine(u.author ?? '?', 100)}${u.isBot ? ' [bot]' : ''}`,
      u.subject ? `   subject: ${oneLine(u.subject, 160)}` : '',
      `   text: ${clip(u.text, PAIR_TEXT_MAX).replace(/\n/g, '\n   ') || '(empty)'}`,
    ]
      .filter(Boolean)
      .join('\n');
  const mins = Math.max(0, Math.round((Date.parse(b.ts) - Date.parse(a.ts)) / 60_000));
  return [`[${handle}] B came ${Number.isFinite(mins) ? gap(mins) : '?'} after A`, side('A', a), side('B', b)].join('\n');
}

// --- prompts -------------------------------------------------------------------------------------------

export interface Shown {
  id: string; // the unit id (or pair key) the answer belongs to
  handle: string; // what the model sees and answers with
  text: string;
}

const noun = (task: LabelTask): string => (task === 't2-pairs' ? 'pairs' : 'units');

function reminder(task: LabelTask, shown: readonly Shown[], adjudicate: boolean): string {
  const unsure = adjudicate ? (task === 't4' ? ` "kind" and "addressee" may each also be "${UNSURE}".` : ` "label" may also be "${UNSURE}".`) : '';
  return `Answer with the JSON array only — one object for each of ${shown.map((s) => s.handle).join(', ')}.${unsure}`;
}

// The pass tag keeps A and B apart in the cache even when a one-unit batch cannot be reordered.
export function batchPrompt(task: LabelTask, shown: readonly Shown[], pass: string): string {
  return [`Pass ${pass}. Label each of the ${shown.length} ${noun(task)} below.`, shown.map((s) => s.text).join(SEP), reminder(task, shown, false)].join('\n\n');
}

export function retryPrompt(task: LabelTask, shown: readonly Shown[], errors: readonly string[], pass: string, adjudicate = false): string {
  return [
    `${adjudicate ? 'Adjudication' : `Pass ${pass}`}, retry. An earlier answer for these ${noun(task)} was rejected:\n${errors.map((e) => `- ${e}`).join('\n')}\nAnswer again for these ${shown.length} only, with labels from the closed lists.`,
    shown.map((s) => s.text).join(SEP),
    reminder(task, shown, adjudicate),
  ].join('\n\n');
}

export function adjudicationPrompt(task: LabelTask, shown: readonly Shown[]): string {
  return [
    `Adjudication. Two annotators labelled each of the ${shown.length} ${noun(task)} below independently and disagreed. Re-read the evidence, weigh both answers and their reasons, and give the final answer — one of theirs or another from the closed lists. When the evidence supports no answer with reasonable confidence, answer "${UNSURE}": an unsure unit is left out of the gold set, which is better than a wrong label.`,
    shown.map((s) => s.text).join(SEP),
    reminder(task, shown, true),
  ].join('\n\n');
}

export function describeAnswer(task: LabelTask, a: Answer | null): string {
  if (!a) return '(no valid answer)';
  const head =
    task === 't4'
      ? `kind ${a.label} · addressee [${a.addressee && a.addressee !== NONE ? a.addressee.split('|').join(', ') : ''}]`
      : `label ${a.label}${a.alts?.length ? ` (also: ${a.alts.join(', ')})` : ''}`;
  return `${head} · confidence ${a.confidence.toFixed(2)} — "${a.rationale}"`;
}

// Which pass speaks as "annotator 1" is decided by a hash of the unit, so position bias cannot
// systematically favour pass A.
export function disputeText(task: LabelTask, unitText: string, id: string, a: PassOut, b: PassOut, fields: readonly Field[]): string {
  const [first, second] = fnv1a(`adj:${id}`) % 2 ? [b, a] : [a, b];
  const ans = (x: PassOut) => (typeof x === 'object' ? x : null);
  return [
    unitText,
    `annotator 1: ${describeAnswer(task, ans(first))}`,
    `annotator 2: ${describeAnswer(task, ans(second))}`,
    ...(task === 't4' ? [`disputed: ${fields.map((f) => (f === 'label' ? 'kind' : f)).join(', ')}`] : []),
  ].join('\n');
}

// --- answers: parsing and the closed lists -------------------------------------------------------------

export interface Answer {
  label: string; // t1 initiative | none | unregistered; t3 id(s) | system | unknown; t4 kind; t2 same | different; or 'unsure'
  alts?: string[]; // t1 only
  addressee?: string; // t4 only: setKey of person ids, 'none' or 'unsure'
  confidence: number;
  rationale: string;
}
export type PassOut = Answer | 'invalid' | 'error';
export type Field = 'label' | 'addressee';
export const FIELDS: Record<LabelTask, readonly Field[]> = { 't1-fragment': ['label'], 't1-item': ['label'], 't3-identity': ['label'], t4: ['label', 'addressee'], 't2-pairs': ['label'] };

export function confidenceOf(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n > 1 && n <= 100 ? n / 100 : n));
}

function suggest(x: string, labels: readonly string[]): string {
  const l = x.toLowerCase();
  if (l.length < 3) return '';
  const hits = labels.filter((k) => k.toLowerCase().includes(l) || l.includes(k.toLowerCase())).slice(0, 3);
  return hits.length ? ` (did you mean ${hits.map((h) => JSON.stringify(h)).join(' or ')}?)` : '';
}

// An initiative answer → the ids it stands for (an alias resolves to its target, a split alias to its
// parts), or null when it is not in the closed list. "unregistered:<topic>" counts as unregistered.
export function resolveInitiative(x: string, space: LabelSpace): string[] | null {
  const s = x.trim().replace(/^[`"']+|[`"']+$/g, '');
  const l = s.toLowerCase();
  if (!s) return null;
  if (l === NONE) return [NONE];
  if (l === UNREGISTERED || l.startsWith(`${UNREGISTERED}:`)) return [UNREGISTERED];
  if (space.initiatives.includes(s)) return [s];
  if (space.aliases[s]) return space.aliases[s];
  const ci = space.initiatives.find((id) => id.toLowerCase() === l);
  if (ci) return [ci];
  const ca = Object.keys(space.aliases).find((id) => id.toLowerCase() === l);
  return ca ? space.aliases[ca]! : null;
}

// A t3 answer → canonical label (sorted '+'-joined ids), or an error naming what is not in the roster.
export function identityLabel(v: unknown, space: LabelSpace, allowUnsure = false): string | { error: string } {
  const parts = (Array.isArray(v) ? v.map(str) : str(v).split('+')).map((x) => x.trim().replace(/^[`"']+|[`"']+$/g, '')).filter(Boolean);
  if (!parts.length) return { error: 'empty label' };
  const one = parts.length === 1 ? parts[0]!.toLowerCase() : '';
  if (one === SYSTEM || one === UNKNOWN || (allowUnsure && one === UNSURE)) return one;
  const byLower = new Map(space.people.map((p) => [p.toLowerCase(), p]));
  const ids: string[] = [];
  const bad: string[] = [];
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === UNKNOWN) ids.push(UNKNOWN);
    else if (byLower.has(l)) ids.push(byLower.get(l)!);
    else bad.push(p);
  }
  if (bad.length) return { error: `${bad.map((b) => JSON.stringify(b)).join(', ')} is not a roster person_id${suggest(bad[0]!, space.people)}` };
  return [...new Set(ids)].sort().join('+');
}

// A t4 addressee answer → setKey form ('a|b', sorted) or 'none'.
export function addresseeLabel(v: unknown, space: LabelSpace, allowUnsure = false): string | { error: string } {
  if (v === undefined || v === null) return { error: 'addressee is missing (use [] for nobody in particular)' };
  const raw = Array.isArray(v) ? v.map(str) : str(v).split(/[|,+]/);
  const parts = raw.map((x) => x.trim().replace(/^[`"'@]+|[`"']+$/g, '')).filter(Boolean);
  const lower = parts.map((p) => p.toLowerCase());
  if (allowUnsure && lower.length === 1 && lower[0] === UNSURE) return UNSURE;
  const byLower = new Map(space.people.map((p) => [p.toLowerCase(), p]));
  const bad = parts.filter((p, i) => lower[i] !== NONE && !byLower.has(lower[i]!));
  if (bad.length) return { error: `addressee ${bad.map((b) => JSON.stringify(b)).join(', ')} is not a roster person_id${suggest(bad[0]!, space.people)}` };
  const ids = lower.filter((l) => l !== NONE).map((l) => byLower.get(l)!);
  return ids.length ? setKey(ids) : NONE;
}

// One answer object → a validated Answer, or the error to name in the retry.
export function validateAnswer(task: LabelTask, raw: Obj, space: LabelSpace, adjudicate = false): Answer | string {
  const confidence = confidenceOf(raw.confidence);
  const rationale = words(str(raw.rationale ?? raw.reason ?? ''), 20);
  if (task === 't1-fragment' || task === 't1-item') {
    const label = str(raw.label).trim();
    if (adjudicate && label.toLowerCase() === UNSURE) return { label: UNSURE, confidence, rationale };
    const r = resolveInitiative(label, space);
    if (!r) return `label ${JSON.stringify(label)} is not in the closed list${suggest(label, [...space.initiatives, ...Object.keys(space.aliases)])}`;
    const extra = Array.isArray(raw.alts) ? raw.alts.map(str).flatMap((a) => resolveInitiative(a, space) ?? []) : [];
    // An invalid alt is dropped, not retried: alts only widen what counts as correct, the label is the claim.
    const alts = [...new Set([...r.slice(1), ...extra])].filter((a) => a !== r[0] && a !== NONE && a !== UNREGISTERED);
    return { label: r[0]!, ...(alts.length ? { alts } : {}), confidence, rationale };
  }
  if (task === 't3-identity') {
    const l = identityLabel(raw.label, space, adjudicate);
    return typeof l === 'string' ? { label: l, confidence, rationale } : l.error;
  }
  if (task === 't4') {
    const kind = str(raw.kind ?? raw.label).trim().toLowerCase();
    if (!(KINDS as readonly string[]).includes(kind) && !(adjudicate && kind === UNSURE)) return `kind ${JSON.stringify(kind)} is not one of ${KINDS.join(', ')}`;
    const addr = addresseeLabel(raw.addressee, space, adjudicate);
    return typeof addr === 'string' ? { label: kind, addressee: addr, confidence, rationale } : addr.error;
  }
  const v = raw.label ?? raw.same;
  let l = typeof v === 'boolean' ? (v ? SAME : DIFFERENT) : str(v).trim().toLowerCase();
  if (['yes', 'true', 'repeat', 'duplicate'].includes(l)) l = SAME;
  if (['no', 'false'].includes(l)) l = DIFFERENT;
  if (l !== SAME && l !== DIFFERENT && !(adjudicate && l === UNSURE)) return `label ${JSON.stringify(l)} must be "${SAME}" or "${DIFFERENT}"`;
  return { label: l, confidence, rationale };
}

const handleOf = (v: unknown): string =>
  str(v)
    .trim()
    .toLowerCase()
    .replace(/[[\]\s#]/g, '')
    .replace(/^([up])0+(?=\d)/, '$1');

// The model's text → answers by handle, plus the errors to name in a retry. Accepts an array, an object
// wrapping one array, or a map keyed by handle.
export function parseAnswers(text: string, task: LabelTask, handles: readonly string[], space: LabelSpace, adjudicate = false): { answers: Map<string, Answer>; errors: string[] } {
  const answers = new Map<string, Answer>();
  const errors: string[] = [];
  let data: unknown;
  try {
    data = parseJsonLoose(text);
  } catch {
    return { answers, errors: ['the answer was not a JSON array of objects'] };
  }
  const want = new Set(handles);
  let rows: unknown[] = [];
  if (Array.isArray(data)) rows = data;
  else if (isObj(data)) {
    const arr = Object.values(data).find(Array.isArray);
    if (arr) rows = arr;
    else if (Object.keys(data).some((k) => want.has(handleOf(k)))) rows = Object.entries(data).map(([k, v]) => (isObj(v) ? { id: k, ...v } : { id: k, label: v }));
    else rows = [data];
  }
  const failed = new Set<string>();
  for (const row of rows) {
    if (!isObj(row)) continue;
    const h = handleOf(row.id);
    if (!want.has(h) || answers.has(h) || failed.has(h)) continue;
    const v = validateAnswer(task, row, space, adjudicate);
    if (typeof v === 'string') {
      errors.push(`${h}: ${v}`);
      failed.add(h);
    } else answers.set(h, v);
  }
  const missing = handles.filter((h) => !answers.has(h) && !failed.has(h));
  if (missing.length) errors.push(`${missing.join(', ')}: missing from the answer`);
  return { answers, errors };
}

// --- passes, disputes, adjudication -------------------------------------------------------------------

export type Outcome = 'agreed' | 'adjudicated' | 'unsure' | 'invalid' | 'error';
export interface FieldResult {
  outcome: Outcome;
  label?: string;
  alts?: string[];
  confidence?: number;
  rationale?: string;
}
export type UnitResult = Partial<Record<Field, FieldResult>>;

const valueOf = (a: Answer, f: Field): string | undefined => (f === 'label' ? a.label : a.addressee);

// The fields an adjudicator must settle ([] = A and B agree on every field). A failed call ('error')
// leaves the unit for a re-run — the cache replays everything else, so the protocol completes then.
export function disputedFields(task: LabelTask, a: PassOut, b: PassOut): Field[] | 'invalid' | 'error' {
  if (a === 'error' || b === 'error') return 'error';
  if (a === 'invalid' && b === 'invalid') return 'invalid';
  if (a === 'invalid' || b === 'invalid') return [...FIELDS[task]];
  return FIELDS[task].filter((f) => valueOf(a, f) !== valueOf(b, f));
}

// A and B (and the adjudicator where they disagreed) → per-field outcome. Agreed alts are the
// intersection: one pass's extra initiative is a guess, not a second correct answer.
export function settle(task: LabelTask, a: PassOut, b: PassOut, adj?: PassOut): UnitResult {
  const d = disputedFields(task, a, b);
  const out: UnitResult = {};
  for (const f of FIELDS[task]) {
    if (d === 'error' || d === 'invalid') out[f] = { outcome: d };
    else if (!d.includes(f)) {
      const [A, B] = [a as Answer, b as Answer];
      const alts = f === 'label' ? (A.alts ?? []).filter((x) => (B.alts ?? []).includes(x)) : [];
      out[f] = { outcome: 'agreed', label: valueOf(A, f), ...(alts.length ? { alts } : {}), confidence: (A.confidence + B.confidence) / 2, rationale: A.rationale };
    } else if (!adj || adj === 'error') out[f] = { outcome: 'error' };
    else if (adj === 'invalid') out[f] = { outcome: 'invalid' };
    else {
      const v = valueOf(adj, f);
      out[f] =
        v === undefined || v === UNSURE
          ? { outcome: 'unsure' }
          : { outcome: 'adjudicated', label: v, ...(f === 'label' && adj.alts?.length ? { alts: adj.alts } : {}), confidence: adj.confidence, rationale: adj.rationale };
    }
  }
  return out;
}

export function goldRowsOf(task: Exclude<LabelTask, 't2-pairs'>, id: string, r: UnitResult): GoldRow[] {
  const row = (t: TaskId, f: FieldResult | undefined): GoldRow[] =>
    f && (f.outcome === 'agreed' || f.outcome === 'adjudicated')
      ? [{ id, task: t, label: f.label!, ...(f.alts?.length ? { alts: f.alts } : {}), tier: 'opus', agree: f.outcome === 'agreed' ? 1 : 0.5, ...(f.rationale ? { note: f.rationale } : {}) }]
      : [];
  return task === 't4' ? [...row('t4-kind', r.label), ...row('t4-addressee', r.addressee)] : row(task, r.label);
}

// Deterministic Fisher–Yates (mulberry32 from metrics.ts): pass B's order is the same on every re-run,
// so its prompt — and its cache entry — is too.
export function seededShuffle<T>(xs: readonly T[], seed: string | number): T[] {
  const r = rng(typeof seed === 'number' ? seed : fnv1a(seed));
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// --- the engine ----------------------------------------------------------------------------------------

export interface Job {
  id: string;
  render: (handle: string) => string;
}

export interface FieldTally {
  bothValid: number; // units whose passes A and B both gave a valid answer — the agreement denominator
  agreed: number;
  adjudicated: number;
  unsure: number;
  invalid: number;
  error: number;
}

export interface EngineStats {
  units: number;
  batches: number;
  calls: number;
  cachedCalls: number;
  retries: number;
  costUsd: number; // as if every call were fresh (cached calls report what they cost when made)
  freshUsd: number; // spent by this run
  fields: Partial<Record<Field, FieldTally>>;
}

export interface EngineOpts {
  model: string;
  batchSize: number;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

export async function labelJobs(task: LabelTask, jobs: readonly Job[], system: string, space: LabelSpace, llm: LlmLike, o: EngineOpts): Promise<{ results: Map<string, UnitResult>; stats: EngineStats }> {
  const fields = FIELDS[task];
  const stats: EngineStats = { units: jobs.length, batches: 0, calls: 0, cachedCalls: 0, retries: 0, costUsd: 0, freshUsd: 0, fields: {} };
  for (const f of fields) stats.fields[f] = { bothValid: 0, agreed: 0, adjudicated: 0, unsure: 0, invalid: 0, error: 0 };
  const results = new Map<string, UnitResult>();
  const call = async (prompt: string) => {
    const r = await llm.call({ model: o.model, system, prompt, timeoutMs: o.timeoutMs ?? 600_000 });
    stats.calls++;
    stats.costUsd += r.costUsd;
    if (r.cached) stats.cachedCalls++;
    else stats.freshUsd += r.costUsd;
    return r;
  };
  // One call over `shown`, then one retry for whatever was rejected or missing; 'invalid' after that.
  const pass = async (shown: Shown[], first: string, tag: string, adjudicate: boolean): Promise<Map<string, PassOut>> => {
    const out = new Map<string, PassOut>();
    const r1 = await call(first);
    if (r1.error) {
      for (const s of shown) out.set(s.handle, 'error');
      return out;
    }
    const p1 = parseAnswers(r1.text, task, shown.map((s) => s.handle), space, adjudicate);
    for (const [h, a] of p1.answers) out.set(h, a);
    const bad = shown.filter((s) => !out.has(s.handle));
    if (!bad.length) return out;
    stats.retries++;
    const r2 = await call(retryPrompt(task, bad, p1.errors, tag, adjudicate));
    const p2 = r2.error ? null : parseAnswers(r2.text, task, bad.map((s) => s.handle), space, adjudicate);
    for (const s of bad) out.set(s.handle, p2 ? (p2.answers.get(s.handle) ?? 'invalid') : 'error');
    return out;
  };
  const prefix = task === 't2-pairs' ? 'p' : 'u';
  const batches: Job[][] = [];
  for (let i = 0; i < jobs.length; i += o.batchSize) batches.push(jobs.slice(i, i + o.batchSize));
  stats.batches = batches.length;
  let done = 0;
  await Promise.all(
    batches.map(async (batch) => {
      const shownA: Shown[] = batch.map((j, i) => ({ id: j.id, handle: `${prefix}${i + 1}`, text: j.render(`${prefix}${i + 1}`) }));
      let shownB = seededShuffle(shownA, `B:${batch.map((j) => j.id).join('\n')}`);
      if (shownB.length > 1 && shownB.every((s, i) => s === shownA[i])) shownB = [...shownB.slice(1), shownB[0]!];
      const [ra, rb] = await Promise.all([pass(shownA, batchPrompt(task, shownA, 'A'), 'A', false), pass(shownB, batchPrompt(task, shownB, 'B'), 'B', false)]);
      const disputes: Shown[] = [];
      for (const s of shownA) {
        const d = disputedFields(task, ra.get(s.handle)!, rb.get(s.handle)!);
        if (Array.isArray(d) && d.length) disputes.push({ ...s, text: disputeText(task, s.text, s.id, ra.get(s.handle)!, rb.get(s.handle)!, d) });
      }
      const adj = disputes.length ? await pass(disputes, adjudicationPrompt(task, disputes), 'adjudication', true) : new Map<string, PassOut>();
      for (const s of shownA) {
        const a = ra.get(s.handle)!;
        const b = rb.get(s.handle)!;
        const r = settle(task, a, b, adj.get(s.handle));
        results.set(s.id, r);
        for (const f of fields) {
          const t = stats.fields[f]!;
          if (typeof a === 'object' && typeof b === 'object') t.bothValid++;
          t[r[f]!.outcome]++;
        }
      }
      done++;
      const lf = stats.fields.label!;
      o.log?.(`  batch ${done}/${batches.length} · A=B ${lf.agreed}/${lf.bothValid} · adjudicated ${lf.adjudicated} · unsure ${lf.unsure} · invalid ${lf.invalid} · $${stats.costUsd.toFixed(3)}`);
    }),
  );
  return { results, stats };
}

// --- unit selection -------------------------------------------------------------------------------------

const orderKey = (id: string): number => fnv1a(`order:${id}`);
// The ~10% of bot items that are labelled too: enough to measure how the pipeline treats integration
// traffic without spending most of the budget on it.
export const botSampled = (id: string): boolean => fnv1a(`bot:${id}`) % 10 === 0;

export function byHashOrder<T extends { id: string }>(xs: readonly T[]): T[] {
  return [...xs].sort((a, b) => orderKey(a.id) - orderKey(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// t1-item and t4 label incoming items only: human ones (fromSubject false/absent) and the bot sample.
export function selectUnits(task: LabelTask, units: readonly Unit[], limit?: number): Unit[] {
  let pool = [...units];
  if (task === 't1-item' || task === 't4') pool = (pool as ItemUnit[]).filter((u) => u.fromSubject !== true && (!u.isBot || botSampled(u.id)));
  const sorted = byHashOrder(pool);
  return limit !== undefined && limit >= 0 ? sorted.slice(0, limit) : sorted;
}

// --- t2: candidate pairs --------------------------------------------------------------------------------
// Normalisation and the 6-token template follow the data profile, so the candidate families are the
// ones its compression numbers were measured on.

const EMAIL_RE = /[\p{L}\p{N}_.+-]+@[\p{L}\p{N}_-]+(\.[\p{L}\p{N}_-]+)+/gu;

export function normText(s: string | null | undefined): string {
  let t = (s ?? '').toLowerCase();
  t = t.replace(/<(https?:\/\/[^|>]+)(\|[^>]*)?>/g, ' <url> ');
  t = t.replace(/https?:\/\/\S+/g, ' <url> ');
  t = t.replace(EMAIL_RE, ' <email> ');
  t = t.replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/g, ' <hex> ');
  t = t.replace(/\d+([.,:/-]\d+)*/g, '<n>');
  t = t.replace(/[^\p{L}\p{M}\p{N}_<> ]+/gu, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

const REPLY_RE = /^\s*((re|fw|fwd|aw|wg|antw|ответ)\s*:\s*)+/i;
export const stripReply = (s: string | null | undefined): string => (s ?? '').replace(REPLY_RE, '');
export const isMail = (u: ItemUnit): boolean => (u.source === 'gmail' || u.source === 'msgraph') && !(u.container ?? '').startsWith('chat:');
// The scrubber's whole-body placeholder is identical across unrelated messages — a false cross-post.
const withheld = (u: ItemUnit): boolean => /^\s*\[BODY WITHHELD/.test(u.text ?? '');

export function templateOf(u: ItemUnit, k = 6): string {
  const head = isMail(u) && u.subject ? stripReply(u.subject) : u.text;
  return normText(head).split(' ').filter(Boolean).slice(0, k).join(' ');
}
const bodyOf = (u: ItemUnit): string => normText(`${stripReply(u.subject)} ${u.text ?? ''}`);
const familyKey = (u: ItemUnit): string => `${u.source}\u0000${(u.author ?? '').toLowerCase()}\u0000${templateOf(u)}`;

const ALERT_BAD = new Set(['warning', 'warn', 'critical', 'firing', 'alarm', 'alert', 'down', 'problem', 'triggered']);
const ALERT_OK = new Set(['resolved', 'recovered', 'ok', 'up']);

// "warning BlackboxDomainFlapping <url>", "[FIRING:1] InstanceDown …", "resolved …": state = first word,
// rule = the next word, host = the first host name in the raw text.
export function alertOf(u: ItemUnit): { state: 'bad' | 'ok'; rule: string; host: string } | null {
  const toks = normText(u.text).split(' ').filter((t) => t && !t.startsWith('<'));
  const s = toks[0] ?? '';
  const state = ALERT_BAD.has(s) ? 'bad' : ALERT_OK.has(s) ? 'ok' : null;
  const rule = toks[1] ?? '';
  if (!state || !rule) return null;
  const host = (/\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/i.exec(u.text ?? '')?.[1] ?? '').toLowerCase();
  return { state, rule, host };
}

export type PairType = 'template' | 'prefix' | 'alert' | 'negative';
export interface PairCandidate {
  a: string; // the earlier item
  b: string;
  type: PairType;
  cls: 'bot' | 'human'; // human when either side is human: human-item recall is the dedup metric that must not drop
  family: string; // the group the pair came from (round-robin unit of the sampler)
}

export const pairKey = (a: string, b: string): string => `${a}\n${b}`;
const byTs = (x: ItemUnit, y: ItemUnit): number => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
const clsOf = (a: ItemUnit, b: ItemUnit): 'bot' | 'human' => (a.isBot && b.isBot ? 'bot' : 'human');

// Every candidate pair, cheap and deterministic: consecutive members (by time) of
//   prefix   — same source, same first 200 normalised chars, different containers (cross-posts);
//   alert    — same source + sender + rule + host (or container), a warning/critical, then its resolved;
//   template — same source + author + 6-token template (re-sends, bumps, notification families).
// A pair found by several rules keeps the first type in that order. Human texts under 20 normalised
// chars ("ok", "thanks") and withheld bodies make no candidates.
export function pairCandidates(items: readonly ItemUnit[]): PairCandidate[] {
  const out: PairCandidate[] = [];
  const seen = new Set<string>();
  const add = (a: ItemUnit, b: ItemUnit, type: PairType, family: string) => {
    const k = pairKey(a.id, b.id);
    if (a.id === b.id || seen.has(k)) return;
    seen.add(k);
    out.push({ a: a.id, b: b.id, type, cls: clsOf(a, b), family: `${type}:${family}` });
  };
  // Normalising is the expensive part on a 45k-item store: once per item, not once per rule.
  const feat = new Map<ItemUnit, { body: string; tpl: string; alert: ReturnType<typeof alertOf> }>();
  for (const u of items) if (!withheld(u)) feat.set(u, { body: bodyOf(u), tpl: templateOf(u), alert: alertOf(u) });
  const usable = [...feat.keys()].filter((u) => u.isBot || feat.get(u)!.body.length >= 20).sort(byTs);
  const group = (key: (u: ItemUnit) => string | null) => {
    const g = new Map<string, ItemUnit[]>();
    for (const u of usable) {
      const k = key(u);
      if (k === null) continue;
      const xs = g.get(k);
      if (xs) xs.push(u);
      else g.set(k, [u]);
    }
    return g;
  };
  const sender = (u: ItemUnit) => `${u.source}\u0000${(u.author ?? '').toLowerCase()}`;
  for (const [k, xs] of group((u) => `${u.source}\u0000${feat.get(u)!.body.slice(0, 200)}`)) {
    for (let i = 1; i < xs.length; i++) if ((xs[i - 1]!.container ?? '') !== (xs[i]!.container ?? '')) add(xs[i - 1]!, xs[i]!, 'prefix', k);
  }
  for (const [k, xs] of group((u) => {
    const al = feat.get(u)!.alert;
    return al ? `${sender(u)}\u0000${al.rule}\u0000${al.host || (u.container ?? '')}` : null;
  })) {
    let pending: ItemUnit | null = null;
    for (const u of xs) {
      if (feat.get(u)!.alert!.state === 'bad') pending = u;
      else if (pending && Date.parse(u.ts) - Date.parse(pending.ts) <= 86_400_000) {
        add(pending, u, 'alert', k);
        pending = null;
      }
    }
  }
  for (const [k, xs] of group((u) => (feat.get(u)!.tpl ? `${sender(u)}\u0000${feat.get(u)!.tpl}` : null))) {
    for (let i = 1; i < xs.length; i++) add(xs[i - 1]!, xs[i]!, 'template', k);
  }
  return out;
}

// Stratified sample: equal quotas per (type × bot/human) stratum, a small stratum's leftover spread over
// the rest; inside a stratum, round-robin over families in hash order, so one 2,000-message alert
// family cannot fill the sample.
export function samplePairs(cands: readonly PairCandidate[], n: number, seed = 'pairs-v1'): PairCandidate[] {
  const h = (s: string) => fnv1a(`${seed}:${s}`);
  const strata = new Map<string, PairCandidate[]>();
  for (const c of cands) {
    const k = `${c.type}/${c.cls}`;
    const xs = strata.get(k);
    if (xs) xs.push(c);
    else strata.set(k, [c]);
  }
  const keys = [...strata.keys()].sort();
  const quota = new Map(keys.map((k) => [k, 0]));
  let left = n;
  while (left > 0) {
    const open = keys.filter((k) => quota.get(k)! < strata.get(k)!.length);
    if (!open.length) break;
    const share = Math.max(1, Math.floor(left / open.length));
    for (const k of open) {
      const add = Math.min(share, strata.get(k)!.length - quota.get(k)!, left);
      quota.set(k, quota.get(k)! + add);
      left -= add;
      if (left <= 0) break;
    }
  }
  const out: PairCandidate[] = [];
  for (const k of keys) {
    const fams = new Map<string, PairCandidate[]>();
    for (const c of strata.get(k)!) {
      const xs = fams.get(c.family);
      if (xs) xs.push(c);
      else fams.set(c.family, [c]);
    }
    const order = [...fams.keys()].sort((x, y) => h(x) - h(y) || (x < y ? -1 : 1));
    for (const f of order) fams.get(f)!.sort((x, y) => h(pairKey(x.a, x.b)) - h(pairKey(y.a, y.b)));
    const want = quota.get(k)!;
    const picked: PairCandidate[] = [];
    for (let round = 0; picked.length < want; round++) {
      let any = false;
      for (const f of order) {
        const c = fams.get(f)![round];
        if (!c) continue;
        any = true;
        picked.push(c);
        if (picked.length >= want) break;
      }
      if (!any) break;
    }
    out.push(...picked);
  }
  return out;
}

// Random negatives: A uniform over items, B uniform over A's day with a different template family,
// never a candidate pair. They measure how often the judge (and later the variants) merges unrelated items.
export function negativePairs(items: readonly ItemUnit[], n: number, exclude: ReadonlySet<string>, seed = 'neg-v1'): PairCandidate[] {
  const pool = [...items].filter((u) => !withheld(u)).sort(byTs);
  const byDay = new Map<string, ItemUnit[]>();
  for (const u of pool) {
    const xs = byDay.get(u.day);
    if (xs) xs.push(u);
    else byDay.set(u.day, [u]);
  }
  const r = rng(fnv1a(seed));
  const seen = new Set(exclude);
  const out: PairCandidate[] = [];
  for (let tries = 0; out.length < n && tries < n * 50 && pool.length > 1; tries++) {
    const x = pool[Math.floor(r() * pool.length)]!;
    const day = byDay.get(x.day)!;
    const y = day[Math.floor(r() * day.length)]!;
    if (x === y || familyKey(x) === familyKey(y)) continue;
    const [a, b] = byTs(x, y) <= 0 ? [x, y] : [y, x];
    const k = pairKey(a.id, b.id);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ a: a.id, b: b.id, type: 'negative', cls: clsOf(a, b), family: `negative:${x.day}` });
  }
  return out;
}

export interface PairRow {
  a: string;
  b: string;
  same: boolean;
  tier: string; // 'opus' here; other producers may add their own tiers
  agree?: number;
  type?: PairType;
  cls?: 'bot' | 'human';
  note?: string;
}

// --- gold files ------------------------------------------------------------------------------------------

// Re-runs are idempotent: rows of other tiers stay, earlier opus rows of the re-labelled keys are
// replaced (whatever the new outcome — a now-unsure unit loses its stale row), every other opus row stays.
export function mergeGold<T extends { tier: string }>(existing: readonly T[], fresh: readonly T[], replace: ReadonlySet<string>, key: (r: T) => string): T[] {
  return [...existing.filter((r) => r.tier !== 'opus' || !replace.has(key(r))), ...fresh];
}

// --- run -------------------------------------------------------------------------------------------------

export interface RunOpts {
  dir: string; // dataset directory
  task: LabelTask;
  model?: string;
  limit?: number;
  batchSize?: number;
  pairs?: number; // t2: candidate pairs to sample (default 300)
  negatives?: number; // t2: random negatives (default 60)
  dryRun?: boolean; // build everything, call nothing, write nothing
  log?: (msg: string) => void;
}

export interface FileReport {
  task: string;
  path: string;
  rows: number; // opus rows written by this run
}

export interface RunSummary {
  task: LabelTask;
  dataset: string;
  model: string;
  selected: number;
  systemChars: number;
  stats: EngineStats | null; // null on a dry run
  files: FileReport[];
}

const readMeta = (dir: string): DatasetMeta => JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as DatasetMeta;

export async function runLabel(o: RunOpts, llm: LlmLike | null): Promise<RunSummary> {
  const log = o.log ?? (() => {});
  const meta = readMeta(o.dir);
  const tenant = readTenant(join(o.dir, 'tenant'));
  const space = labelSpaceOf(meta, tenant);
  const system = systemPrompt(o.task, buildContextPack(meta, tenant, space), space);
  const ctx = renderCtx(meta, tenant);
  const model = o.model ?? 'opus';
  const unitsPath = join(o.dir, 'units', `${UNIT_KIND[o.task]}.jsonl`);
  const units = readJsonl<Unit>(unitsPath);
  if (!units.length) throw new Error(`no units in ${unitsPath}`);
  let jobs: Job[];
  let pairs: PairCandidate[] = [];
  if (o.task === 't2-pairs') {
    const items = units as ItemUnit[];
    const byId = new Map(items.map((u) => [u.id, u]));
    const cands = pairCandidates(items);
    // --limit keeps the candidate : negative ratio (300 : 60 by default); a candidate shortfall is not
    // padded with negatives, which would turn the set into a mostly-trivial one.
    const [nPairs, nNeg] = [o.pairs ?? 300, o.negatives ?? 60];
    const wantPairs = o.limit !== undefined ? Math.round((o.limit * nPairs) / Math.max(1, nPairs + nNeg)) : nPairs;
    const wantNeg = o.limit !== undefined ? o.limit - wantPairs : nNeg;
    pairs = [...samplePairs(cands, wantPairs), ...negativePairs(items, wantNeg, new Set(cands.map((c) => pairKey(c.a, c.b))))];
    pairs = byHashOrder(pairs.map((p) => ({ ...p, id: pairKey(p.a, p.b) })));
    jobs = pairs.map((p) => ({ id: pairKey(p.a, p.b), render: (h) => renderPair(h, byId.get(p.a)!, byId.get(p.b)!, ctx) }));
    log(`t2 candidates: ${cands.length} (${Object.entries(countBy(cands, (c) => `${c.type}/${c.cls}`)).map(([k, v]) => `${k} ${v}`).join(', ')}); labelling ${pairs.length}`);
  } else {
    const selected = selectUnits(o.task, units, o.limit);
    const render = (u: Unit, h: string): string =>
      UNIT_KIND[o.task] === 'fragment' ? renderFragment(u as FragmentUnit, h, ctx) : UNIT_KIND[o.task] === 'mention' ? renderMention(u as MentionUnit, h, ctx) : renderItem(u as ItemUnit, h, ctx);
    jobs = selected.map((u) => ({ id: (u as { id: string }).id, render: (h) => render(u, h) }));
  }
  const batchSize = Math.max(1, o.batchSize ?? 16);
  const summary: RunSummary = { task: o.task, dataset: meta.name || basename(o.dir), model, selected: jobs.length, systemChars: system.length, stats: null, files: [] };
  // The system prompt travels as one argv entry of `claude -p`; Linux caps a single argument at 128 KiB.
  if (Buffer.byteLength(system) > 120_000) throw new Error(`system prompt is ${Buffer.byteLength(system)} bytes — too large for one CLI argument; trim the tenant files`);
  if (o.dryRun || !llm) {
    const first = jobs.slice(0, batchSize).map((j, i) => {
      const handle = `${o.task === 't2-pairs' ? 'p' : 'u'}${i + 1}`;
      return { id: j.id, handle, text: j.render(handle) };
    });
    log(`--- system prompt (${system.length} chars) ---\n${system}\n--- first batch, pass A ---\n${batchPrompt(o.task, first, 'A')}`);
    return summary;
  }
  const { results, stats } = await labelJobs(o.task, jobs, system, space, llm, { model, batchSize, log });
  summary.stats = stats;
  const goldDir = join(o.dir, 'gold');
  if (o.task === 't2-pairs') {
    const fresh: PairRow[] = [];
    const replace = new Set<string>();
    for (const p of pairs) {
      const f = results.get(pairKey(p.a, p.b))?.label;
      if (!f || f.outcome === 'error') continue;
      replace.add(pairKey(p.a, p.b));
      if (f.outcome === 'agreed' || f.outcome === 'adjudicated') {
        fresh.push({ a: p.a, b: p.b, same: f.label === SAME, tier: 'opus', agree: f.outcome === 'agreed' ? 1 : 0.5, type: p.type, cls: p.cls, ...(f.rationale ? { note: f.rationale } : {}) });
      }
    }
    const path = join(goldDir, 't2-pairs.jsonl');
    writeJsonl(path, mergeGold(readJsonl<PairRow>(path), fresh, replace, (r) => pairKey(r.a, r.b)));
    summary.files.push({ task: 't2-pairs', path, rows: fresh.length });
    return summary;
  }
  const task = o.task;
  const targets: [TaskId, Field][] = task === 't4' ? [['t4-kind', 'label'], ['t4-addressee', 'addressee']] : [[task, 'label']];
  for (const [taskId, field] of targets) {
    const fresh: GoldRow[] = [];
    const replace = new Set<string>();
    for (const j of jobs) {
      const r = results.get(j.id);
      if (!r?.[field] || r[field]!.outcome === 'error') continue;
      replace.add(j.id);
      fresh.push(...goldRowsOf(task, j.id, r).filter((g) => g.task === taskId));
    }
    const path = join(goldDir, `${taskId}.jsonl`);
    writeJsonl(path, mergeGold(readJsonl<GoldRow>(path), fresh, replace, (r) => r.id));
    summary.files.push({ task: taskId, path, rows: fresh.length });
  }
  return summary;
}

function countBy<T>(xs: readonly T[], key: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return out;
}

export function formatSummary(s: RunSummary): string {
  const lines = [`label ${s.task} (${PROTOCOL}) · dataset ${s.dataset} · model ${s.model} · ${s.selected} ${s.task === 't2-pairs' ? 'pairs' : 'units'} · system prompt ${s.systemChars} chars`];
  const st = s.stats;
  if (!st) return [...lines, '  dry run: nothing called, nothing written'].join('\n');
  lines.push(`  ${st.batches} batches · ${st.calls} calls (${st.cachedCalls} cached, ${st.retries} retries) · cost $${st.costUsd.toFixed(3)} as if fresh · $${st.freshUsd.toFixed(3)} spent now`);
  for (const [f, t] of Object.entries(st.fields)) {
    if (!t) continue;
    const name = s.task === 't4' ? (f === 'label' ? 'kind' : f) : f;
    const rate = t.bothValid ? `${((100 * t.agreed) / t.bothValid).toFixed(1)}%` : '–';
    lines.push(`  ${name}: A=B ${t.agreed}/${t.bothValid} (${rate}) · adjudicated ${t.adjudicated} · unsure ${t.unsure} · invalid ${t.invalid} · errors ${t.error}`);
  }
  for (const f of s.files) lines.push(`  ${f.rows} opus rows → ${f.path}`);
  return lines.join('\n');
}

// --- CLI -------------------------------------------------------------------------------------------------

const USAGE = `usage: npm run lab -- label --dataset <dir|name> --task <${LABEL_TASKS.join('|')}> [--limit N] [--model opus] [--concurrency 6] [--batch 16] [--pairs 300 --negatives 60] [--env <bot .env>] [--dry-run]
  LAB_DIR (default data/lab): datasets/<name>/, cache/label-<dataset>.jsonl, .claude-cfg/
  token: LAB_CLAUDE_TOKEN, else CLAUDE_CODE_OAUTH_TOKEN from --env / LAB_ENV_FILE (default .env)`;

function parseArgs(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) out[a.slice(2)] = argv[++i]!;
    else out[a.slice(2)] = 'true';
  }
  return out;
}

const intArg = (v: string | undefined, name: string): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer, got ${v}`);
  return n;
};

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv[0] === 'label' ? argv.slice(1) : argv);
  if (args.help || !args.dataset || !args.task) {
    console.log(USAGE);
    if (!args.help) process.exitCode = 2;
    return;
  }
  const task = args.task as LabelTask;
  if (!LABEL_TASKS.includes(task)) throw new Error(`--task must be one of ${LABEL_TASKS.join(', ')}`);
  const labDir = resolve(process.env.LAB_DIR ?? 'data/lab');
  const dir = existsSync(join(args.dataset, 'meta.json')) ? resolve(args.dataset) : join(labDir, 'datasets', args.dataset);
  if (!existsSync(join(dir, 'meta.json'))) throw new Error(`no dataset at ${args.dataset} (nor ${dir})`);
  const name = (readMeta(dir).name || basename(dir)).replace(/[^\w.-]+/g, '-');
  const dryRun = args['dry-run'] === 'true';
  let llm: LlmRunner | null = null;
  if (!dryRun) {
    const envFile = args.env ?? process.env.LAB_ENV_FILE ?? '.env';
    let token: string;
    try {
      token = benchToken(envFile);
    } catch (e) {
      throw new Error(`no model token: set LAB_CLAUDE_TOKEN, or point --env / LAB_ENV_FILE at the bot's .env (${(e as Error).message})`);
    }
    llm = new LlmRunner({ cacheFile: join(labDir, 'cache', `label-${name}.jsonl`), configDir: join(labDir, '.claude-cfg'), token, concurrency: intArg(args.concurrency, 'concurrency') ?? 6 });
  }
  const summary = await runLabel(
    {
      dir,
      task,
      model: args.model ?? 'opus',
      limit: intArg(args.limit, 'limit'),
      batchSize: intArg(args.batch, 'batch'),
      pairs: intArg(args.pairs, 'pairs'),
      negatives: intArg(args.negatives, 'negatives'),
      dryRun,
      log: (m) => console.log(m),
    },
    llm,
  );
  console.log(formatSummary(summary));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
