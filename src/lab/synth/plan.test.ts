// The bench-agency plan: deterministic, complete truth for every applicable task, volumes on target, the designed
// traps present (glued Gemini lines, renames after their dates), and — end to end — raw lines that the REAL store
// build ingests without a malformed line, resolving people the way the identity truth says it should.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDerive, buildPlan, formatCopy, givenTenant, meetingText, volumeOf } from './plan.js';
import { REBRAND_DAY, RENAME_AT } from './world.js';
import type { CallContent, Plan, PlannedItem } from './types.js';
import { buildStore, classifyRawFile, openReadOnly, refOf, threadIdOf } from '../../sources/store.js';
import { validatePeople } from '../../sources/people.js';
import { parseAttributionConfig } from '../../sources/attribution/config.js';
import { parseRegistry } from '../../sources/attribution/registry.js';

const plan = buildPlan(1);
const byId = new Map(plan.items.map((i) => [i.id, i]));
const of = (pred: (i: PlannedItem) => boolean) => plan.items.filter(pred);

test('same seed → byte-identical plan; another seed → a different one', () => {
  const again = buildPlan(1);
  assert.equal(JSON.stringify(again.items), JSON.stringify(plan.items));
  assert.equal(JSON.stringify(again.truth), JSON.stringify(plan.truth));
  assert.equal(JSON.stringify(again.world), JSON.stringify(plan.world));
  assert.notEqual(JSON.stringify(buildPlan(2).items), JSON.stringify(plan.items));
});

test('volumes within ±25 % of the reduced targets', () => {
  const v = volumeOf(plan.items);
  const targets: Record<string, number> = {
    slack_human: 500, slack_agent: 80, slack_bot: 1200, youtrack_tickets: 50, youtrack_comments: 250, jira_tickets: 10, jira_comments: 40,
    gmail_work: 800, gmail_work_human: 280, gmail_personal: 60, gcal_events: 90, calls: 20, meeting_copies: 28, activity_blocks: 60,
  };
  for (const [k, target] of Object.entries(targets)) {
    const got = v[k] ?? 0;
    assert.ok(got >= target * 0.75 && got <= target * 1.25, `${k}: ${got} not within ±25 % of ${target}`);
  }
  const slackHuman = of((i) => i.source === 'slack' && i.truth.human);
  const replies = slackHuman.filter((i) => i.threadId !== `slack:${i.account}/${i.ref.split(':')[2]}/${i.ref.split(':')[3]}`).length;
  const dms = slackHuman.filter((i) => /^(dm|mpim):/.test(i.container ?? '')).length;
  assert.ok(replies / slackHuman.length > 0.2 && replies / slackHuman.length < 0.4, `thread replies ${replies}/${slackHuman.length}`);
  assert.ok(dms / slackHuman.length > 0.18 && dms / slackHuman.length < 0.32, `DM/mpim ${dms}/${slackHuman.length}`);
  const auto = of((i) => i.source === 'gmail' && i.account === plan.world.accounts.work && !i.truth.human).length / (v.gmail_work ?? 1);
  assert.ok(auto > 0.55 && auto < 0.75, `automated work mail share ${auto}`);
});

test('every item carries truth for its applicable tasks', () => {
  const labels = new Set([...plan.world.initiatives.map((i) => i.id), 'none']);
  for (const it of plan.items) {
    const t = it.truth;
    assert.ok(labels.has(t.label), `${it.id}: label ${t.label}`);
    if (t.label === 'none') assert.equal(t.shares.length, 0, it.id);
    else assert.ok(Math.abs(t.shares.reduce((a, s) => a + s.share, 0) - 1) < 0.01, `${it.id}: shares sum`);
    for (const s of t.shares) assert.ok(labels.has(s.id), `${it.id}: share ${s.id}`);
    assert.ok(t.cluster, `${it.id}: cluster`);
    assert.ok(t.decidableBy, `${it.id}: decidable_by`);
    if (it.type === 'message' || it.type === 'task' || it.type === 'comment') {
      assert.ok(t.kind, `${it.id}: kind`);
      if (t.kind === 'noise') assert.ok(t.noiseType, `${it.id}: noise_type`);
      if (t.human && t.kind !== 'noise') assert.ok(t.addressee, `${it.id}: addressee`);
      if (t.kind === 'commitment') assert.ok(t.commitments.length, `${it.id}: commitment truth`);
      if (t.human) assert.ok(t.lang, `${it.id}: lang`);
    } else assert.equal(t.kind, null, `${it.id}: kind n/a`);
    if (it.render.mode === 'human') assert.equal(it.text, null, `${it.id}: human text must wait for the renderer`);
    if (it.render.mode === 'template') assert.ok(it.rendered && it.text !== null, `${it.id}: template text`);
    // t3: every raw surface string the store will see on this item has exactly one identity occurrence.
    const raws = new Set(t.identities.map((o) => o.raw));
    for (const line of it.lines) {
      const r = line.record;
      if (r.deleted) continue;
      const seen: string[] = [];
      if (it.source === 'slack') seen.push(String(r.author), ...(r.participants as string[]));
      else if (it.source === 'gmail') seen.push(String(r.author), ...(r.participants as string[]));
      else if (it.type === 'task') seen.push(String(r.reporter), ...(r.assignee ? [String(r.assignee)] : []));
      else if (it.type === 'event') seen.push(String(r.organizer), ...(r.attendees as string[]));
      else if (it.type === 'meeting') for (const a of r.attendees as { email: string; name: string }[]) seen.push(a.email || a.name);
      for (const s of seen) assert.ok(raws.has(s), `${it.id}: no identity truth for "${s}"`);
    }
  }
  for (const c of of((i) => i.type === 'comment')) assert.equal(c.truth.identities.length, 1, `${c.id}: comment author`);
  // Answers point at existing items of the same conversation, commitments at existing items.
  for (const it of plan.items) if (it.truth.answeredBy) assert.ok(byId.has(it.truth.answeredBy), `${it.id}: answered_by`);
  for (const c of plan.truth.commitments) assert.ok(['kept', 'missed', 'open'].includes(c.outcome));
});

test('dedup clusters, identities and roster are consistent', () => {
  const refs = new Set(plan.items.map((i) => i.ref));
  for (const d of plan.truth.dedup) {
    assert.ok(d.members.length >= 2, d.cluster_id);
    assert.ok(d.members.includes(d.canonical), d.cluster_id);
    for (const m of d.members) assert.ok(refs.has(m), `${d.cluster_id}: ${m}`);
  }
  const types = new Set(plan.truth.dedup.map((d) => d.type));
  for (const t of ['exact', 'near', 'flap', 'bump', 'crosspost', 'forward', 'recorder_copy', 'digest', 'ticket_duplicate']) assert.ok(types.has(t as never), `dedup type ${t} missing`);
  // Every surface form the world declares occurs at least once — the roster is the identity gold.
  // (A Gemini chip counts when it occurs inside a glued line that truly contains the person.)
  const occs = plan.items.flatMap((i) => i.truth.identities);
  const invited = plan.items.filter((i) => i.meeting?.invited).map((i) => ({ line: i.meeting!.invited!, pids: i.truth.identities.flatMap((o) => o.truth.split('+')) }));
  const used = (pid: string, raw: string) =>
    occs.some((o) => (o.raw === raw && o.truth === pid) || (o.form === 'glued_pair' && o.truth.split('+').includes(pid) && (o.raw.includes(raw) || o.raw.includes(raw.toLowerCase())))) ||
    invited.some((x) => x.line.includes(raw) && x.pids.includes(pid)); // e.g. "Müller, Jürg": only the doc's Invited line has it whole
  for (const p of plan.world.people) for (const f of p.forms) assert.ok(used(p.id, f.raw), `${p.id}: form "${f.raw}" never occurs`);
  const forms = new Set(plan.truth.identities.map((r) => r.form));
  for (const f of ['alias_email', 'slack_label', 'opaque_id', 'login', 'login_org_suffix', 'full_name', 'order_swapped', 'first_name', 'nickname', 'transliteration', 'umlaut_variant', 'typo', 'glued_pair', 'role_mailbox', 'system']) assert.ok(forms.has(f as never), `form ${f} missing`);
  const expected = new Set(plan.truth.identities.map((r) => r.expected));
  for (const e of ['mapped', 'merge', 'question', 'drop']) assert.ok(expected.has(e as never), `expected ${e} missing`);
});

test('Gemini "Invited" lines are glued (and a "Last, First" chip splits them in the wrong place)', () => {
  const gmeet = of((i) => i.source === 'gmeet');
  const entries = gmeet.flatMap((i) => i.lines[0]!.record.attendees as { email: string; name: string }[]);
  const glued = gmeet.flatMap((i) => i.truth.identities).filter((o) => o.form === 'glued_pair');
  assert.ok(glued.length >= 6 && glued.length / entries.length >= 0.4, `glued ${glued.length}/${entries.length}`);
  assert.ok(glued.some((o) => o.raw.includes('@')), 'a glued line with an address (stored in the email field)');
  assert.ok(entries.every((e) => !(e.email || e.name).includes(',')), 'entries are comma-split like parseGeminiDoc');
  assert.ok(gmeet.some((i) => (i.meeting!.invited ?? '').includes(',') && (i.lines[0]!.record.attendees as unknown[]).length === 2), 'the comma chip yields two garbled entries');
  for (const i of gmeet) assert.equal(i.lines[0]!.record.end, i.lines[0]!.record.start, 'Gemini docs have no duration');
  assert.ok(of((i) => i.source === 'wispr').some((i) => i.truth.identities.some((o) => o.raw === 'Marco' && o.ambiguous?.length === 2)), 'the ambiguous "Marco"');
});

test('renames apply after their dates and never before', () => {
  for (const it of of((i) => i.source === 'slack' && i.ref.includes(':C0BENCHKLT1:'))) {
    assert.equal(it.container, it.ts >= RENAME_AT ? '#ext-klartext-hub' : '#ext-klartext-cms', it.id);
  }
  const kt = of((i) => i.type === 'task' && i.keys.some((k) => k.startsWith('KT-')));
  assert.ok(kt.length >= 5);
  let renamedLines = 0;
  for (const it of kt) for (const l of it.lines) {
    const key = String(l.record.key);
    if (l.at >= RENAME_AT) {
      assert.match(key, /^KH-/, `${it.id} after rename`);
      renamedLines++;
    } else assert.match(key, /^KT-/, `${it.id} before rename`);
    assert.equal(l.record.id, kt.find((x) => x.id === it.id)!.ref.split(':')[2], 'internal id stable across the key rename');
  }
  assert.ok(renamedLines >= kt.length, 'every KT ticket re-emitted under KH');
  for (const it of of((i) => i.type === 'activity' && /klartext-(cms|hub)/.test(i.container ?? ''))) assert.equal(it.container!.endsWith('klartext-hub'), it.ts >= RENAME_AT, it.id);
  // Velo Nord domain + Slack Connect labels.
  for (const it of plan.items) for (const o of it.truth.identities) {
    if (/@velonord\.example$/.test(o.raw)) assert.ok(it.day < REBRAND_DAY, `${it.id}: old domain after the rebrand`);
    if (/@velo-nord\.example$/.test(o.raw)) assert.ok(it.day >= REBRAND_DAY, `${it.id}: new domain before the rebrand`);
    if (/\| VELO-NORD$/.test(o.raw)) assert.ok(it.day >= REBRAND_DAY, `${it.id}: new label before the rebrand`);
    if (/\| Velo Nord$/.test(o.raw)) assert.ok(it.day < REBRAND_DAY, `${it.id}: old label after the rebrand`);
  }
  // The GIVEN registry is stale in exactly the designed way: the hub still lists the pre-rename channel.
  const reg = givenTenant(plan.world)['initiatives.json'] as { initiatives: { id: string; alias_of?: string; sources: { slack_channels: string[] } }[] };
  assert.deepEqual(reg.initiatives.find((i) => i.id === 'klartext/content-hub')!.sources.slack_channels, ['#ext-klartext-cms']);
  assert.equal(reg.initiatives.find((i) => i.id === 'klartext/cms-migration')!.alias_of, 'klartext/content-hub');
  assert.ok(!reg.initiatives.some((i) => i.id.startsWith('unregistered:')));
});

test('raw lines follow the pullers’ contracts (file kind, ref, thread id)', () => {
  const kindOf: Record<string, string> = { message: 'messages', task: 'tasks', event: 'events', meeting: 'meetings', activity: 'activity' };
  for (const it of plan.items) {
    if (it.type === 'comment') {
      assert.equal(it.lines.length, 0, 'comments ride on their ticket');
      continue;
    }
    assert.ok(it.lines.length >= 1, it.id);
    for (const l of it.lines) {
      assert.equal(classifyRawFile(l.file), kindOf[it.type], `${it.id}: ${l.file}`);
      assert.equal(refOf(l.record), it.ref, `${it.id}: ref`);
      if (it.type === 'message' && !l.record.deleted) assert.equal(threadIdOf(l.record, it.ref), it.threadId, `${it.id}: thread`);
      for (const f of l.fill) assert.ok(byId.has(f.item), `${it.id}: fill source ${f.item}`);
    }
  }
});

test('the GIVEN tenant parses with the production readers', () => {
  const t = givenTenant(plan.world);
  const people = validatePeople(t['annotations/people.json']);
  assert.equal(people.length, 26);
  const markers = people.map((p) => p.marker?.type);
  assert.equal(markers.filter((m) => m === 'exclusive').length, 3);
  assert.equal(markers.filter((m) => m === 'narrow').length, 8);
  const cfg = parseAttributionConfig(t['annotations/attribution.json']);
  assert.equal(cfg.subject, plan.world.subject);
  assert.equal(cfg.budgets?.length, 3);
  const reg = parseRegistry(t['initiatives.json']);
  for (const i of reg.initiatives) for (const c of (i.sources.slack_channels as unknown[]) ?? []) assert.equal(typeof c, 'string');
  assert.equal(t['annotations/fragments.jsonl'], '');
});

// --- end to end: placeholder text → raw → the real buildStore ----------------------------------------------

function fillAll(p: Plan): Map<string, string[]> {
  const ids = new Map(p.items.map((i) => [i.id, i]));
  const texts = new Map<string, string>();
  const textOf = (id: string): string => {
    const hit = texts.get(id);
    if (hit !== undefined) return hit;
    const it = ids.get(id)!;
    const t = it.rendered && it.text !== null ? it.text : it.render.mode === 'human' ? `[${it.id}] ${it.render.beat.required.join(' ')} lorem ipsum dolor sit amet.` : it.render.mode === 'derived' ? applyDerive(textOf(it.render.from), it.render.op) : '';
    texts.set(id, t);
    return t;
  };
  const meetings = new Map<string, { summary: string; transcript: string; next_steps: string[] }>();
  const contentOf = new Map<string, CallContent>();
  for (const it of p.items) {
    if (it.type !== 'meeting' || it.render.mode !== 'human') continue;
    const m = it.render.beat.meeting!;
    contentOf.set(it.meeting!.call, {
      intro: 'Overview of the call.',
      topics: m.topics.map((t) => ({ heading: t.heading, body: 'A point was discussed. '.repeat(Math.max(1, Math.round(t.share * 8))).trim() })),
      nextSteps: m.nextSteps.map((n) => ({ ownerLabel: n.ownerLabel, text: n.brief })),
      transcript: m.speakers.map((s) => ({ speaker: s, text: 'We talked about the plan and the next steps in some detail. '.repeat(3).trim() })),
    });
  }
  for (const it of p.items) if (it.type === 'meeting') meetings.set(it.id, formatCopy(it, contentOf.get(it.meeting!.call)!));
  const files = new Map<string, { at: string; n: number; line: string }[]>();
  let n = 0;
  for (const it of p.items) {
    for (const l of it.lines) {
      const r = JSON.parse(JSON.stringify(l.record)) as Record<string, unknown>;
      for (const f of l.fill) {
        let v: unknown;
        if (f.part === 'text') v = applyDerive(textOf(f.item), f.op ?? {});
        else if (f.part === 'flatten') v = meetingText(String(r.title), String(r.summary), r.next_steps as string[]);
        else v = meetings.get(f.item)![f.part];
        const path = f.path.split('.');
        let o = r as Record<string, unknown>;
        for (const k of path.slice(0, -1)) o = o[k] as Record<string, unknown>;
        o[path[path.length - 1]!] = v;
      }
      const list = files.get(l.file) ?? [];
      list.push({ at: l.at, n: n++, line: JSON.stringify(r) });
      files.set(l.file, list);
    }
  }
  const out = new Map<string, string[]>();
  for (const [f, rows] of files) out.set(f, rows.sort((a, b) => a.at.localeCompare(b.at) || a.n - b.n).map((x) => x.line));
  return out;
}

test('end to end: the real store build ingests the plan and resolves people as the truth expects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-agency-'));
  try {
    const raw = join(dir, 'raw');
    for (const [file, lines] of fillAll(plan)) {
      mkdirSync(join(raw, file, '..'), { recursive: true });
      writeFileSync(join(raw, file), `${lines.join('\n')}\n`);
    }
    writeFileSync(join(raw, 'slack', 'slack.users.json'), JSON.stringify({ [plan.world.accounts.slackTeam]: { fetched_at: plan.world.now, users: plan.world.slackUsers } }));
    const tenant = join(dir, 'tenant');
    for (const [path, content] of Object.entries(givenTenant(plan.world))) {
      mkdirSync(join(tenant, path, '..'), { recursive: true });
      writeFileSync(join(tenant, path), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
    }
    const storePath = join(dir, 'store.sqlite');
    const sum = buildStore({
      slug: 'bench-agency', rawDir: raw, storePath, peoplePath: join(tenant, 'annotations', 'people.json'), fragmentsPath: join(tenant, 'annotations', 'fragments.jsonl'),
      attribution: { tenantRoot: tenant, annotationsDir: join(tenant, 'annotations'), timezone: plan.world.tz }, timezone: plan.world.tz, now: () => new Date(plan.world.now), log: () => {},
    });
    assert.equal(sum.malformed, 0);
    assert.deepEqual(sum.skippedFiles, []);
    assert.ok(!(sum.attribution && typeof sum.attribution === 'object' && 'error' in sum.attribution), JSON.stringify(sum.attribution));
    const db = openReadOnly(storePath);
    try {
      const count = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
      assert.equal(count('SELECT count(*) AS n FROM messages'), of((i) => i.type === 'message').length);
      assert.equal(count('SELECT count(*) AS n FROM tasks'), of((i) => i.type === 'task').length);
      assert.equal(count('SELECT count(*) AS n FROM meetings'), of((i) => i.type === 'meeting').length);
      assert.equal(count('SELECT count(*) AS n FROM events'), of((i) => i.type === 'event').length);
      assert.equal(count('SELECT count(*) AS n FROM activity'), of((i) => i.type === 'activity').length);
      assert.equal(count('SELECT count(*) AS n FROM messages WHERE deleted = 1'), of((i) => i.type === 'message' && i.truth.deleted).length);
      assert.equal(count('SELECT count(*) AS n FROM events WHERE deleted = 1'), of((i) => i.type === 'event' && i.truth.deleted).length);
      // Calls: one per planned call, plus one for each designed split trap (copies whose windows barely overlap).
      const planned = new Set(of((i) => i.type === 'meeting').map((i) => i.meeting!.call)).size;
      const traps = new Set(of((i) => i.truth.noise.includes('call_split_trap')).map((i) => i.meeting!.call)).size;
      assert.equal(count('SELECT count(*) AS n FROM calls'), planned + traps);
      // Slack thread sizes as planned (live messages only).
      for (const root of of((i) => i.source === 'slack' && !!i.thread && i.thread.index === 0 && i.threadId.endsWith(i.ref.split(':')[3]!))) {
        const live = of((i) => i.threadId === root.threadId && !i.truth.deleted).length;
        if (live < 2) continue;
        assert.equal(count(`SELECT n FROM threads WHERE thread_id = '${root.threadId}'`), live, root.id);
      }
      // Person resolution: every author occurrence the truth calls "mapped" resolves to its person in the store.
      const authorOf = db.prepare('SELECT author_person AS p FROM messages WHERE ref = ?');
      for (const it of of((i) => i.type === 'message' && !i.truth.deleted)) {
        const o = it.truth.identities.find((x) => x.field === 'author')!;
        const got = (authorOf.get(it.ref) as { p: string | null }).p;
        if (o.expected === 'mapped') assert.equal(got, o.truth, `${it.id}: "${o.raw}" should resolve`);
        else assert.notEqual(got, o.truth === 'system' ? 'never' : o.truth, `${it.id}: "${o.raw}" resolves although truth says ${o.expected}`);
      }
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
