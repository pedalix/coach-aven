// The learning loop of the attribution layer, pure: from the floor's decisions and what people answered, what the loop
// WOULD decide, what it asks, and which auto-decisions it re-checks — re-derived from scratch on every build (design notes
// 10 §2.5, §3, §8, §9; notes/20-iter2.md K2a). Answers are tenant-ledger data; nothing is learned anywhere else, and
// deleting the store and rebuilding reproduces the same result. Ported from the lab bench's concept K "Earned Keys"
// (src/lab/variants/keys*), its stage-0 rung calibration and iteration 2's "trust repair" — the logic, not the code.
//
//   evidence   ONLY `Evidence` rows: a person's answers and audits, and the tenant's seed rows. Never the floor's decisions,
//              never this loop's own — on the bench, counting machine rows took weekly precision from 100% to 81%. One
//              answer id is one observation however many units it covered; one unit keeps its latest row (a correction
//              supersedes).
//   replay     the evidence is replayed in day order, as the bench's nightly pass did: on an answer's day the loop decides
//              the unit with what it knew the day before, and every key and rung instance that predicted it gets a trial
//              (learn-keys.ts) or a calibration count (learn-calib.ts). Then the answer joins the key tables.
//   decide     per unit: the floor's label at its rung instance's calibrated confidence (a demoted instance's units fall
//              below τ: questions with its label as the guess); then sibling-aware trust for structural rungs
//              (learn-trust.ts: the client is decided, the initiative only with a cue of its own or answers behind it);
//              then the unit's consistent keys (learn-keys.ts decideUnit). A unit a person answered shows what the loop
//              said BEFORE that answer — the honest "agrees with your answers" check — with `answered` beside it.
//   ask        today's open units, grouped per client-day / best key / case, valued and ranked (learn-ask.ts) — a
//              structural unit's yield counts its route's reach too (its answer calibrates the whole route); a seeded
//              audit sample of today's auto-decided units.
//
// Shadow only (attribution.json `learn.mode`): L2 stores and shows this; the plan, the pins and the timelog never read it.
// No model, no clock (today comes in), no I/O.

import { auditSample, auditSize, groupQuestions, reachOf, type QuestionUnit } from './learn-ask.js';
import { Calibration, posterior, PRIOR_STRENGTH, type Verdict } from './learn-calib.js';
import { decideUnit, isActive, isKeyType, KEY_TYPES, keyId, Learner, newPool, notePool, typeOf, type FloorView, type KeyDecision, type KeyType, type PoolStats } from './learn-keys.js';
import { Siblings, siblingTrust, triggerNorms } from './learn-trust.js';

export interface LearnUnit {
  id: string;
  unit: 'fragment' | 'item';
  day: string; // local day
  label: string | null; // the floor's decision …
  conf: number; // … its graded confidence (0 = open) …
  rung: string; // … and its rung INSTANCE ('rule:<id>', 'key:<prefix>', 'channel:<c>', 'title:<p>', 'admin', 'excl:<person>', 'repo:<r>', 'host:<h>', 'app:<a>', …)
  structural: boolean; // the rung maps a key/channel/container/marker/title/host to ONE initiative (sibling-aware trust applies)
  candidates: string[];
  caseKey: string;
  minutes?: number;
  // key type → value (thread, family, host, app, subject, container, domain, sender, series, run, cpset, token, cowork, form).
  // Several values of one type: suffix the name (`token#1`, `token#2`) — the type is the name up to '#'.
  keys: Record<string, string>;
  text?: string; // title + text, only for sibling cue matching
  trigger?: string[]; // optional: cues the rung itself rests on that its name does not say (a rule's container/project key)
}

export interface Evidence {
  id: string; // the unit
  day: string; // the local day of the answer
  label: string;
  source: 'human' | 'seed';
  answer: string; // the answer id: rows of one answer are ONE observation
  audit?: boolean;
  guess?: string | null; // what the machine proposed before the answer (recorded, never learned from)
}

export interface InitiativeInfo {
  id: string;
  umbrella: string;
  company?: string;
  active: boolean;
  // name tokens, title patterns, channels, key prefixes, repo basenames, hosts/apps (the id's last segment split on '-' is
  // added here). Plain strings are words/phrases, `#x` a channel, a dotted name a host; typed: `key:VN`, `host:h`,
  // `channel:C0…`, `repo:org/r`, `app:a`, `title:p`.
  cues: string[];
  admin?: boolean; // an admin bucket (attribution.json `admin`); ids ending in '/admin' are taken as one anyway
}

export interface LearnOpts {
  tau: number;
  today: string;
  questionsPerDay: number;
  auditShare: number;
  seed: string;
  initiatives: InitiativeInfo[];
  siblingAware: boolean;
}

export interface Learned {
  id: string;
  label: string | null; // conf ≥ τ: what the loop would decide; below: its guess (null: nothing)
  conf: number;
  rung: string; // the floor's instance, `earned:<type>` / `guess:<type>` (keys), `cue:<instance>` (a sibling's cue)
  ask?: { group: string; value: number; guess: string | null; form: 'choose' | 'confirm' };
  audit?: boolean; // in today's audit sample
  guess?: string | null;
  why?: string;
  umbrella?: string; // structural units: the route's umbrella …
  umbrellaConf?: number; // … at its client-level calibrated confidence (≥ τ: the client is decided even if the initiative is not)
  answered?: string; // a person's label for this unit (label/conf above are then what the loop said before it)
}

export interface CalibrationRow {
  instance: string;
  a: number;
  b: number;
  mean: number;
  demoted: boolean; // it decided on its own (prior ≥ τ) and answers/audits took it below τ
  prior?: number;
  right?: number;
  wrong?: number;
  clientMean?: number;
}

export interface LearnResult {
  units: Learned[];
  calibration: CalibrationRow[];
  keyTypes: { type: string; a: number; b: number; mean: number; deciding: boolean }[];
  questions: { group: string; units: string[]; value: number; guess: string | null; form: 'choose' | 'confirm'; unit?: 'fragment' | 'item' }[];
  audits: string[]; // today's audit sample: auto-decided unit ids, seeded by (seed, today), size = floor(credit) where credit accrues questionsPerDay*auditShare per day since the first evidence day
  ruleCandidates: { key: string; label: string; support: number }[];
  stats?: { evidence: number; used: number; superseded: number; unknown: number; answers: number; trials: { success: number; failure: number } };
}

interface Decision extends KeyDecision {
  client?: string;
  umbrella?: string;
  umbrellaConf?: number;
}

const clamp = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const answerOf = (r: Evidence): string => (typeof r.answer === 'string' && r.answer ? r.answer : `${r.source}:${r.day}:${r.id}`);

export function learn(units: LearnUnit[], evidence: Evidence[], opts: LearnOpts): LearnResult {
  const tau = Number.isFinite(opts.tau) && opts.tau > 0 && opts.tau <= 1 ? opts.tau : 0.95;
  const today = opts.today;
  const byId = new Map<string, LearnUnit>();
  for (const u of units) if (u?.id && !byId.has(u.id)) byId.set(u.id, u);
  const list = [...byId.values()];
  const reg = new Siblings(opts.initiatives ?? []);
  const decides = (u: LearnUnit): boolean => typeof u.label === 'string' && !!u.label && clamp(u.conf) > 0 && !!u.rung && u.rung !== 'abstain';
  const kindOf = (u: LearnUnit): 'fragment' | 'item' => (u.unit === 'fragment' ? 'fragment' : 'item');

  // Candidate keys (an answer feeds all of them, active or not: the first call of a series is evidence for the series).
  // K2a: a structural decision also carries its rung instance as a `ctx` key — what answers on the route's units say.
  const keysOf = new Map<string, string[]>();
  for (const u of list) {
    const out = new Set<string>();
    for (const [name, raw] of Object.entries(u.keys ?? {})) {
      const type = name.split('#')[0]!.trim();
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (isKeyType(type) && type !== 'ctx' && value) out.add(keyId(type, value));
    }
    if (opts.siblingAware && u.structural && decides(u)) out.add(keyId('ctx', u.rung));
    keysOf.set(u.id, [...out].sort());
  }
  // An instance's prior is the graded confidence it decides with (a reply inherits its root's instance at × .99).
  const prior = new Map<string, number>();
  for (const u of list) if (decides(u)) prior.set(u.rung, Math.max(prior.get(u.rung) ?? 0, clamp(u.conf)));
  const reach = new Map<string, Map<string, number>>();
  for (const u of list) {
    for (const k of keysOf.get(u.id)!) {
      const log = reach.get(k) ?? new Map<string, number>();
      log.set(u.day, (log.get(u.day) ?? 0) + 1);
      reach.set(k, log);
    }
  }

  // Evidence: a person's rows and seeds only (a 'machine' row cast in is dropped), none from the future; the latest row
  // per unit wins.
  const valid = (evidence ?? []).filter(
    (r) => !!r && typeof r.id === 'string' && !!r.id && typeof r.label === 'string' && !!r.label.trim() && (r.source === 'human' || r.source === 'seed') && typeof r.day === 'string' && !!r.day && r.day <= today,
  );
  const latest = new Map<string, Evidence>();
  for (const r of valid) {
    const cur = latest.get(r.id);
    if (!cur || r.day >= cur.day) latest.set(r.id, r);
  }
  const used = [...latest.values()].filter((r) => byId.has(r.id)).sort((a, b) => a.day.localeCompare(b.day) || answerOf(a).localeCompare(answerOf(b)) || a.id.localeCompare(b.id));
  const answered = new Map(used.map((r) => [r.id, r.label]));

  const learner = new Learner();
  const calib = new Calibration();
  const pools: Record<'fragment' | 'item', PoolStats> = { fragment: newPool(), item: newPool() };
  const triggers = new Map<string, Set<string>>();
  const triggerOf = (u: LearnUnit): Set<string> => {
    let t = triggers.get(u.id);
    if (!t) triggers.set(u.id, (t = triggerNorms(u.rung, u.trigger ?? [])));
    return t;
  };

  const decide = (u: LearnUnit): Decision => {
    let keys = keysOf.get(u.id)!.filter((k) => isActive(pools[kindOf(u)], k));
    let floor: FloorView = { label: null, conf: 0, rung: u.rung || 'abstain', candidates: u.candidates ?? [] };
    const extra: Pick<Decision, 'client' | 'umbrella' | 'umbrellaConf'> = {};
    if (decides(u)) {
      const c0 = clamp(u.conf);
      const st = calib.stat(u.rung);
      let conf = st ? posterior(c0, st.right, st.wrong) : c0;
      let why = st ? `${u.rung}: ${st.right} of ${st.right + st.wrong} answers agreed` : '';
      const pI = prior.get(u.rung) ?? c0;
      const mI = calib.mean(u.rung, pI);
      if (pI >= tau && mI < tau) {
        conf = Math.min(conf, mI);
        why = `${u.rung} demoted: ${st?.right ?? 0} of ${(st?.right ?? 0) + (st?.wrong ?? 0)} answers agreed (${mI.toFixed(3)} < τ)`;
      }
      floor = { label: u.label, conf, rung: u.rung, candidates: u.candidates ?? [], ...(why ? { why } : {}) };
      const client = u.structural ? reg.client(u.label) : null;
      if (client) {
        Object.assign(extra, { client, umbrella: reg.umbrella(u.label)!, umbrellaConf: st ? posterior(c0, st.clientRight, st.clientWrong) : c0 });
        const h = opts.siblingAware ? reg.hits(u.label!, u.text, triggerOf(u)) : null;
        if (h) {
          const ctx = learner.predict(keyId('ctx', u.rung));
          const t = siblingTrust(u.label!, conf, u.rung, h, ctx && ctx.label === u.label ? ctx.n : 0);
          floor = { label: t.label, conf: t.conf, rung: t.rung, candidates: u.candidates ?? [], why: t.kept && why ? `${why}; ${t.why}` : t.why };
          // ctx speaks for the route, not for this unit: a sibling's cue in the unit's own words outranks its history.
          if (t.label !== u.label) keys = keys.filter((k) => typeOf(k) !== 'ctx');
        }
      }
    }
    return { ...decideUnit(floor, keys, learner, tau), ...extra };
  };

  // --- the replay: one evidence day at a time, decided with what the loop knew the day before ---------------------------
  const sorted = [...list].sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id));
  let next = 0;
  const advance = (day: string | null): void => {
    for (; next < sorted.length && (day === null || sorted[next]!.day <= day); next++) {
      const u = sorted[next]!;
      notePool(pools[kindOf(u)], keysOf.get(u.id)!, u.caseKey || u.id);
    }
  };
  const clientOk = (answer: string, label: string): boolean => {
    const c = reg.client(label);
    return c ? reg.client(answer) === c : answer === label;
  };
  const before = new Map<string, Decision>();
  for (let i = 0; i < used.length; ) {
    const day = used[i]!.day;
    const rows: Evidence[] = [];
    for (; i < used.length && used[i]!.day === day; i++) rows.push(used[i]!);
    advance(day);
    for (const r of rows) before.set(r.id, decide(byId.get(r.id)!));
    // Trials: one per key × answer — right only if every unit of the answer the key predicted got its label.
    const trials = new Map<string, { key: string; answer: string; ok: boolean }>();
    const verdicts: Verdict[] = [];
    for (const r of rows) {
      const u = byId.get(r.id)!;
      const answer = answerOf(r);
      for (const p of before.get(r.id)!.preds) {
        const id = `${p.key}\u0000${answer}`;
        trials.set(id, { key: p.key, answer, ok: (trials.get(id)?.ok ?? true) && r.label === p.label });
      }
      // The rung instance is charged by what PEOPLE said about its units — a seed never grades the floor.
      if (r.source === 'human' && decides(u)) verdicts.push({ instance: u.rung, answer, ok: r.label === u.label, clientOk: clientOk(r.label, u.label!) });
    }
    for (const r of rows) for (const k of keysOf.get(r.id)!) learner.observe(k, r.label, answerOf(r));
    for (const [, t] of [...trials].sort(([a], [b]) => a.localeCompare(b))) learner.trial(t.key, t.answer, t.ok);
    calib.apply(verdicts);
  }
  advance(null);

  // --- today's state ----------------------------------------------------------------------------------------------------
  const final = new Map<string, Decision>();
  for (const u of list) final.set(u.id, before.get(u.id) ?? decide(u));
  const auto = (d: Decision): boolean => d.label !== null && d.conf >= tau;

  // Questions: today's open units nobody answered yet.
  const qs: QuestionUnit[] = [];
  for (const u of list) {
    const d = final.get(u.id)!;
    if (u.day !== today || answered.has(u.id) || auto(d)) continue;
    // The answer's yield: what the unit's best learnable key would then decide — preferring types that decide after
    // their k answers alone (an answer about a .80 channel teaches a key that still cannot decide anything).
    const keys = keysOf.get(u.id)!.filter((k) => typeOf(k) !== 'ctx' && isActive(pools[kindOf(u)], k) && !KEY_TYPES[typeOf(k)].direct && !learner.contradicted(k));
    const pref = keys.filter((k) => learner.decidable(typeOf(k), tau));
    let best: { key: string; reach: number; score: number } | null = null;
    for (const k of pref.length ? pref : keys) {
      const r = reachOf(reach.get(k), today);
      const score = r * learner.h(typeOf(k));
      if (!best || score > best.score || (score === best.score && (r > best.reach || (r === best.reach && k < best.key)))) best = { key: k, reach: r, score };
    }
    // K2a: the client is decided, the initiative is not — one question per client and day; else an item asks about its
    // key, a fragment about its case (the call, the run-day: a call's topics share an initiative far more often than a
    // series or a counterpart set does — the bench's §3.4 choice).
    const group = d.client && (d.umbrellaConf ?? 0) >= tau ? `client:${d.client}:${u.day}` : u.unit === 'item' && best ? best.key : u.caseKey || `unit:${u.id}`;
    // A structural unit's answer also teaches its ROUTE (the ctx key, the instance's calibration), which speaks for every
    // unit of the route: that reach is yield too. Without it a doubted route's units (conf .85, own term .15) rank below
    // any open unit and never get answered — on bench-agency items (Q=3) key:BKR saw 2 answers in four weeks and kept
    // deciding at 58%; with it BKR and VN are demoted after 1–2 answers and frozen errors fall 21 → 7.
    const ctx = keyId('ctx', u.rung);
    const ctxYield = keysOf.get(u.id)!.includes(ctx) && !learner.contradicted(ctx) ? 0.5 * reachOf(reach.get(ctx), today) * learner.h('ctx') : 0;
    qs.push({ id: u.id, conf: d.label === null ? 0 : d.conf, weight: u.minutes && u.minutes > 0 ? u.minutes : 1, group, yield: Math.max(ctxYield, best ? 0.5 * best.reach * learner.h(typeOf(best.key)) : 0) });
  }
  const asked = groupQuestions(qs);
  const groups = new Map<string, { units: string[]; value: number; lead: Decision | null; leadId: string }>();
  for (const [id, a] of asked) {
    const g = groups.get(a.group) ?? { units: [], value: 0, lead: null, leadId: '' };
    g.units.push(id);
    g.value += a.value;
    const d = final.get(id)!;
    // One guess per group: its surest member's.
    if (d.guess && (!g.lead || d.conf > g.lead.conf || (d.conf === g.lead.conf && id < g.leadId))) Object.assign(g, { lead: d, leadId: id });
    groups.set(a.group, g);
  }
  const ranked = [...groups]
    .map(([group, g]) => ({ group, units: g.units, value: g.value, guess: g.lead?.guess ?? null, form: (g.lead?.guess ? 'confirm' : 'choose') as 'choose' | 'confirm', unit: byId.get(g.units[0]!)!.unit }))
    .sort((a, b) => b.value - a.value || a.group.localeCompare(b.group));
  // The routine asks the top Q of this list. Fragment values are minute-weighted, item values are not, so a plain sort
  // lets the day's calls crowd out every item question (on bench-agency the doubted BKR route then got one answer in four
  // weeks and froze 27 errors instead of 7): the kinds take turns, each in its own value order.
  const questions = interleave(ranked, (q) => q.unit);
  const askOf = new Map(questions.flatMap((q) => q.units.map((id) => [id, q] as const)));

  // Audits: today's auto-decided units (an audited one keeps its pre-answer decision, so the sample is stable all day).
  const firstDay = valid.reduce<string | null>((m, r) => (m === null || r.day < m ? r.day : m), null);
  const candidates = list.filter((u) => u.day === today && auto(final.get(u.id)!)).map((u) => u.id);
  const audits = auditSample(candidates, opts.seed ?? '', today, Math.min(candidates.length, auditSize(firstDay, today, Math.max(0, opts.questionsPerDay) * Math.max(0, opts.auditShare))));
  const audited = new Set(audits);

  const calibration: CalibrationRow[] = [...prior]
    .map(([instance, p]) => {
      const st = calib.stat(instance);
      const right = st?.right ?? 0;
      const wrong = st?.wrong ?? 0;
      const a = PRIOR_STRENGTH * p + right;
      const b = PRIOR_STRENGTH * (1 - p) + wrong;
      const mean = a / (a + b);
      return { instance, a, b, mean, demoted: p >= tau && mean < tau, prior: p, right, wrong, clientMean: posterior(p, st?.clientRight ?? 0, st?.clientWrong ?? 0) };
    })
    .sort((x, y) => Number(y.demoted) - Number(x.demoted) || y.right + y.wrong - (x.right + x.wrong) || x.instance.localeCompare(y.instance));

  return {
    units: list.map((u) => {
      const d = final.get(u.id)!;
      const a = asked.get(u.id);
      const q = askOf.get(u.id);
      return {
        id: u.id,
        label: d.label,
        conf: d.conf,
        rung: d.rung,
        guess: d.guess,
        why: d.why,
        ...(d.umbrella ? { umbrella: d.umbrella, umbrellaConf: d.umbrellaConf } : {}),
        ...(answered.has(u.id) ? { answered: answered.get(u.id)! } : {}),
        ...(a && q ? { ask: { group: a.group, value: a.value, guess: q.guess, form: q.form } } : {}),
        ...(audited.has(u.id) ? { audit: true } : {}),
      };
    }),
    calibration,
    keyTypes: (Object.keys(KEY_TYPES) as KeyType[]).map((t) => ({ type: t, a: learner.rel[t].a, b: learner.rel[t].b, mean: learner.h(t), deciding: KEY_TYPES[t].direct ? learner.h(t) >= tau : learner.decidable(t, tau) })),
    questions,
    audits,
    ruleCandidates: learner.ruleCandidates(3, 0.9),
    stats: {
      evidence: valid.length,
      used: used.length,
      superseded: valid.length - latest.size,
      unknown: [...latest.keys()].filter((id) => !byId.has(id)).length,
      answers: new Set(used.map(answerOf)).size,
      trials: { ...learner.trials },
    },
  };
}

// Round-robin over the kinds, each list keeping its own order (deterministic: kinds in first-appearance order).
export function interleave<T>(xs: readonly T[], kind: (x: T) => string): T[] {
  const lanes = new Map<string, T[]>();
  for (const x of xs) {
    const k = kind(x);
    const lane = lanes.get(k);
    if (lane) lane.push(x);
    else lanes.set(k, [x]);
  }
  const out: T[] = [];
  const queues = [...lanes.values()];
  for (let i = 0; out.length < xs.length; i++) for (const q of queues) if (i < q.length) out.push(q[i]!);
  return out;
}
