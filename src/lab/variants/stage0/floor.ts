// Stage 0 — the deterministic attribution ladders, pure (design notes/10-design.md §2.1 F1–F3, F6, F7, F12; §2.2). The
// production ladder (src/sources/attribution/ladder.ts) is not modified: this is the bench copy with the fix pack, so the
// fixes can be measured before they are ported. Facts in (resolved participants, keys, the registry, the rules), one
// Decision out: the first rung that decides wins, with a GRADED confidence (F12) — a single title hit is not a repo
// route, and an operating point must be able to drop the weak rung instead of all of them.
//
// T1-fragment                                              conf   T1-item                                       conf
//   0 duplicate topic of one call inherits (index.ts)      twin    1 the ticket's own key prefix → registry      .98
//   1 tenant rule (`candidates` narrows what follows)      .97     2 reply inherits a decided thread root   root×.99
//   2 exclusive markers, all agreeing                      .95     3 bot: host/app token → registry              .95
//   3a work: repo/path exact                               .99     3' unknown host, closed channel → unregistered .80
//   3b channel, unique (id first, then name)               .95     4 keys in the text, unique                    .95
//   3c tracker key, unique (work: keys in commit text)     .97     5 rule: project_key .97 / container .95 (.85 bot)
//   3d call title, single hit (≤5 chars whole-word)        .80     6 registry channel .95 human / .85 bot
//   4 admin lexicon (whole words), one bucket              .75     7 mail domain → company → umbrella prior + cand.
//   5 narrow markers (broad people no longer block)        cand.   8 author/addressee markers: exclusive .90; narrow cand.
//   6 broad markers + registry candidates                  hint
// One item rung the design's table lacks: 2' one-way bulk mail → `none` (.90, a guess below τ) — no other rung can say
// `none`, which is a third of a mailbox's items.
// The rung string IS the rung instance the calibration counts on (§2.5): rule:<id>, excl:<person>, repo:<org/repo>,
// path:<prefix>, channel:<id|name>, key:<PREFIX>, title:<pattern>, admin, host:<h>, app:<a>, closed:<channel>, sender:bulk.
// Admin (F1) runs AFTER exclusive markers and the registry and matches whole words: `vat` no longer fires on "private",
// `tax` on "syntax", `visa` on "advisable", `договор` on "договорились", `чек` on "чеклист", `Steuer` on "Steuerung".

import type { FragmentDraft } from '../../../sources/attribution/fragment.js';
import { ruleMatches } from '../../../sources/attribution/ladder.js';
import type { Reg } from './registry.js';
import type { Marker, Rule } from './tenant.js';

export type SenderClass = 'human' | 'bot' | 'bulk' | 'system';

/** The graded rung confidences (§2.2) — the calibration's priors. */
export const CONF = {
  rule: 0.97,
  excl: 0.95,
  repo: 0.99,
  channel: 0.95,
  key: 0.97,
  title: 0.8,
  admin: 0.75,
  item: { ownKey: 0.98, reply: 0.99, bulk: 0.9, host: 0.95, closed: 0.8, textKey: 0.95, ruleKey: 0.97, ruleContainer: 0.95, ruleContainerBot: 0.85, channel: 0.95, channelBot: 0.85, excl: 0.9 },
} as const;

export interface Decision {
  label: string | null;
  conf: number; // 0 when label is null
  prior: number; // the rung's graded confidence before calibration (0 when nothing decided)
  rung: string; // the rung instance ('abstain' when nothing decided)
  candidates: string[];
  hint: string;
  umbrella?: string;
}

export interface FloorTenant {
  reg: Reg;
  rules: readonly Rule[];
  markers: ReadonlyMap<string, Marker>;
  subject: string | null;
  admin: Readonly<Record<string, string>>; // umbrella → admin bucket (label id)
  nameOf?: (pid: string) => string;
  companyOf?: (pid: string) => string | null; // person → company id (an umbrella when the registry knows the company)
}

// --- F1: the admin lexicon -------------------------------------------------------------------------------------------

// Whole words only. `x*` = the stem with any ending; anything else is the exact word (inflections listed where a free
// ending would catch another word: договор|договорились, чек|чеклист, Steuer|Steuerung, виза|визит).
const ADMIN_WORDS = [
  // en
  'invoic*', 'payment*', 'paid', 'payout*', 'pay out', 'wire transfer*', 'bank transfer*', 'iban', 'swift code', 'deel', 'kyc', 'contract', 'contracts',
  'contractual', 'agreement*', 'nda', 'ndas', 'sow', 'retainer fee*', 'visa', 'visas', 'residence permit*', 'tax', 'taxes', 'taxation', 'vat', 'receipt*',
  'reimburs*', 'purchase order*',
  // de
  'rechnung*', 'zahlung*', 'überweisung*', 'vertrag', 'vertrags*', 'verträge*', 'steuer', 'steuern', 'steuerberat*', 'steuererklärung*', 'quittung*',
  'aufenthaltstitel*', 'aufenthaltserlaubnis*', 'aufenthaltsgenehmigung*', 'mehrwertsteuer*', 'mwst',
  // ru
  'сч[её]т', 'сч[её]та', 'сч[её]ту', 'сч[её]том', 'сч[её]те', 'сч[её]ты', 'сч[её]тов', 'сч[её]т-фактур*', 'оплат*', 'оплач*', 'плат[её]ж*',
  'перевод денег', 'договор', 'договора', 'договору', 'договором', 'договоре', 'договоры', 'договоров', 'контракт*', 'виза', 'визы', 'визу', 'визой',
  'визе', 'налог*', 'инвойс*', 'чек', 'чека', 'чеки', 'чеком', 'чеков', 'квитанци*', 'ндс',
  // it
  'fattur*', 'pagament*', 'contratt*', 'bonifico', 'bonifici', 'ricevut*', 'iva',
];

const LETTER = '[\\p{L}\\p{M}\\p{N}]';
const ADMIN_RE = new RegExp(
  `(?<!${LETTER})(?:${ADMIN_WORDS.map((w) => (w.endsWith('*') ? `${w.slice(0, -1)}${LETTER}*` : w).replace(/ /g, '\\s+')).join('|')})(?!${LETTER})`,
  'iu',
);

/** The admin word a text holds (whole words, any case, EN/DE/RU/IT), or null. */
export function adminWord(text: string | null | undefined): string | null {
  const m = ADMIN_RE.exec((text ?? '').normalize('NFC'));
  return m ? m[0] : null;
}

// --- helpers ----------------------------------------------------------------------------------------------------------

const uniq = <T>(xs: readonly T[]): T[] => [...new Set(xs)];
const NOTHING: Decision = { label: null, conf: 0, prior: 0, rung: 'abstain', candidates: [], hint: '' };

/** Tracker key prefixes in texts (`VN-12` → `VN`) — the production fragmenter's KEY_RE. */
export function keyPrefixes(...texts: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const t of texts) for (const m of (t ?? '').matchAll(/\b([A-Z][A-Z0-9]{1,9})-\d+\b/g)) out.add(m[1]!);
  return [...out];
}

class Ladder {
  private restrict: string[] | null = null;
  readonly cands = new Set<string>();
  readonly hints: string[] = [];
  constructor(private readonly reg: Reg) {}

  narrow(ids: string[], why: string): void {
    this.restrict = uniq(ids.flatMap((i) => this.reg.labels(i)));
    this.hints.push(why);
  }

  get narrowed(): string[] | null {
    return this.restrict;
  }

  add(ids: readonly string[]): void {
    for (const i of ids) for (const l of this.reg.labels(i)) this.cands.add(l);
  }

  /** A decision for `id` — or null when a candidates rule narrowed the choice and `id` is outside it. */
  decide(id: string, conf: number, rung: string, why: string): Decision | null {
    const labels = this.reg.labels(id);
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
    return { label, conf, prior: conf, rung, candidates: labels, hint: why, ...(this.reg.umbrellaOf(label) ? { umbrella: this.reg.umbrellaOf(label)! } : {}) };
  }

  /** Nothing decided: the candidates (inside the rule's set when a rule narrowed it) and the hints. */
  open(extra: string[] = [], umbrella?: string | null): Decision {
    let cands = uniq([...this.cands, ...extra]);
    if (this.restrict) {
      const inside = cands.filter((c) => this.restrict!.includes(c));
      cands = inside.length ? inside : this.restrict;
    }
    return { ...NOTHING, candidates: cands, hint: this.hints.join('; ') || 'no signals', ...(umbrella ? { umbrella } : {}) };
  }
}

function marked(persons: readonly string[], t: FloorTenant): { pid: string; m: Marker }[] {
  return uniq(persons)
    .filter((p) => p && p !== t.subject)
    .map((pid) => ({ pid, m: t.markers.get(pid)! }))
    .filter((x) => !!x.m && x.m.initiatives.length > 0);
}

const nameOf = (t: FloorTenant, pid: string): string => t.nameOf?.(pid) ?? pid;

// --- T1-fragment ------------------------------------------------------------------------------------------------------

export interface FragFacts {
  kind: 'call' | 'thread' | 'work';
  title: string; // the fragment's title (a call topic: "<meeting> — <heading>")
  meetingTitle: string; // calls: the meeting's own title — what calendar patterns route
  source: string;
  container: string | null;
  channelId: string | null;
  repo: string | null;
  participants: string[]; // resolved person ids (F4/F5)
  keys: string[]; // tracker key prefixes (work: from the commit text too — F6)
  adminText: string; // threads: the run's text; calls: the fragment title
}

export function fragmentFloor(f: FragFacts, t: FloorTenant): Decision {
  const reg = t.reg;
  const L = new Ladder(reg);
  const people = marked(f.participants, t);

  // 1. tenant rules — the first matching rule decides, or narrows every rung below to its candidates
  const draft: FragmentDraft = { id: '', kind: f.kind, start: '', end: '', refs: [], title: f.title, source: f.source, container: f.container, participants: f.participants, projectKeys: f.keys, repo: f.repo, weight: 1 };
  for (const r of t.rules) {
    if (!ruleMatches(r, draft)) continue;
    if (r.then?.initiative) {
      const d = L.decide(r.then.initiative, CONF.rule, `rule:${r.id}`, `rule ${r.id}`);
      if (d) return d;
      break;
    }
    if (r.then?.candidates?.length) {
      L.narrow(r.then.candidates, `rule ${r.id}: one of ${r.then.candidates.join(' | ')}`);
      break;
    }
  }

  // 2. exclusive markers: every exclusive participant must point at the same initiative
  const excl = people.filter((x) => x.m.type === 'exclusive');
  if (excl.length) {
    const set = uniq(excl.flatMap((x) => x.m.initiatives));
    if (set.length === 1) {
      const d = L.decide(set[0]!, CONF.excl, `excl:${excl[0]!.pid}`, `${nameOf(t, excl[0]!.pid)} is exclusive to ${set[0]}`);
      if (d) return d;
    } else {
      L.add(set);
      L.hints.push(`exclusive people disagree: ${set.join(' | ')}`);
    }
  }

  // 3a. work: repo, else the longest local path — exact routes
  if (f.kind === 'work' && f.repo) {
    const byRepo = reg.routeRepo(f.repo);
    const route = byRepo.hits.length ? { ...byRepo, kind: 'repo' } : { ...reg.routePath(f.repo), kind: 'path' };
    if (route.hits.length === 1) {
      const d = L.decide(route.hits[0]!, CONF.repo, `${route.kind}:${route.via}`, `${route.kind} ${route.via}`);
      if (d) return d;
    } else if (route.hits.length > 1) {
      L.add(route.hits);
      L.hints.push(`${route.kind} ${route.via} matches several`);
    }
  }

  // 3b. channel: by id, then by name; a channel two initiatives list gives candidates (F6)
  if (f.container) {
    const ch = reg.routeChannel(f.container, f.channelId);
    if (ch.hits.length === 1) {
      const d = L.decide(ch.hits[0]!, CONF.channel, `channel:${ch.via}`, `channel ${f.container}`);
      if (d) return d;
    } else if (ch.hits.length > 1) {
      L.add(ch.hits);
      L.hints.push(`channel ${f.container} is shared by ${ch.hits.length} initiatives`);
    }
  }

  // 3c. tracker keys
  if (f.keys.length) {
    const k = reg.routeKeys(f.keys);
    if (k.hits.length === 1) {
      const d = L.decide(k.hits[0]!, CONF.key, `key:${k.via}`, `key ${f.keys.join(',')}`);
      if (d) return d;
    } else if (k.hits.length > 1) {
      L.add(k.hits);
      L.hints.push(`keys ${f.keys.join(',')} match several`);
    }
  }

  // 3d. call title: one initiative's pattern (≤5 chars: whole word) is a guess (.80), several are candidates (F2)
  if (f.kind === 'call') {
    const tt = reg.routeTitle(f.meetingTitle);
    if (tt.hits.length === 1) {
      const d = L.decide(tt.hits[0]!, CONF.title, `title:${tt.via}`, `title "${tt.via}"`);
      if (d) return d;
    } else if (tt.hits.length > 1) {
      L.add(tt.hits);
      L.hints.push(`title matches ${tt.hits.length} initiatives`);
    }
  }

  // 4. admin chatter (F1): whole words, after the registry; the bucket of the counterparts' umbrella
  const word = Object.keys(t.admin).length ? adminWord(f.adminText) : null;
  if (word) {
    const umbrellas = uniq([
      ...people.flatMap((x) => x.m.initiatives).map((i) => reg.umbrellaOf(i)),
      ...uniq(f.participants.filter((p) => p && p !== t.subject)).map((p) => {
        const c = t.companyOf?.(p);
        return c ? (reg.companies.find((x) => x.id === c)?.umbrella ?? null) : null;
      }),
    ]).filter((u): u is string => !!u);
    const buckets = uniq(umbrellas.map((u) => t.admin[u]).filter((x): x is string => !!x));
    if (buckets.length === 1) {
      const d = L.decide(buckets[0]!, CONF.admin, 'admin', `admin "${word}"`);
      if (d) return d;
    } else if (buckets.length > 1) {
      L.add(buckets);
      L.hints.push(`admin "${word}", umbrella unclear`);
    }
  }

  // 5. narrow markers — candidates only; broad people no longer switch this rung off (F7)
  const narrow = people.filter((x) => x.m.type === 'narrow');
  if (narrow.length) {
    const set = uniq(narrow.flatMap((x) => x.m.initiatives));
    const reg_ = [...L.cands];
    const inside = reg_.length ? set.filter((c) => reg_.includes(c)) : [];
    L.hints.push(`narrow via ${narrow.map((x) => x.pid).join(', ')}`);
    if (inside.length) {
      L.cands.clear();
      L.add(inside);
      return L.open();
    }
    return L.open(set);
  }

  // 6. broad markers: a hint, and their initiatives join the registry's candidates
  const broad = people.filter((x) => x.m.type === 'broad');
  if (broad.length) L.hints.push(`broad via ${broad.map((x) => x.pid).join(', ')}`);
  return L.open(uniq(broad.flatMap((x) => x.m.initiatives)));
}

// --- T1-item ----------------------------------------------------------------------------------------------------------

export interface ItemFacts {
  type: 'message' | 'thread' | 'task' | 'comment' | 'meeting' | 'event';
  source: string;
  container: string | null;
  channelId: string | null;
  sender: SenderClass;
  ownKey: string | null; // a ticket's/comment's own key prefix
  keys: string[]; // key prefixes found in the text, subject and links
  hosts: string[];
  apps: string[];
  persons: string[]; // the author and the addressees, resolved
  title: string; // the subject line (rules' title_re)
  domains: string[]; // counterpart mail domains
  root: Decision | null; // the decided root of the item's thread, when it is a reply
}

export function itemFloor(f: ItemFacts, t: FloorTenant): Decision {
  const reg = t.reg;
  const L = new Ladder(reg);
  const machine = f.sender !== 'human';

  // 1. a ticket's own key prefix
  if (f.ownKey) {
    const k = reg.routeKeys([f.ownKey]);
    if (k.hits.length === 1) {
      const d = L.decide(k.hits[0]!, CONF.item.ownKey, `key:${k.via}`, `ticket ${f.ownKey}`);
      if (d) return d;
    } else if (k.hits.length > 1) L.add(k.hits);
  }

  // 2. a reply inherits its thread's decided root
  if (f.root?.label) return { ...f.root, conf: f.root.conf * CONF.item.reply, prior: f.root.prior * CONF.item.reply, hint: `reply: ${f.root.hint}` };

  // 2'. one-way bulk mail (newsletters, campaigns) is nothing to attribute — not in the design's table, which has no rung
  //     that can say `none`; a guess below τ (.90) until answers and audits calibrate it
  if (f.sender === 'bulk') return { label: 'none', conf: CONF.item.bulk, prior: CONF.item.bulk, rung: 'sender:bulk', candidates: [], hint: 'one-way bulk mail' };

  // 3. bot items: host/app tokens → registry hosts/apps; an unknown token in a channel whose host list is closed → unregistered
  if (machine && (f.hosts.length || f.apps.length)) {
    const routes = [...f.hosts.map((h) => ({ ...reg.routeHost(h), kind: 'host' })), ...f.apps.map((a) => ({ ...reg.routeApp(a), kind: 'app' }))].filter((r) => r.hits.length);
    const ids = uniq(routes.flatMap((r) => r.hits));
    if (ids.length === 1) {
      const d = L.decide(ids[0]!, CONF.item.host, `${routes[0]!.kind}:${routes[0]!.via}`, `${routes[0]!.kind} ${routes[0]!.via}`);
      if (d) return d;
    } else if (ids.length > 1) L.add(ids);
    else if (reg.closedChannel(f.container, f.channelId)) {
      const via = f.channelId ?? f.container ?? '';
      return { label: 'unregistered', conf: CONF.item.closed, prior: CONF.item.closed, rung: `closed:${via}`, candidates: [], hint: `unknown ${f.hosts[0] ?? f.apps[0]} in ${f.container}` };
    }
  }

  // 4. tracker keys in the text
  if (f.keys.length) {
    const k = reg.routeKeys(f.keys);
    if (k.hits.length === 1) {
      const d = L.decide(k.hits[0]!, CONF.item.textKey, `key:${k.via}`, `key ${f.keys.join(',')}`);
      if (d) return d;
    } else if (k.hits.length > 1) {
      L.add(k.hits);
      L.hints.push(`keys ${f.keys.join(',')} match several`);
    }
  }

  // 5. tenant rules: project_key .97; container .95 — .85 for bot items (shared bot channels carry mixed traffic)
  const draft: FragmentDraft = { id: '', kind: 'thread', start: '', end: '', refs: [], title: f.title, source: f.source, container: f.container, participants: f.persons, projectKeys: uniq([...(f.ownKey ? [f.ownKey] : []), ...f.keys]), repo: null, weight: 1 };
  for (const r of t.rules) {
    if (!ruleMatches(r, draft)) continue;
    if (r.then?.initiative) {
      const conf = r.when?.container ? (machine ? CONF.item.ruleContainerBot : CONF.item.ruleContainer) : CONF.item.ruleKey;
      const d = L.decide(r.then.initiative, conf, `rule:${r.id}`, `rule ${r.id}`);
      if (d) return d;
      break;
    }
    if (r.then?.candidates?.length) {
      L.narrow(r.then.candidates, `rule ${r.id}: one of ${r.then.candidates.join(' | ')}`);
      break;
    }
  }

  // 6. registry channel
  if (f.container) {
    const ch = reg.routeChannel(f.container, f.channelId);
    if (ch.hits.length === 1) {
      const d = L.decide(ch.hits[0]!, machine ? CONF.item.channelBot : CONF.item.channel, `channel:${ch.via}`, `channel ${f.container}`);
      if (d) return d;
    } else if (ch.hits.length > 1) {
      L.add(ch.hits);
      L.hints.push(`channel ${f.container} is shared by ${ch.hits.length} initiatives`);
    }
  }

  // 7. mail: the counterpart's domain → its company → that umbrella (a prior, never a decision)
  let umbrella: string | null = null;
  for (const dom of f.domains) {
    const c = reg.companyOfDomain(dom);
    if (!c) continue;
    umbrella = c.umbrella;
    L.add(reg.initiativesOfCompany(c.id, c.umbrella));
    L.hints.push(`domain ${dom} → ${c.id}`);
    break;
  }

  // 8. markers of the author and the addressees: exclusive decides (.90), narrow narrows
  const people = marked(f.persons, t);
  const excl = people.filter((x) => x.m.type === 'exclusive');
  if (excl.length) {
    const set = uniq(excl.flatMap((x) => x.m.initiatives));
    if (set.length === 1) {
      const d = L.decide(set[0]!, CONF.item.excl, `excl:${excl[0]!.pid}`, `${nameOf(t, excl[0]!.pid)} is exclusive to ${set[0]}`);
      if (d) return d;
    } else L.add(set);
  }
  const narrow = people.filter((x) => x.m.type === 'narrow');
  if (narrow.length) {
    L.hints.push(`narrow via ${narrow.map((x) => x.pid).join(', ')}`);
    return L.open(uniq(narrow.flatMap((x) => x.m.initiatives)), umbrella);
  }
  return L.open([], umbrella);
}
