// Item mode: the stage-0 deterministic floor per stream ITEM — every message, ticket, comment and recording of the last
// N local days, not only the subject's fragments. A team tenant has no subject whose day is cut into fragments, and
// its shared bot channels need routing per post (design notes 10 §2.2 T1-item, F8–F11; §9.1). Ported from the lab
// bench's stage-0 floor (src/lab/variants/stage0/{index,floor,t234}.ts — measured on the real and the synthetic stores;
// the bench copy stays), as a derived table the build writes and the `attribution` tool reads (`unit: 'item'`).
//
// Switched on by tenant data only: annotations/attribution.json `"items": {"days": 30}`. Without the key nothing is
// computed and the table stays empty — no prod tenant has attribution.json at all, so this is prod-inert. No model.
//
// Per item, in time order (a reply finds its thread's root decided):
//   sender class (F8)  sender.ts senderClass, plus the one-way bulk rule: an unresolved mail sender with ≥ 3 mails by the
//                      end of the item's day, none in a thread the subject wrote in → bulk. Threaded mail only: the
//                      store threads gmail, not msgraph (thread = ref), where the subject's answers are their own
//                      threads and the rule would call every regular Outlook correspondent bulk. Recordings are people's.
//   family             a reuse key, not a duplicate: source + sender + 6-token template (fingerprint.ts) + the host/app
//                      token it is about (items-text.ts familyToken: an alert's target, else the first host in text
//                      order, monitoring and dashboard hosts aside) — `fam-<hash>`; a bot's question unit is its family-day
//   cluster (F10)      the duplicate cluster (items-dedup.ts): its earliest member's ref, the weakest edge's confidence
//   initiative         the T1-item rungs, first that decides wins (graded confidences — an operating point may drop one):
//     1  the ticket's/comment's own key prefix (its tracker key field) → registry, unique          .98
//     2  a reply inherits its thread's decided root — a topical decision only (not a bulk root's `none`,
//        which says who sent the root; a closed root's `unregistered` waits for 4')         root × .99
//     2' one-way bulk mail → `none` (no other rung can say none; a third of a mailbox)            .90
//     3  bot item: host/app token → registry `hosts`/`apps`                                       .95
//     3' bot item: unknown host/app in a channel whose host list is closed → `unregistered`       .80
//     4  tracker keys in the text, unique (several: candidates)                                   .95
//     4' a reply whose root is closed-list `unregistered`, when its own key and hosts said nothing root × .99
//     5  tenant rule: project_key .97 · container .95 — .85 for a bot item (shared bot channels are mixed);
//        a person rule matches an integration's item through its author only, not whom it mentions
//     6  registry channel (id first, then name; shared: candidates)              .95 person / .85 bot
//     7  mail: the counterpart's domain → its company → that umbrella                 prior + candidates
//     8  author/addressee markers: exclusive .90 · narrow → candidates
//   kind (F11)         a resolved alert → noise .95; any other bot post → noise .90 unless it fires, reports an error,
//                      asks or relays somebody (abstain); bulk → noise .95 unless it asks; a role mailbox → noise .85;
//                      a person's small talk (the strict lexicon) → noise .85; anything else abstains
//   addressee (F11)    an integration addresses nobody (.95; a role mailbox — info@, office@: a person may type there —
//                      .85) · mentions .95/.90 · the DM counterpart .90 · group .60/.85
//                      · the mail's first To .60 (later recipients .55: the store keeps no To/Cc split) · a ticket's
//                      assignee .80 · a vocative "Ana, …" .85 (roster-wide .80) · the author a reply answers .65 · none .70
//   case               ticket:<ref> | call:<id> | family:<fam>:<day> (bot, bulk) | thread:<thread>
// The confidences are the bench's: the design's (§2.2) where the real stores' silver labels agreed with them, lower
// where they measured lower. People resolve through items-people.ts (only a ≥ .95 rung names a person); the registry's
// channel ids, hosts, apps and closed host lists through registry.ts (F6).

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AttributionInputs } from './build.js';
import { channelIdOf, normChannel, Registry, type RegistryData } from './registry.js';
import { ruleMatches, type RuleRecord } from './ladder.js';
import type { FragmentDraft } from './fragment.js';
import type { Person } from '../people.js';
import { alertOf, headOf, senderKey, templateOf, type AlertState } from '../fingerprint.js';
import { isMailItem, isRoleMailbox, parseSender, senderClass as baseSenderClass, type SenderClass } from '../sender.js';
import { foldName } from '../identities/attendees.js';
import { dayIn, loadItems, type ItemIn, type ItemsLoad, type ItemType } from './items-load.js';
import { Dedup, type DedupFeat, type EdgeType } from './items-dedup.js';
import { formKey, resolveMention, roster, translit, type Resolved, type Roster } from './items-people.js';
import { alertIdentity, containerKind, cuesOf, exactKey, exactTokens, familyToken, FORWARD_PREFIX, hostsApps, isSmallTalk, keyPrefixes, normBody, openingName, stripSubject, type ContainerKind, type Cue } from './items-text.js';

export type { SenderClass } from '../sender.js';

/** The graded T1-item rung confidences (§2.2). */
export const ITEM_CONF = { ownKey: 0.98, reply: 0.99, bulk: 0.9, host: 0.95, closed: 0.8, textKey: 0.95, ruleKey: 0.97, ruleContainer: 0.95, ruleContainerBot: 0.85, channel: 0.95, channelBot: 0.85, excl: 0.9 } as const;
export const DEFAULT_ITEM_DAYS = 30;

/** One row of att_items: what the floor says about one stream item. */
export interface ItemRow {
  ref: string;
  day: string; // local day
  ts: string;
  type: ItemType;
  source: string;
  container: string | null;
  sender_class: SenderClass;
  family: string; // fam-<hash>: source + sender + template + host/app — a reuse key, not a duplicate
  cluster: string; // the earliest ref of its duplicate cluster (its own ref when it repeats nothing)
  cluster_conf: number;
  cluster_via: EdgeType | 'single'; // the edge that joined it to an earlier item
  initiative: string | null; // a registry id, `none`, `unregistered`, or null (the floor does not decide)
  conf: number;
  rung: string; // the deciding rung instance (key:<P>, channel:<id>, rule:<id>, host:<h>, sender:bulk, …) or abstain
  candidates: string[];
  hint: string;
  kind: string | null; // `noise` or null — the floor decides nothing else
  kind_conf: number;
  kind_rung: string;
  addressee: string[] | null; // person ids ([] = nobody), or null (the floor does not decide)
  addressee_conf: number;
  addressee_rung: string;
  case_key: string; // the question unit
}

export interface ItemOptions {
  /** Days of the window; default the tenant's `items.days` (a measurement may pass it without the key). */
  days?: number;
  /** Whose mailbox it is; default the attribution subject ('' or null: a team tenant — nobody's). */
  subject?: string | null;
}

export interface ItemWindow {
  since: string;
  until: string;
  days: number;
}

// --- the registry, as the item rungs read it ----------------------------------------------------------------

interface Hits {
  hits: string[]; // alias-resolved initiative ids
  via: string; // what matched first: the rung instance's tail
}
interface Company {
  id: string;
  umbrella: string | null;
  domains: string[];
}

const uniq = <T>(xs: readonly T[]): T[] => [...new Set(xs)];
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : typeof v === 'string' && v.trim() ? [v.trim()] : []);
// Domains in a company's free-text notes ("acme.example, acme-hotels.example"): a token with a dot and a TLD.
const DOMAIN_TOKEN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
const domainsIn = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[\s,;()]+/)
    .map((t) => t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''))
    .filter((t) => DOMAIN_TOKEN.test(t) && !/\.(?:md|json|ts|js|txt)$/.test(t));

/** Registry routes for items: channels, hosts, apps and closed lists from registry.ts; keys, splits and companies here. */
class Routes {
  private readonly companies: Company[];
  constructor(
    readonly reg: Registry,
    private readonly personNames: ReadonlySet<string>,
  ) {
    const raw = (reg.data as { companies?: unknown }).companies;
    this.companies = (Array.isArray(raw) ? raw : [])
      .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && typeof (c as { id?: unknown }).id === 'string')
      .map((c) => ({ id: String(c.id), umbrella: typeof c.umbrella === 'string' && c.umbrella ? c.umbrella : null, domains: uniq([...strs(c.domains).map((d) => d.toLowerCase()), ...domainsIn(typeof c.notes === 'string' ? c.notes : '')]) }));
  }

  /** An id as labels: alias-resolved, a split spread into its targets (shares sum to 1, largest first). */
  private expand(id: string, depth = 0): { id: string; share: number }[] {
    const r = this.reg.resolveAlias(id);
    const raw = this.reg.get(r)?.split_into;
    const split = raw && typeof raw === 'object' ? Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === 'number' && e[1] > 0) : [];
    if (!split.length || depth > 3) return [{ id: r, share: 1 }];
    const sum = split.reduce((a, [, w]) => a + w, 0) || 1;
    const acc = new Map<string, number>();
    for (const [t, w] of split) for (const x of this.expand(t, depth + 1)) acc.set(x.id, (acc.get(x.id) ?? 0) + (w / sum) * x.share);
    return [...acc].map(([i, share]) => ({ id: i, share })).sort((a, b) => b.share - a.share);
  }

  labels(id: string): string[] {
    return this.expand(id).map((x) => x.id);
  }

  keys(prefixes: readonly string[]): Hits {
    const hits: string[] = [];
    let via = '';
    for (const k of prefixes) {
      const K = k.toUpperCase();
      const here = this.reg.data.initiatives.filter((i) => this.reg.keysOf(i).some((x) => x.toUpperCase() === K)).map((i) => i.id);
      if (here.length && !via) via = K;
      hits.push(...here);
    }
    return { hits: uniq(hits.map((h) => this.reg.resolveAlias(h))), via };
  }

  channel(container: string | null, channelId: string | null): Hits {
    const r = this.reg.routeChannel(container, channelId, this.personNames);
    const byId = !!channelId && this.reg.data.initiatives.some((i) => this.reg.channels(i).some((c) => c.id === channelId));
    return { hits: r.candidates, via: byId ? channelId! : normChannel(container ?? '') };
  }

  host(h: string): Hits {
    const r = this.reg.routeHost(h);
    return { hits: r.candidates, via: h };
  }

  app(a: string): Hits {
    const r = this.reg.routeApp(a);
    return { hits: r.candidates, via: a.trim().toLowerCase() };
  }

  closed(container: string | null, channelId: string | null): boolean {
    return this.reg.closedChannel(container, channelId);
  }

  companyOfDomain(domain: string): Company | null {
    const d = domain.toLowerCase();
    const hits = d ? this.companies.filter((c) => c.domains.some((x) => d === x || d.endsWith(`.${x}`))) : [];
    return hits.length === 1 ? hits[0]! : null;
  }

  /** The label ids of a company's initiatives (a company with none: its umbrella's). */
  initiativesOfCompany(company: string, umbrella: string | null): string[] {
    const plain = this.reg.data.initiatives.filter((i) => !i.alias_of && !i.split_into);
    const own = plain.filter((i) => i.company === company).map((i) => i.id);
    return own.length ? own : umbrella ? plain.filter((i) => (i.umbrella || i.id.split('/')[0]) === umbrella).map((i) => i.id) : [];
  }
}

// --- T1-item: the ladder ------------------------------------------------------------------------------------

export interface Decision {
  label: string | null;
  conf: number; // 0 when label is null
  rung: string; // the rung instance ('abstain' when nothing decided)
  candidates: string[];
  hint: string;
}

type MarkerType = 'exclusive' | 'narrow' | 'broad';
interface Marker {
  type: MarkerType;
  initiatives: string[]; // label ids
}

/** The tenant as the item rungs read it (itemTenant builds it from the tenant's files). */
export interface ItemTenant {
  routes: Routes;
  rules: readonly RuleRecord[];
  markers: ReadonlyMap<string, Marker>; // person → marker over label ids
  subject: string | null;
  nameOf: (pid: string) => string;
}

/** The tenant's files as item mode is GIVEN them: the registry, the rules, the people file, whose mailbox, the zone. */
export interface ItemsTenant {
  registry: RegistryData;
  rules: readonly RuleRecord[];
  people: readonly Person[];
  subject: string | null;
  tz: string;
}

export function itemTenant(tenant: ItemsTenant): ItemTenant {
  // A channel list naming a person is a marker, not a place: such name-only entries route nothing.
  const routes = new Routes(new Registry(tenant.registry), new Set(tenant.people.flatMap((p) => [p.name.toLowerCase(), foldName(p.name)])));
  const markers = new Map<string, Marker>();
  for (const p of tenant.people) if (p.marker) markers.set(p.person_id, { type: p.marker.type, initiatives: uniq(p.marker.initiatives.flatMap((i) => routes.labels(i))) });
  const names = new Map(tenant.people.map((p) => [p.person_id, p.name]));
  return { routes, rules: tenant.rules, markers, subject: tenant.subject, nameOf: (pid) => names.get(pid) ?? pid };
}

const NOTHING: Decision = { label: null, conf: 0, rung: 'abstain', candidates: [], hint: '' };

/** One item's way down the rungs: what a candidates rule narrowed, what was seen on the way. */
class Ladder {
  private restrict: string[] | null = null;
  readonly cands = new Set<string>();
  readonly hints: string[] = [];
  constructor(private readonly routes: Routes) {}

  narrow(ids: string[], why: string): void {
    this.restrict = uniq(ids.flatMap((i) => this.routes.labels(i)));
    this.hints.push(why);
  }

  add(ids: readonly string[]): void {
    for (const i of ids) for (const l of this.routes.labels(i)) this.cands.add(l);
  }

  /** A decision for `id` — or null when a candidates rule narrowed the choice and `id` is outside it. */
  decide(id: string, conf: number, rung: string, why: string): Decision | null {
    const labels = this.routes.labels(id);
    let label = labels[0]!;
    if (this.restrict) {
      const inside = labels.find((l) => this.restrict!.includes(l));
      if (!inside) {
        this.hints.push(`${why} → ${label}, outside the rule's candidates`);
        this.add([id]);
        return null;
      }
      label = inside;
    }
    return { label, conf, rung, candidates: labels, hint: why };
  }

  /** Nothing decided: the candidates (inside the rule's set when a rule narrowed it) and the hints. */
  open(extra: string[] = []): Decision {
    let cands = uniq([...this.cands, ...extra]);
    if (this.restrict) {
      const inside = cands.filter((c) => this.restrict!.includes(c));
      cands = inside.length ? inside : this.restrict;
    }
    return { ...NOTHING, candidates: cands, hint: this.hints.join('; ') || 'no signals' };
  }
}

export interface ItemFacts {
  type: ItemType;
  source: string;
  container: string | null;
  channelId: string | null;
  sender: SenderClass;
  ownKey: string | null; // a ticket's/comment's own key prefix
  keys: string[]; // key prefixes in the text, subject and links
  hosts: string[];
  apps: string[];
  persons: string[]; // the author and the addressees, resolved
  author: string | null; // the author alone, resolved — whom a person rule may see in an integration's item
  title: string; // the subject line (rules' title_re)
  domains: string[]; // counterpart mail domains
  root: Decision | null; // the decided first item of the thread, when this one is not it
}

const marked = (persons: readonly string[], t: ItemTenant): { pid: string; m: Marker }[] =>
  uniq(persons)
    .filter((p) => p && p !== t.subject)
    .map((pid) => ({ pid, m: t.markers.get(pid)! }))
    .filter((x) => !!x.m && x.m.initiatives.length > 0);

export function itemFloor(f: ItemFacts, t: ItemTenant): Decision {
  const routes = t.routes;
  const L = new Ladder(routes);
  const machine = f.sender !== 'human';

  // 1. a ticket's own key prefix
  if (f.ownKey) {
    const k = routes.keys([f.ownKey]);
    if (k.hits.length === 1) {
      const d = L.decide(k.hits[0]!, ITEM_CONF.ownKey, `key:${k.via}`, `ticket ${f.ownKey}`);
      if (d) return d;
    } else if (k.hits.length > 1) L.add(k.hits);
  }

  // 2. a reply inherits its thread's decided root — when the root's decision is about the thread's topic. A bulk root's
  // `none` is about its sender: a reply by anyone else is no campaign (a bulk reply says none itself at 2'), and the
  // subject answering it is the opposite of one-way. A closed root's `unregistered` is about the host it alerted on:
  // the reply's own key or host may name what the root could not ("that is the Acme staging box, SHOP-12"), so it
  // waits below rungs 3–4 (4'), above the container rungs that the root already overruled.
  const inherit = (d: Decision): Decision => ({ ...d, conf: d.conf * ITEM_CONF.reply, hint: `reply: ${d.hint}` });
  const rootRung = f.root?.label ? f.root.rung : '';
  if (f.root?.label && rootRung !== 'sender:bulk' && !rootRung.startsWith('closed:')) return inherit(f.root);

  // 2'. one-way bulk mail (newsletters, campaigns) is nothing to attribute: a guess below τ (.90)
  if (f.sender === 'bulk') return { label: 'none', conf: ITEM_CONF.bulk, rung: 'sender:bulk', candidates: [], hint: 'one-way bulk mail' };

  // 3. bot items: host/app tokens → registry hosts/apps; an unknown token in a channel whose host list is closed → unregistered
  if (machine && (f.hosts.length || f.apps.length)) {
    const routed = [...f.hosts.map((h) => ({ ...routes.host(h), kind: 'host' })), ...f.apps.map((a) => ({ ...routes.app(a), kind: 'app' }))].filter((r) => r.hits.length);
    const ids = uniq(routed.flatMap((r) => r.hits));
    if (ids.length === 1) {
      const d = L.decide(ids[0]!, ITEM_CONF.host, `${routed[0]!.kind}:${routed[0]!.via}`, `${routed[0]!.kind} ${routed[0]!.via}`);
      if (d) return d;
    } else if (ids.length > 1) L.add(ids);
    else if (routes.closed(f.container, f.channelId)) {
      return { label: 'unregistered', conf: ITEM_CONF.closed, rung: `closed:${f.channelId ?? f.container ?? ''}`, candidates: [], hint: `unknown ${f.hosts[0] ?? f.apps[0]} in ${f.container}` };
    }
  }

  // 4. tracker keys in the text
  if (f.keys.length) {
    const k = routes.keys(f.keys);
    if (k.hits.length === 1) {
      const d = L.decide(k.hits[0]!, ITEM_CONF.textKey, `key:${k.via}`, `key ${f.keys.join(',')}`);
      if (d) return d;
    } else if (k.hits.length > 1) {
      L.add(k.hits);
      L.hints.push(`keys ${f.keys.join(',')} match several`);
    }
  }

  // 4'. a reply to a closed-list alert whose own key and hosts decided nothing: the root's `unregistered`
  if (f.root?.label && rootRung.startsWith('closed:')) return inherit(f.root);

  // 5. tenant rules: project_key .97; container .95 — .85 for bot items (shared bot channels carry mixed traffic). A
  // person rule sees an integration's item through its author only: Sentry "assigned to @Ana" in beta's alert channel
  // is not Ana's work on her rule's initiative (.97 would beat the channel's .85).
  const participants = machine ? (f.author ? [f.author] : []) : f.persons;
  const draft: FragmentDraft = { id: '', kind: 'thread', start: '', end: '', refs: [], title: f.title, source: f.source, container: f.container, participants, projectKeys: uniq([...(f.ownKey ? [f.ownKey] : []), ...f.keys]), repo: null, weight: 1 };
  for (const r of t.rules) {
    if (!ruleMatches(r, draft)) continue;
    if (r.then?.initiative) {
      const conf = r.when?.container ? (machine ? ITEM_CONF.ruleContainerBot : ITEM_CONF.ruleContainer) : ITEM_CONF.ruleKey;
      const d = L.decide(r.then.initiative, conf, `rule:${r.id}`, `rule ${r.id}`);
      if (d) return d;
      break;
    }
    if (r.then?.candidates?.length) {
      L.narrow(r.then.candidates, `rule ${r.id}: one of ${r.then.candidates.join(' | ')}`);
      break;
    }
  }

  // 6. registry channel (id first, then name; one listed by several initiatives gives candidates)
  if (f.container) {
    const ch = routes.channel(f.container, f.channelId);
    if (ch.hits.length === 1) {
      const d = L.decide(ch.hits[0]!, machine ? ITEM_CONF.channelBot : ITEM_CONF.channel, `channel:${ch.via}`, `channel ${f.container}`);
      if (d) return d;
    } else if (ch.hits.length > 1) {
      L.add(ch.hits);
      L.hints.push(`channel ${f.container} is shared by ${ch.hits.length} initiatives`);
    }
  }

  // 7. mail: the counterpart's domain → its company → that umbrella (a prior, never a decision)
  for (const dom of f.domains) {
    const c = routes.companyOfDomain(dom);
    if (!c) continue;
    L.add(routes.initiativesOfCompany(c.id, c.umbrella));
    L.hints.push(`domain ${dom} → ${c.id}`);
    break;
  }

  // 8. markers of the author and the addressees: exclusive decides (.90), narrow narrows
  const people = marked(f.persons, t);
  const excl = people.filter((x) => x.m.type === 'exclusive');
  if (excl.length) {
    const set = uniq(excl.flatMap((x) => x.m.initiatives));
    if (set.length === 1) {
      const d = L.decide(set[0]!, ITEM_CONF.excl, `excl:${excl[0]!.pid}`, `${t.nameOf(excl[0]!.pid)} is exclusive to ${set[0]}`);
      if (d) return d;
    } else L.add(set);
  }
  const narrow = people.filter((x) => x.m.type === 'narrow');
  if (narrow.length) {
    L.hints.push(`narrow via ${narrow.map((x) => x.pid).join(', ')}`);
    return L.open(uniq(narrow.flatMap((x) => x.m.initiatives)));
  }
  return L.open();
}

// --- F8: one-way bulk mail ----------------------------------------------------------------------------------

/** Who mails how often, and which threads the subject ever wrote in — the one-way bulk rule's evidence. */
export class MailStats {
  private bySender = new Map<string, { t: number; thread: string }[]>();
  private subjectFirst = new Map<string, number>(); // thread → first time the subject wrote in it

  constructor(rows: readonly { thread: string; t: number; sender: string; subjectWrote: boolean }[]) {
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

/** The UTC instant a local day ends (the next local midnight): what a nightly build knew about that day. */
export function dayEndMs(day: string, tz: string): number {
  const next = Date.parse(`${day}T00:00:00Z`) + 86_400_000;
  if (!Number.isFinite(next)) return NaN;
  const t = next - offsetMs(tz, next);
  return next - offsetMs(tz, t);
}

// --- F11: kind and addressee ------------------------------------------------------------------------------

interface Out {
  label: string | null;
  conf: number;
  rung: string;
  candidates: string[];
  hint: string;
}

export interface KindInput {
  cls: SenderClass;
  human: boolean; // written by people (a role mailbox typing a ticket counts)
  cues: Cue[];
  alert: AlertState | null;
  smallTalk: boolean;
  relay?: boolean; // a bot's thread reply or a relayed "*Name*: …" — somebody's words through an integration
}

/**
 * Integrations post more than noise: alert firings and error reports (incident), a support tool relaying a customer,
 * an agent answering a thread. So a firing alert, an error report, a bot asking for something and a relay abstain
 * (a firing alert is an incident to the real stores' silver labels and routine to the synthetic truth: the tenant's
 * call); a resolved alert is noise .95, any other bot post .90, a role mailbox .85, bulk .95 unless it asks.
 */
export function kindOf(i: KindInput): Out {
  const abstain = (rung: string, candidates: string[] = [], hint = ''): Out => ({ label: null, conf: 0, rung, candidates, hint: hint || (i.cues.length ? `cues ${i.cues.join('')}` : '') });
  const noise = (conf: number, rung: string, hint: string): Out => ({ label: 'noise', conf, rung, candidates: ['noise'], hint });
  const has = (c: Cue) => i.cues.includes(c);
  if (!i.human) {
    if (i.cls === 'bot' && i.alert?.state === 'resolved') return noise(0.95, 'auto:resolved', 'a resolved alert');
    if (i.cls === 'bot' || i.cls === 'system') {
      if (i.cls === 'bot' && i.alert?.state === 'firing') return abstain('auto:firing', ['incident', 'noise'], 'a firing alert');
      if (has('I')) return abstain('auto:incident?', ['incident'], 'an error report');
      if (has('Q') || has('R')) return abstain('auto:asks');
      if (i.relay) return abstain('auto:relay', [], "somebody's words through an integration");
      return i.cls === 'bot' ? noise(0.9, 'sender:bot', 'bot sender') : noise(0.85, 'sender:system', 'role mailbox');
    }
    if (has('R')) return abstain('bulk:asks');
    return noise(0.95, `sender:${i.cls}`, `${i.cls} sender`);
  }
  if (i.smallTalk) return noise(0.85, 'smalltalk', 'small talk');
  return abstain('abstain');
}

export interface AddresseeInput {
  human: boolean;
  role?: boolean; // a role mailbox (sender.ts isRoleMailbox): maybe a person typing, so its `none` stays below τ
  type: ItemType;
  author: string | null; // the author's person id
  subject: string | null; // the account owner
  where: ContainerKind;
  asks: boolean; // a request cue: a machine mail asking somebody to act
  mentions: { pid: string; conf: number }[];
  members: string[]; // DM/chat members, or mail recipients in header order ('' = unresolved)
  assignee: string | null;
  vocative: { pid: string; conf: number } | null;
  parent: string | null; // the person whose message this one answers
  smallTalk: boolean;
}

const to = (ids: string[], conf: number, rung: string, hint = ''): Out => {
  const set = uniq(ids).sort();
  return { label: set.join('|') || 'none', conf, rung, candidates: set, hint };
};

// The bench measured lower than the design's .95 for some explicit forms: a DM line is often small talk or an FYI the
// silver labels address to nobody, a ticket's assignee is not always who it turns to, a reply answers its thread more
// often than its last author, and a "personal" mail from an unknown sender is mostly a campaign without a footer.
export function addresseeOf(i: AddresseeInput): Out {
  if (!i.human) {
    // A machine mail that asks for action (assigned to you, verify, action required) is the account owner's to-do.
    if (i.asks && i.where === 'mail' && i.subject) return { label: null, conf: 0, rung: 'auto:asks', candidates: [i.subject], hint: 'a notification asking for action' };
    // info@, office@, reservations@: a small client's shared mailbox is often somebody writing ("Hi Lena, …") — a guess
    // (the synthetic tenant: 32 of 35 right, under τ). noreply@ and notifications@ keep their .95 (15 of 15).
    if (i.role) return to([], 0.85, 'auto:role', 'role mailbox');
    return to([], 0.95, 'auto:none', 'integration');
  }
  if (i.smallTalk) return to([], 0.8, 'smalltalk', 'small talk');
  const notMe = (p: string) => !!p && p !== i.author;
  const ments = i.mentions.filter((m) => notMe(m.pid));
  if (ments.length) return to(ments.map((m) => m.pid), Math.min(...ments.map((m) => m.conf)), 'explicit:mention');
  if (i.where === 'dm' || i.where === 'group') {
    if (i.subject && i.author !== i.subject && i.members.includes(i.subject)) return to([i.subject], i.where === 'dm' ? 0.9 : 0.6, `explicit:${i.where}`);
    const others = uniq(i.members.filter(notMe));
    if (!i.subject && others.length && (i.where === 'dm' || others.length <= 3)) return to(others, i.where === 'dm' ? 0.9 : 0.85, `explicit:${i.where}`);
  }
  if (i.where === 'mail' && i.subject && i.author !== i.subject) {
    const pos = i.members.indexOf(i.subject);
    if (pos === 0) return to([i.subject], 0.6, 'explicit:to', 'first To recipient');
    if (pos > 0) return to([i.subject], 0.55, 'explicit:to?', 'To or Cc');
  }
  if (i.type === 'task' && i.assignee && notMe(i.assignee)) return to([i.assignee], 0.8, 'explicit:assignee');
  if (i.vocative && notMe(i.vocative.pid)) return to([i.vocative.pid], i.vocative.conf, i.vocative.conf >= 0.85 ? 'vocative' : 'vocative~');
  if (i.parent && notMe(i.parent)) return to([i.parent], 0.65, 'implicit');
  return to([], 0.7, 'none');
}

// --- the batch ----------------------------------------------------------------------------------------------

const OWN_KEY = /^([A-Z][A-Z0-9]{1,9})-\d+$/;
const PROJECT = /^[A-Z][A-Z0-9]{1,9}$/;
const TRACKER_KEY = /^[A-Z][A-Z0-9]{1,9}-\d+$/;
const TRACKER_MAIL_DOMAIN = /(?:^|\.)(?:youtrack\.cloud|myjetbrains\.com|atlassian\.net|asana\.com|linear\.app)$/i;
const TRACKER_SUBJECT = /^\s*\[(?:youtrack|jira|asana|linear)\b/i;
// A notice that announces the ticket itself — not a comment, an assignment or a state change.
const TRACKER_CREATED = /\b(?:created|new (?:issue|ticket|task|work item)|reported|opened|erstellt|neu(?:es|er)? (?:ticket|vorgang)|создал[аи]?|создана?|creat[oa]|nuovo ticket)\b/i;
const RELAYED = /^\s*\*[^*\n]{2,60}\*:\s*\n/;
const HANDLE_G = /(?<![\p{L}\p{N}_.@])@([\p{L}\p{N}][\p{L}\p{N}_.-]{1,40})/gu;
/** Free-mail providers: their domains name no company. */
const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'icloud.com', 'me.com', 'aol.com', 'gmx.de', 'gmx.net', 'gmx.ch', 'web.de', 't-online.de', 'bluewin.ch', 'mail.ru', 'yandex.ru', 'ya.ru', 'proton.me', 'protonmail.com', 'mailbox.org', 'pm.me']);

const familyId = (key: string): string => `fam-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
const isSlackReply = (u: ItemIn): boolean => {
  if (u.source !== 'slack' || !u.thread) return false;
  const own = u.ref.split(':').at(-1) ?? '';
  return !u.thread.endsWith(`/${own}`) && !u.thread.endsWith(`:${own}`);
};

/** The floor over one window's items (loadItems), pure: every row of att_items. */
export function floorItems(load: ItemsLoad, tenant: ItemsTenant): ItemRow[] {
  const { subject, tz } = tenant;
  const t = itemTenant(tenant);
  const R: Roster = roster(tenant.people);
  const mail = new MailStats(load.mail);
  const members = new Map<string, Map<string, number>>();
  for (const m of load.members) {
    const c = members.get(m.container) ?? new Map<string, number>();
    c.set(m.person, Math.min(c.get(m.person) ?? Infinity, m.t));
    members.set(m.container, c);
  }
  const subjectDomains = new Set((tenant.people.find((p) => p.person_id === subject)?.identities ?? []).map((i) => parseSender(i).domain).filter(Boolean));

  const dayEnds = new Map<string, number>();
  const dayEnd = (day: string): number => {
    let e = dayEnds.get(day);
    if (e === undefined) dayEnds.set(day, (e = dayEndMs(day, tz)));
    return e;
  };
  const resolved = new Map<string, Resolved>();
  const resolve = (raw: string): Resolved => {
    let r = resolved.get(raw);
    if (!r) resolved.set(raw, (r = resolveMention(R, raw)));
    return r;
  };
  /** A raw string as a person id, only when a rung ≥ .95 names exactly one ('' otherwise). */
  const personOf = (raw: string | null | undefined): string => {
    if (!raw) return '';
    const r = resolve(raw);
    return r.label && r.conf >= 0.95 && !r.label.includes('+') ? r.label : '';
  };
  const authorOf = (u: ItemIn): string => u.authorPerson || personOf(u.author);

  // F8: the sender class, causal — what was known by the end of the item's local day. The one-way rule reads replies by
  // thread, so it needs threaded mail: an msgraph mail is its own thread (store.ts threadIdOf threads slack and gmail
  // only), the subject's answer from Sent Items is another one, and every unresolved correspondent with three mails
  // would turn bulk. Unthreaded mail is bulk by its markers (sender.ts) alone.
  const senderOf = (u: ItemIn): SenderClass => {
    if (u.type === 'meeting') return 'human';
    const isMail = isMailItem(u.source, u.container);
    const author = authorOf(u);
    const at = dayEnd(u.day);
    const wrote = isMail && !!u.thread && mail.subjectWroteIn(u.thread, at);
    const threaded = !!u.thread && u.thread !== u.ref;
    const c = baseSenderClass({ source: u.source, author: u.author, container: u.container, isBotFlag: u.isBot, subject: u.subject, text: u.body, subjectWroteInThread: wrote, authorResolved: !!author });
    return c === 'human' && isMail && threaded && !author && !wrote && mail.oneWay(senderKey(u.author ?? ''), at) ? 'bulk' : c;
  };

  // Features every rung reads, once per item.
  const feats = load.items.map((u) => {
    const isMail = isMailItem(u.source, u.container);
    const ha = hostsApps(u);
    const familyKey = JSON.stringify([u.source, senderKey(u.author ?? ''), templateOf(headOf({ subject: isMail ? u.subject : null, text: u.text })), familyToken(u, ha, !!alertOf(u.text))]);
    return { u, isMail, sender: senderOf(u), hosts: ha.hosts, apps: ha.apps, familyKey, family: familyId(familyKey) };
  });

  // T1-item, in time order: a thread's first item is its root; a reply inherits the root's decision.
  const roots = new Map<string, Decision | null>();
  const initiative = new Map<string, Decision>();
  for (const x of feats) {
    const { u } = x;
    const first = !!u.thread && !roots.has(u.thread);
    const root = u.thread && !first ? (roots.get(u.thread) ?? null) : null;
    // Its own key field only: an Asana gid is no key, and a key its text names is a cross-reference (rung 4), not its own.
    const own = u.type === 'task' || u.type === 'comment' ? (OWN_KEY.exec(u.ownKey ?? '')?.[1] ?? (u.container && PROJECT.test(u.container) ? u.container : null)) : null;
    const author = u.authorPerson || (u.isBot ? '' : personOf(u.author));
    const ds = x.isMail ? (u.fromSubject ? u.participants.map((p) => parseSender(p).domain) : [parseSender(u.author ?? '').domain]) : [];
    const d = itemFloor(
      {
        type: u.type,
        source: u.source,
        container: u.container,
        channelId: channelIdOf(u.ref),
        sender: x.sender,
        ownKey: own,
        keys: keyPrefixes(...u.keys, u.subject, u.text),
        hosts: x.hosts,
        apps: x.apps,
        persons: uniq([author, ...u.toPersons].filter(Boolean)),
        author: author || null,
        title: u.subject ?? '',
        domains: uniq(ds.filter((dm) => dm && !FREE_MAIL.has(dm) && !subjectDomains.has(dm))),
        root,
      },
      t,
    );
    if (first) roots.set(u.thread!, d.label ? d : null);
    initiative.set(u.ref, d);
  }

  // T2: duplicate clusters, in time order (code-unit order on ties, as the bench measured it).
  const engine = new Dedup();
  const byTime = [...feats].sort((a, b) => Date.parse(a.u.ts) - Date.parse(b.u.ts) || (a.u.ref < b.u.ref ? -1 : a.u.ref > b.u.ref ? 1 : 0));
  for (const x of byTime) {
    const { u } = x;
    const human = x.sender === 'human';
    const trackerKeys = u.keys.filter((k) => TRACKER_KEY.test(k));
    const domain = (senderKey(u.author ?? '').split('@')[1] ?? '').toLowerCase();
    const feat: DedupFeat = {
      id: u.ref,
      t: Date.parse(u.ts),
      human,
      task: u.type === 'task',
      medium: u.type === 'meeting' ? 'meeting' : u.type === 'task' || u.type === 'comment' ? 'tracker' : x.isMail ? 'mail' : u.container ? 'chat' : 'other',
      sender: human ? authorOf(u) || senderKey(u.author ?? '') : senderKey(u.author ?? ''),
      container: u.container ?? '',
      thread: u.thread ?? '',
      reply: isSlackReply(u),
      exact: exactKey(u, x.isMail),
      clipped: u.text.length >= 1000 && u.text.endsWith('…'),
      norm: normBody(u.text),
      words: exactTokens(u.text),
      subject: x.isMail ? normBody(stripSubject(u.subject)) : '',
      forward: x.isMail && FORWARD_PREFIX.test(u.subject ?? ''),
      alert: human ? null : alertOf(u.text),
      alertId: human ? '' : alertIdentity(u.text),
      targets: human ? [] : [...x.hosts, ...x.apps].sort(),
      links: [...u.keys.filter((k) => /^https?:\/\//i.test(k) && !/\[redacted/i.test(k) && !k.endsWith('…')), ...trackerKeys],
      trackerKeys,
      trackerMail: x.isMail && !human && (TRACKER_MAIL_DOMAIN.test(domain) || TRACKER_SUBJECT.test(u.subject ?? '')),
      trackerCreated: TRACKER_CREATED.test(`${u.subject ?? ''}\n${u.text.slice(0, 400)}`),
      ownKey: u.type === 'task' && u.ownKey && TRACKER_KEY.test(u.ownKey) ? u.ownKey : '',
      callId: u.type === 'meeting' && u.thread && u.thread !== u.ref ? u.thread : '',
      family: human ? '' : x.familyKey,
    };
    engine.add(feat);
  }

  // T4: kind and addressee.
  const membersOf = (u: ItemIn): Set<string> => {
    const at = dayEnd(u.day);
    const s = new Set([...(members.get(u.container ?? '') ?? [])].filter(([, ts]) => ts <= at).map(([p]) => p));
    for (const p of u.participants) {
      const id = personOf(p);
      if (id) s.add(id);
    }
    for (const p of u.toPersons) s.add(p);
    return s;
  };
  const mentionsOf = (u: ItemIn, present: ReadonlySet<string>): { pid: string; conf: number }[] => {
    const out = new Map<string, number>();
    const put = (pid: string, conf: number) => out.set(pid, Math.max(out.get(pid) ?? 0, conf));
    // A participant label written as @Label (Slack flattens <@U…> to @<label>; labels may hold spaces).
    for (const p of u.participants) {
      if (!p || p === u.author || !u.text.includes(`@${p}`)) continue;
      const id = personOf(p);
      if (id) put(id, 0.95);
    }
    for (const m of u.text.matchAll(HANDLE_G)) {
      const h = m[1]!.replace(/[._-]+$/, '');
      if (/^(?:here|channel|everyone|all|admin|team)$/i.test(h)) continue;
      const r = resolveMention(R, h, { coPresent: present });
      if (r.label && !r.label.includes('+')) put(r.label, r.conf >= 0.95 ? 0.95 : 0.9);
      else if (r.rung === 'first:absent' && r.candidates.length === 1) put(r.candidates[0]!, 0.9); // @ana: the one Ana of the roster
    }
    return [...out].map(([pid, conf]) => ({ pid, conf }));
  };
  const textForCues = (u: ItemIn, isMail: boolean): string => (isMail || u.type === 'task' ? `${u.subject ?? ''}\n${u.text}` : u.text);

  return feats.map((x) => {
    const { u, isMail } = x;
    const d = initiative.get(u.ref)!;
    const c = engine.label(u.ref);
    // A role mailbox writing a ticket or a comment is a client's shared account typing: people's words.
    const human = x.sender === 'human' || (x.sender === 'system' && (u.type === 'task' || u.type === 'comment'));
    const smallTalk = human && (u.type === 'message' || u.type === 'comment') && !isMail && isSmallTalk(u.text);
    const cues = cuesOf(textForCues(u, isMail));
    const k = kindOf({ cls: x.sender, human, cues, alert: human ? null : alertOf(u.text), smallTalk, relay: !human && (isSlackReply(u) || RELAYED.test(u.text)) });

    const author = authorOf(u) || null;
    const present = membersOf(u);
    const where = containerKind(u.source, u.container, isMail, u.type);
    // A mail's people in header order (sender, To…, Cc…) with the sender dropped; an unresolved one keeps its place as ''.
    const people = where === 'mail' ? u.participants.filter((p) => p !== u.author).map((p) => personOf(p)) : uniq([...u.participants.map((p) => personOf(p)).filter(Boolean), ...u.toPersons]);
    // "Ana, …": the one container member called Ana (.85), else the one roster person called Ana (.80).
    let vocative: { pid: string; conf: number } | null = null;
    const name = human ? openingName(translit(u.text)) : null;
    if (name) {
      const want = formKey(name.word).split(' ')[0] ?? '';
      const named = (p: string) => p !== author && (name.surname ? R.tokens.get(p)?.at(-1) : R.tokens.get(p)?.[0]) === want;
      const near = [...present].filter(named);
      const far = near.length ? [] : [...R.tokens.keys()].filter(named);
      if (near.length === 1) vocative = { pid: near[0]!, conf: 0.85 };
      else if (far.length === 1) vocative = { pid: far[0]!, conf: 0.8 };
    }
    // The message this one answers: the latest earlier one by someone else we can name.
    let parent: string | null = null;
    for (const p0 of [...u.context].reverse()) {
      const p = personOf(p0.author);
      if (p && p !== author) {
        parent = p;
        break;
      }
      if (!p && p0.author && p0.author !== u.author) break; // it answers someone we cannot name
    }
    const a = addresseeOf({
      human,
      role: x.sender === 'system' && isRoleMailbox(u.author),
      type: u.type,
      author,
      subject,
      where,
      asks: cues.includes('R'),
      mentions: human ? mentionsOf(u, present) : [],
      members: people,
      assignee: u.type === 'task' ? (u.toPersons[0] ?? null) : null,
      vocative,
      parent,
      smallTalk,
    });

    const caseKey =
      u.type === 'task' || u.type === 'comment'
        ? `ticket:${u.ref.replace(/#c[^#]*$/, '')}`
        : u.type === 'meeting'
          ? u.thread?.startsWith('call:')
            ? u.thread
            : `call:${u.thread ?? u.ref}`
          : x.sender === 'bot' || x.sender === 'bulk'
            ? `family:${x.family}:${u.day}`
            : `thread:${u.thread ?? u.ref}`;
    return {
      ref: u.ref,
      day: u.day,
      ts: u.ts,
      type: u.type,
      source: u.source,
      container: u.container,
      sender_class: x.sender,
      family: x.family,
      cluster: c.cluster,
      cluster_conf: c.conf,
      cluster_via: engine.joined.get(u.ref) ?? 'single',
      initiative: d.label,
      conf: d.label ? d.conf : 0,
      rung: d.rung,
      candidates: d.candidates,
      hint: d.hint,
      kind: k.label,
      kind_conf: k.label ? k.conf : 0,
      kind_rung: k.rung,
      addressee: a.label === null ? null : a.candidates,
      addressee_conf: a.label === null ? 0 : a.conf,
      addressee_rung: a.rung,
      case_key: caseKey,
    };
  });
}

// --- the build's side ---------------------------------------------------------------------------------------

/** The window item mode covers today (the tenant's zone, as of `now`): the last `days` local days; null = item mode off. */
export function itemWindow(inputs: Pick<AttributionInputs, 'config' | 'timezone'>, now: Date = new Date(), days?: number): ItemWindow | null {
  const n = days ?? inputs.config.items?.days;
  if (!n) return null;
  const until = dayIn(inputs.timezone)(now.toISOString());
  const since = new Date(Date.parse(`${until}T00:00:00Z`) - (n - 1) * 86_400_000).toISOString().slice(0, 10);
  return { since, until, days: n };
}

/** The floor's rows for the item window — [] when the tenant has no `items` key (item mode off). Read-only. */
export function computeItems(db: DatabaseSync, inputs: AttributionInputs, people: readonly Person[], now: Date = new Date(), opts: ItemOptions = {}): ItemRow[] {
  const w = itemWindow(inputs, now, opts.days);
  if (!w) return [];
  const subject = (opts.subject !== undefined ? opts.subject : inputs.config.subject) || null;
  const load = loadItems(db, { since: w.since, until: w.until, tz: inputs.timezone }, subject);
  return floorItems(load, { registry: inputs.registry, rules: inputs.rules, people, subject, tz: inputs.timezone });
}

export interface ItemsSummary {
  since: string;
  until: string;
  items: number;
  senders: Record<SenderClass, number>;
  decided: number; // an initiative (or none/unregistered) at any confidence
  clusters: number; // clusters of 2+ items
}

/**
 * Replace att_items (one transaction) and the `att:items` meta the readout keys on. `window` null = item mode off: no
 * rows, no meta — the readout then says so. Without a window the rows' own days stand for it.
 */
export function writeItems(db: DatabaseSync, rows: readonly ItemRow[] | null, window?: ItemWindow | null): ItemsSummary | null {
  const on = rows !== null && window !== null;
  const list = on ? rows! : [];
  const days = list.map((r) => r.day).sort();
  const w = window ?? (days.length ? { since: days[0]!, until: days.at(-1)!, days: 0 } : null);
  const senders: Record<SenderClass, number> = { human: 0, bot: 0, bulk: 0, system: 0 };
  for (const r of list) senders[r.sender_class]++;
  const sizes = new Map<string, number>();
  for (const r of list) sizes.set(r.cluster, (sizes.get(r.cluster) ?? 0) + 1);
  const summary: ItemsSummary | null = on && w ? { since: w.since, until: w.until, items: list.length, senders, decided: list.filter((r) => r.initiative).length, clusters: [...sizes.values()].filter((n) => n > 1).length } : null;
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM att_items');
    const ins = db.prepare(
      'INSERT OR REPLACE INTO att_items(ref, day, ts, type, source, container, sender_class, family, cluster, cluster_conf, cluster_via, initiative, conf, rung, candidates, hint, kind, kind_conf, kind_rung, addressee, addressee_conf, addressee_rung, case_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const r of list) {
      ins.run(r.ref, r.day, r.ts, r.type, r.source, r.container, r.sender_class, r.family, r.cluster, r.cluster_conf, r.cluster_via, r.initiative, r.conf, r.rung, JSON.stringify(r.candidates), r.hint, r.kind, r.kind_conf, r.kind_rung, r.addressee ? JSON.stringify(r.addressee) : null, r.addressee_conf, r.addressee_rung, r.case_key);
    }
    if (summary) db.prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES (?, ?)').run('att:items', JSON.stringify({ ...summary, days: w!.days }));
    else db.prepare("DELETE FROM sync_state WHERE key = 'att:items'").run();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return summary;
}

/** Item mode for one build: compute and write, or clear when the tenant has no `items` key. The one call the build makes. */
export function recomputeItems(db: DatabaseSync, inputs: AttributionInputs, people: readonly Person[], now: Date = new Date()): ItemsSummary | null {
  const w = itemWindow(inputs, now);
  return writeItems(db, w ? computeItems(db, inputs, people, now) : null, w);
}
