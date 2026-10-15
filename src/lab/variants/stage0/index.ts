// Stage 0 — the shared deterministic floor both iteration-1 concepts stand on (design notes/10-design.md §2). This file is
// the API K (keys.ts) and J (judge.ts) code against; one floor per run, cached in ctx.state.
//
// What it reads, all GIVEN to the pipeline (never gold): the dataset's tenant/ (registry, rules, people, attribution.json —
// tenant.ts) and its frozen store.sqlite, read-only (call copies, calendar links, transcript speakers, recipients — links.ts).
// What it fixes over production (§2.1): F1 whole-word admin after the registry, F2 word-bounded short titles and a single
// title hit as a .80 guess, F3 calls keyed by call_id (a duplicate topic inherits its twin), F4 call participants from
// one attendee parser + one folded resolver + the glued split + the calendar link + transcript speakers, F5 a run's
// recipients and group DMs, F6 `{id,name}` channels / shared channels / hosts+apps / tracker keys in commits, F7 broad
// people no longer block the narrow rung, F12 graded confidences. The ladders themselves are pure (floor.ts); this file
// gathers the facts, applies rung 0 (twins), the item thread roots, the rung-instance calibration (calibrate.ts) and the
// case keys (§2.3), and delegates T2–T4 to t234.ts.
//
// Every rung carries a graded confidence (F12): a single title hit is not a repo route, and an operating point must be
// able to drop the weak one.

import { join } from 'node:path';
import type { DayCtx, FragmentUnit, ItemUnit, MemoryRow, MentionUnit, TaskId } from '../../types.js';
import { KINDS, NONE, SYSTEM, UNKNOWN, UNREGISTERED } from '../../types.js';
import { isMailItem, parseSender } from '../../../sources/sender.js';
import { opt } from '../index.js';
import { Calibration, type InstanceStat, type Said } from './calibrate.js';
import { fragmentFloor, itemFloor, keyPrefixes, type Decision, type FloorTenant, type SenderClass } from './floor.js';
import { Links, type MeetingCopy } from './links.js';
import { containerForms } from './people.js';
import { CHANNEL_ID } from './registry.js';
import { loadTenant, type Tenant } from './tenant.js';
import { t234 } from './t234.js';

export type { SenderClass } from './floor.js';

export interface Floor {
  label: string | null; // null = the floor does not decide
  conf: number; // graded rung confidence (§2.2), calibrated per rung instance (§2.5); 0 when label is null
  rung: string; // the rung instance: 'rule:<id>' | 'repo:<r>' | 'channel:<c>' | 'key:<k>' | 'title:<p>' | 'admin' | 'excl:<person>' | …
  candidates: string[]; // narrowed choice set (never a closed list — the closed list is labelSpace())
  hint: string; // human-readable weak prior ('' when none)
  case: string; // the question unit (§2.3)
  umbrella?: string; // umbrella prior when the floor only knows the billing frame
  prior?: number; // the rung's graded confidence before calibration (conf drifts from it as answers come in)
}

export interface RegistryCard {
  id: string; // alias-resolved initiative id
  umbrella: string;
  name: string;
  done: boolean;
  code?: string; // billing code
  cues: string[]; // title patterns, channels, key prefixes, repo basenames, hosts/apps, company
  people: string[]; // display names of people whose exclusive or narrow marker holds this initiative (exclusive first)
}

export interface Stage0 {
  fragment(u: FragmentUnit, pool: FragmentUnit[]): Floor & { participants: string[]; cowork: string[] };
  item(u: ItemUnit, pool: ItemUnit[]): Floor & { senderClass: SenderClass; family: string; hosts: string[]; apps: string[] };
  mention(u: MentionUnit): Floor & { split?: string[] };
  kind(u: ItemUnit): Floor;
  addressee(u: ItemUnit): Floor;
  dedup(dayUnits: ItemUnit[]): Map<string, { cluster: string; conf: number }>; // union-find state survives across days
  labelSpace(task: TaskId): string[]; // the closed list: registry ∪ admin ∪ personal ∪ none ∪ unregistered (alias-resolved)
  cards(): RegistryCard[];
  calibrate(rows: MemoryRow[], decided: Map<string, string>): void; // rung-instance calibration (§2.5)
  /** What the floor said about a unit it saw (instance + label) — what calibrate() charges an answer to. */
  said?(id: string): Said | undefined;
  /** The calibration's counts per rung instance (right/wrong observations), for reports. */
  instances?(): InstanceStat[];
}

const KEY = 'stage0';

// One floor per run (ctx.state survives across the days of one variant × task run).
export function stage0(ctx: DayCtx): Stage0 {
  const cached = ctx.state.get(KEY) as Stage0 | undefined;
  if (cached) return cached;
  const s = build(ctx);
  ctx.state.set(KEY, s);
  return s;
}

type FragOut = Floor & { participants: string[]; cowork: string[] };
type ItemOut = Floor & { senderClass: SenderClass; family: string; hosts: string[]; apps: string[] };

interface CallInfo {
  callId: string | null;
  copyKey: string | null; // this fragment's own meeting copy
  meetingTitle: string;
  participants: string[];
}

const uniq = <T>(xs: readonly T[]): T[] => [...new Set(xs)];
const COWORK_MS = 45 * 60_000;
const OWN_KEY = /^([A-Z][A-Z0-9]{1,9})-\d+$/;
const PROJECT = /^[A-Z][A-Z0-9]{1,9}$/;
/** Free-mail providers: their domain names no company. */
const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'icloud.com', 'me.com', 'aol.com', 'gmx.de', 'gmx.net', 'gmx.ch', 'web.de', 't-online.de', 'bluewin.ch', 'mail.ru', 'yandex.ru', 'ya.ru', 'proton.me', 'protonmail.com', 'mailbox.org', 'pm.me']);

/** The Slack channel id inside a ref (`slack:<team>:<channel>:<ts>`), when there is one. */
export function channelIdOf(ref: string | null | undefined): string | null {
  const parts = (ref ?? '').split(':');
  return parts[0] === 'slack' && parts.length >= 4 && CHANNEL_ID.test(parts[2]!) ? parts[2]! : null;
}

const topicOf = (title: string): string => {
  const i = title.indexOf(' — ');
  return i >= 0 ? title.slice(i + 3).toLowerCase().replace(/\s+/g, ' ').trim() : '';
};

function build(ctx: DayCtx): Stage0 {
  const meta = ctx.dataset;
  const tenant: Tenant = loadTenant(join(ctx.dir, 'tenant'), { subject: meta.subject ?? null, tz: meta.tz });
  const links = Links.open(join(ctx.dir, 'store.sqlite'), ctx.log);
  const rest = t234(ctx); // T2–T4 (owned by the stage-0 T2-T4 agent)
  const calib = new Calibration();
  const rulesMode = opt('rulesAsOf', 'all') === 'day' ? 'day' : 'all';
  const R = tenant.resolver;
  const reg = tenant.reg;
  const skipped = tenant.skipped.initiatives + tenant.skipped.rules + tenant.skipped.people;
  if (skipped) ctx.log(`stage0: tenant entries skipped as malformed — initiatives ${tenant.skipped.initiatives}, rules ${tenant.skipped.rules}, people ${tenant.skipped.people}`);
  const floorTenant = new Map<string, FloorTenant>();
  const ft = (day: string): FloorTenant => {
    const key = rulesMode === 'all' ? '' : day;
    let f = floorTenant.get(key);
    if (!f) {
      f = { reg, rules: tenant.rulesFor(day, rulesMode), markers: tenant.markers, subject: tenant.subject, admin: tenant.admin, nameOf: (p) => R.person(p)?.name ?? p, companyOf: (p) => R.person(p)?.company ?? null };
      floorTenant.set(key, f);
    }
    return f;
  };
  const calibrated = (d: Decision): Decision => {
    if (!d.label) return d;
    const conf = calib.mean(d.rung, d.prior);
    return conf === d.conf ? d : { ...d, conf };
  };
  const said = new Map<string, Said>();

  // --- fragments ------------------------------------------------------------------------------------------------------

  const calls = new Map<string, CallInfo>();
  const callInfo = (u: FragmentUnit): CallInfo => {
    const key = u.refs.find((r) => r.startsWith('meeting:')) ?? u.id.replace(/#\d+$/, '');
    const hit = calls.get(key);
    if (hit) return hit;
    const m = links.meeting(key);
    const copies: MeetingCopy[] = m ? links.copies(m.callId) : [];
    const persons = new Set<string>(u.participants);
    for (const c of copies) {
      const ev = links.linkedEvent(c);
      const cover = [...(ev?.attendees ?? []), ...(ev?.organizer ? [ev.organizer] : []), ...c.speakers];
      for (const a of c.attendees) for (const p of R.attendee(a, cover)) persons.add(p);
      if (ev) for (const a of [...ev.attendees, ev.organizer]) for (const p of R.attendee(a)) persons.add(p);
      for (const s of c.speakers) {
        const p = R.resolve(s);
        if (p) persons.add(p);
      }
    }
    // A greeting run attached to the call (fragment.ts settleLowSubstance): whom it was addressed to was at the call.
    for (const p of links.recipients(u.refs.filter((r) => !r.startsWith('meeting:')))) persons.add(p);
    const info: CallInfo = { callId: m?.callId ?? null, copyKey: m ? key : null, meetingTitle: m?.title ?? u.title.split(' — ')[0]!, participants: [...persons] };
    calls.set(key, info);
    return info;
  };

  const participantsOf = (u: FragmentUnit): string[] => {
    if (u.kind === 'call') return callInfo(u).participants;
    if (u.kind === 'work') return u.participants;
    const forms = containerForms(u.container).map((f) => R.resolve(f)).filter((p): p is string => !!p);
    return uniq([...u.participants, ...links.recipients(u.refs), ...forms]);
  };

  const baseFrag = new Map<string, Decision>();
  const baseFragment = (u: FragmentUnit): Decision => {
    const hit = baseFrag.get(u.id);
    if (hit) return hit;
    const info = u.kind === 'call' ? callInfo(u) : null;
    const d = calibrated(
      fragmentFloor(
        {
          kind: u.kind,
          title: u.title,
          meetingTitle: info?.meetingTitle ?? u.title,
          source: u.source,
          container: u.container,
          channelId: u.kind === 'thread' ? channelIdOf(u.refs[0]) : null,
          repo: u.kind === 'work' ? (u.repo ?? u.container) : null,
          participants: participantsOf(u),
          keys: u.kind === 'work' ? uniq([...u.projectKeys, ...keyPrefixes(u.title, u.text)]) : u.projectKeys,
          adminText: u.kind === 'thread' ? u.text : u.kind === 'call' ? u.title : '',
        },
        ft(u.day),
      ),
    );
    baseFrag.set(u.id, d);
    return d;
  };

  // Rung 0 (F3): the other recorder copies of the same call — a copy whose topic has the same heading, or a copy that was
  // not cut into topics at all (one whole-call fragment twins every topic of the other).
  const twinsOf = (u: FragmentUnit, pool: readonly FragmentUnit[]): FragmentUnit[] => {
    if (u.kind !== 'call') return [];
    const me = callInfo(u);
    if (!me.callId) return [];
    const heading = topicOf(u.title);
    return pool.filter((x) => {
      if (x.kind !== 'call' || x.id === u.id) return false;
      const other = callInfo(x);
      if (other.callId !== me.callId || other.copyKey === me.copyKey) return false;
      return !x.id.includes('#') || !u.id.includes('#') || topicOf(x.title) === heading;
    });
  };

  const coworkOf = (u: FragmentUnit, pool: readonly FragmentUnit[]): string[] => {
    if (u.kind === 'work') return [];
    const t0 = Date.parse(u.start) - COWORK_MS;
    const t1 = Date.parse(u.end) + COWORK_MS;
    return uniq(
      pool
        .filter((x) => x.kind === 'work' && Date.parse(x.start) <= t1 && Date.parse(x.end) >= t0)
        .map(baseFragment)
        .filter((d) => d.label && d.conf >= 0.97)
        .map((d) => d.label!),
    );
  };

  const fragmentCase = (u: FragmentUnit): string => {
    if (u.kind === 'call') {
      const id = callInfo(u).callId;
      return id ? (id.startsWith('call:') ? id : `call:${id}`) : `call:${u.id.replace(/#\d+$/, '')}`;
    }
    if (u.kind === 'thread') return `run:${u.container ?? ''}:${u.day}`;
    return `work:${u.repo ?? u.container ?? ''}:${u.day}`;
  };

  const fragMemo = new Map<string, FragOut>();
  const fragment = (u: FragmentUnit, pool: FragmentUnit[]): FragOut => {
    const hit = fragMemo.get(u.id);
    if (hit) return hit;
    let d = baseFragment(u);
    const twins = twinsOf(u, pool ?? []).map(baseFragment).filter((x) => x.label);
    if (twins.length) {
      const labels = uniq(twins.map((x) => x.label!));
      const best = twins.reduce((a, b) => (b.conf > a.conf ? b : a));
      if (labels.length === 1 && (!d.label || best.conf > d.conf)) d = { ...best, candidates: uniq([...best.candidates, ...d.candidates]), hint: `twin copy: ${best.hint}` };
      else if (!d.label) d = { ...d, candidates: uniq([...d.candidates, ...labels]), hint: [d.hint, `twin copies say ${labels.join(' | ')}`].filter(Boolean).join('; ') };
    }
    const out: FragOut = {
      label: d.label,
      conf: d.label ? d.conf : 0,
      rung: d.rung,
      candidates: d.candidates,
      hint: d.hint,
      case: fragmentCase(u),
      ...(d.umbrella ? { umbrella: d.umbrella } : {}),
      ...(d.label ? { prior: d.prior } : {}),
      participants: participantsOf(u),
      cowork: coworkOf(u, pool ?? []),
    };
    said.set(u.id, { instance: d.rung, label: d.label });
    fragMemo.set(u.id, out);
    return out;
  };

  // --- items ----------------------------------------------------------------------------------------------------------

  const subjectDomains = new Set(
    (tenant.subject ? (R.person(tenant.subject)?.identities ?? []) : [])
      .map((i) => parseSender(i).domain)
      .filter(Boolean),
  );
  const domainsOf = (u: ItemUnit): string[] => {
    if (!isMailItem(u.source, u.container)) return [];
    const own = parseSender(u.author ?? '').domain;
    const ds = u.fromSubject ? u.participants.map((p) => parseSender(p).domain) : [own];
    return uniq(ds.filter((d) => d && !FREE_MAIL.has(d) && !subjectDomains.has(d)));
  };
  const ownKeyOf = (u: ItemUnit): string | null => {
    if (u.type !== 'task' && u.type !== 'comment') return null;
    for (const k of u.keys) {
      const m = OWN_KEY.exec(k);
      if (m) return m[1]!;
    }
    return u.container && PROJECT.test(u.container) ? u.container : null;
  };
  const itemCase = (u: ItemUnit, sender: SenderClass, family: string): string => {
    if (u.type === 'task' || u.type === 'comment') return `ticket:${u.id.replace(/#c[^#]*$/, '')}`;
    if (u.type === 'meeting') return u.thread?.startsWith('call:') ? u.thread : `call:${u.thread ?? u.id}`;
    if (sender === 'bot' || sender === 'bulk') return `family:${family}:${u.day}`;
    return `thread:${u.thread ?? u.id}`;
  };

  const roots = new Map<string, Decision | null>(); // thread → the decision of its first item (null: it decided nothing)
  const itemMemo = new Map<string, ItemOut>();
  const computeItem = (u: ItemUnit): ItemOut => {
    const hit = itemMemo.get(u.id);
    if (hit) return hit;
    const senderClass = rest.senderClass(u);
    const family = rest.family(u);
    const { hosts, apps } = rest.hostsApps(u);
    const first = !!u.thread && !roots.has(u.thread);
    const root = u.thread && !first ? (roots.get(u.thread) ?? null) : null;
    const d = calibrated(
      itemFloor(
        {
          type: u.type,
          source: u.source,
          container: u.container,
          channelId: channelIdOf(u.id),
          sender: senderClass,
          ownKey: ownKeyOf(u),
          keys: keyPrefixes(...u.keys, u.subject, u.text),
          hosts,
          apps,
          // production left the author unresolved: the one folded resolver (address, then name as identity) may know them
          persons: uniq([u.authorPerson ?? (u.isBot ? null : R.resolve(u.author)), ...u.toPersons].filter((p): p is string => !!p)),
          title: u.subject ?? '',
          domains: domainsOf(u),
          root,
        },
        ft(u.day),
      ),
    );
    if (first) roots.set(u.thread!, d.label ? d : null);
    const out: ItemOut = {
      label: d.label,
      conf: d.label ? d.conf : 0,
      rung: d.rung,
      candidates: d.candidates,
      hint: d.hint,
      case: itemCase(u, senderClass, family),
      ...(d.umbrella ? { umbrella: d.umbrella } : {}),
      ...(d.label ? { prior: d.prior } : {}),
      senderClass,
      family,
      hosts,
      apps,
    };
    said.set(u.id, { instance: d.rung, label: d.label });
    itemMemo.set(u.id, out);
    return out;
  };
  // A day's items are decided in time order, so a reply finds its root decided (roots persist across days).
  const prepared = new Set<string>();
  const item = (u: ItemUnit, pool: ItemUnit[]): ItemOut => {
    const hit = itemMemo.get(u.id);
    if (hit) return hit;
    const list = pool?.length ? pool : [u];
    const key = `${list[0]!.day}\u0000${list.length}`;
    if (!prepared.has(key)) {
      prepared.add(key);
      for (const x of [...list].sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0) || a.id.localeCompare(b.id))) computeItem(x);
    }
    return computeItem(u);
  };

  // --- the closed list and the cards ----------------------------------------------------------------------------------

  const t1Space = (): string[] => {
    const ids = reg.list.length ? [...reg.labelIds(), ...Object.values(tenant.admin), ...tenant.personal] : [...(meta.labelSpace?.initiatives ?? [])];
    return uniq(ids.filter((x) => x !== NONE && x !== UNREGISTERED));
  };
  const peopleIds = (): string[] => (tenant.people.length ? tenant.people.map((p) => p.person_id) : [...(meta.labelSpace?.people ?? [])]);
  const labelSpace = (task: TaskId): string[] => {
    if (task === 't1-fragment' || task === 't1-item') return [...t1Space(), NONE, UNREGISTERED];
    if (task === 't4-kind') return [...KINDS];
    if (task === 't3-identity') return [...peopleIds(), SYSTEM, UNKNOWN];
    if (task === 't4-addressee') return [...peopleIds(), NONE];
    return [];
  };

  const cards = (): RegistryCard[] => {
    const adminBuckets = new Set(Object.values(tenant.admin));
    return t1Space().map((id) => {
      const ini = reg.get(id);
      // An alias's (or a split's) cues describe the initiative it resolves to.
      const sources = [...(ini ? [ini] : []), ...reg.list.filter((i) => (i.aliasOf || i.splitInto) && i.id !== id && reg.labels(i.id).includes(id))];
      const company = ini?.company ? reg.companies.find((c) => c.id === ini.company) : undefined;
      const cues = uniq([
        ...sources.flatMap((s) => s.titles),
        ...sources.flatMap((s) => s.channels.map((c) => (c.name ? `#${c.name}` : c.id!))),
        ...sources.flatMap((s) => s.keys.map((k) => `${k}-`)),
        ...sources.flatMap((s) => [...s.repos, ...s.paths].map((r) => r.replace(/\.git$/, '').replace(/\/+$/, '').split('/').pop()!).filter(Boolean)),
        ...sources.flatMap((s) => [...s.hosts, ...s.apps]),
        ...(company ? [company.name] : ini?.company ? [ini.company] : []),
      ]);
      // Marker people: exclusive first, then narrow; a broad person is a hint at most and would sit on every card.
      const rank = { exclusive: 0, narrow: 1, broad: 2 } as const;
      const people = tenant.people
        .map((p) => ({ p, m: tenant.markers.get(p.person_id) }))
        .filter((x) => x.m && x.m.type !== 'broad' && x.m.initiatives.includes(id))
        .sort((a, b) => rank[a.m!.type] - rank[b.m!.type])
        .map((x) => x.p.name);
      const umbrella = reg.umbrellaOf(id) ?? Object.entries(tenant.admin).find(([, b]) => b === id)?.[0] ?? meta.labelSpace?.umbrellas?.[id] ?? id.split('/')[0]!;
      const name = ini?.name ?? (adminBuckets.has(id) ? `${umbrella} admin (invoices, contracts, payments, visas, taxes)` : id);
      return { id, umbrella, name, done: ini?.done ?? false, ...(ini?.code ? { code: ini.code } : {}), cues, people };
    });
  };

  return {
    fragment,
    item,
    mention: (u) => rest.mention(u),
    kind: (u) => rest.kind(u),
    addressee: (u) => rest.addressee(u),
    dedup: (dayUnits) => rest.dedup(dayUnits),
    labelSpace,
    cards,
    calibrate(rows, decided) {
      calib.update(rows, (id) => said.get(id), decided);
    },
    said: (id) => said.get(id),
    instances: () => calib.all(),
  };
}
