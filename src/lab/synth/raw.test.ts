// The raw writer: slots filled from final texts (edits' first emission, Slack reply subjects, recorder styles,
// flattened meeting text), lines in append order, and — end to end on a handful of conversations — the real
// buildStore sees the planned refs, threads, calls and people.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { buildStore, openReadOnly } from '../../sources/store.js';
import { applyDerive, buildPlan, formatCopy, meetingText } from './plan.js';
import { FIXTURE_DIR, planMismatches, readFixture } from './load.js';
import { callContents, rawFiles, slackUsersJson, writeRaw, writeTenant } from './raw.js';
import { assemble, conversationKey, type RenderedItem } from './render.js';
import type { CallContent, PlannedItem } from './types.js';

const plan = buildPlan(1);
const byId = new Map(plan.items.map((i) => [i.id, i]));

// Placeholder "rendering": a text that carries the beat's required tokens; a call's content from its beat.
function fakeRender(items: readonly PlannedItem[]): RenderedItem[] {
  const texts = new Map<string, string>();
  const calls = new Map<string, CallContent>();
  for (const it of items) {
    if (it.render.mode !== 'human') continue;
    const b = it.render.beat;
    if (it.type === 'meeting' && b.meeting) {
      calls.set(it.meeting!.call, {
        intro: `Overview of ${it.title}.`,
        topics: b.meeting.topics.map((t) => ({ heading: t.heading, body: `${t.brief} It was agreed.` })),
        nextSteps: b.meeting.nextSteps.map((s) => ({ ownerLabel: s.ownerLabel, text: s.brief })),
        transcript: b.meeting.speakers.map((s) => ({ speaker: s, text: 'We went through it.' })),
      });
    } else texts.set(it.id, `Message ${it.id}: ${b.required.join(' ')}. Zusammenfassung of the planned work follows.`); // two sentences: edits truncate one
  }
  return assemble(items, texts, calls);
}

// A handful of conversations, plus every item their slots or derivations read from.
function pick(): PlannedItem[] {
  const keys = new Set<string>();
  const add = (it: PlannedItem | undefined) => it && keys.add(conversationKey(it));
  add(plan.items.find((i) => i.source === 'slack' && i.render.mode === 'human' && i.lines[0]!.fill.some((f) => f.path === 'subject')));
  add(plan.items.find((i) => i.source === 'slack' && i.lines.length > 1 && i.lines[0]!.fill.some((f) => f.op?.perturb))); // an edit
  add(plan.items.find((i) => i.source === 'slack' && i.truth.deleted)); // a tombstone
  add(plan.items.find((i) => i.source === 'gmail' && i.render.mode === 'human' && (i.render.beat.pos?.of ?? 0) >= 2));
  add(plan.items.find((i) => i.type === 'comment' && (i.thread?.index ?? 0) >= 3));
  const call = plan.items.find((i) => i.type === 'meeting' && i.render.mode === 'derived')!.meeting!.call;
  const chosen = plan.items.filter((i) => keys.has(conversationKey(i)) || i.meeting?.call === call);
  chosen.push(plan.items.find((i) => i.type === 'event')!, plan.items.find((i) => i.type === 'activity')!);
  // Conversations by key miss machine replies in the same store thread: take whole threads too.
  const threads = new Set(chosen.filter((i) => i.type === 'message').map((i) => i.threadId));
  chosen.push(...plan.items.filter((i) => i.type === 'message' && threads.has(i.threadId)));
  const ids = new Set(chosen.map((i) => i.id));
  for (let grew = true; grew; ) {
    grew = false;
    for (const id of [...ids]) {
      const it = byId.get(id)!;
      const need = [...it.lines.flatMap((l) => l.fill.map((f) => f.item)), ...(it.render.mode === 'derived' ? [it.render.from] : []), ...(it.type === 'comment' ? [it.thread!.root] : [])];
      if (it.type === 'task') need.push(...plan.items.filter((c) => c.type === 'comment' && c.thread?.root === it.id).map((c) => c.id));
      for (const n of need) if (!ids.has(n)) {
        ids.add(n);
        grew = true;
      }
    }
  }
  return plan.items.filter((i) => ids.has(i.id)); // plan order
}

test('slots are filled from final texts: edits, reply subjects, recorder copies, flattened meeting text', () => {
  const items = fakeRender(plan.items);
  const files = rawFiles(items);
  const textOf = new Map(items.map((i) => [i.id, i.text]));
  const records = [...files.values()].flat().map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(records.length, plan.items.reduce((a, i) => a + i.lines.length, 0));
  assert.ok(records.every((r) => !JSON.stringify(r).includes('"text":null')), 'no unfilled text slot');
  // Lines of a file go out in emission order.
  for (const [file, lines] of files) {
    const ats = plan.items.flatMap((i) => i.lines.filter((l) => l.file === file).map((l) => l.at)).sort();
    assert.equal(lines.length, ats.length, file);
  }
  const edit = plan.items.find((i) => i.source === 'slack' && i.lines.length > 1 && i.lines[0]!.fill.some((f) => f.op?.perturb))!;
  const editLines = records.filter((r) => r.id === edit.lines[0]!.record.id);
  assert.equal(editLines.at(-1)!.text, textOf.get(edit.id), 'the last emission carries the final text');
  assert.notEqual(editLines[0]!.text, textOf.get(edit.id), 'the first emission is the pre-edit version');
  const reply = plan.items.find((i) => i.source === 'slack' && i.render.mode === 'human' && i.lines[0]!.fill.some((f) => f.path === 'subject'))!;
  const subj = reply.lines[0]!.fill.find((f) => f.path === 'subject')!;
  assert.equal(records.find((r) => r.id === reply.lines[0]!.record.id)!.subject, applyDerive(textOf.get(subj.item)!, { re60: true }));
  const calls = callContents(items);
  for (const copy of plan.items.filter((i) => i.type === 'meeting')) {
    const r = records.find((x) => x.source === copy.source && x.id === copy.lines[0]!.record.id)!;
    const f = formatCopy(copy, calls.get(copy.meeting!.call)!);
    assert.equal(r.summary, f.summary, copy.id);
    assert.deepEqual(r.next_steps, f.next_steps, copy.id);
    assert.equal(r.text, meetingText(String(r.title), f.summary, f.next_steps), copy.id);
  }
  assert.throws(() => rawFiles(plan.items.map((i) => ({ ...i }))), /render the plan first/);
  assert.deepEqual(JSON.parse(slackUsersJson(plan.world))[plan.world.accounts.slackTeam].users, plan.world.slackUsers);
});

test('a handful of conversations round-trip through the real buildStore: refs, threads, calls, people', () => {
  const items = pick();
  const rendered = fakeRender(items);
  const dir = mkdtempSync(join(tmpdir(), 'bench-agency-raw-'));
  try {
    const raw = join(dir, 'raw');
    const tenant = join(dir, 'tenant');
    const w = writeRaw(raw, rendered, plan.world);
    assert.equal(w.lines, items.reduce((a, i) => a + i.lines.length, 0));
    writeTenant(tenant, plan.world);
    assert.ok(readFileSync(join(raw, 'slack', 'slack.users.json'), 'utf8').includes(plan.world.accounts.slackTeam));
    const ann = join(tenant, 'annotations');
    const storePath = join(dir, 'store.sqlite');
    const sum = buildStore({
      slug: plan.world.slug, rawDir: raw, storePath, peoplePath: join(ann, 'people.json'), fragmentsPath: join(ann, 'fragments.jsonl'),
      attribution: { tenantRoot: tenant, annotationsDir: ann, timezone: plan.world.tz, pinsPath: join(dir, 'pins.jsonl') }, timezone: plan.world.tz, now: () => new Date(plan.world.now), log: () => {},
    });
    assert.equal(sum.malformed, 0);
    assert.deepEqual(sum.skippedFiles, []);
    assert.ok(!(sum.attribution && typeof sum.attribution === 'object' && 'error' in sum.attribution), JSON.stringify(sum.attribution));
    const db = openReadOnly(storePath);
    try {
      const one = <T>(sql: string, ...args: string[]) => db.prepare(sql).get(...args) as T | undefined;
      const texts = new Map(rendered.map((i) => [i.id, i.text]));
      for (const it of items) {
        if (it.type === 'message') {
          const r = one<{ thread_id: string; deleted: number; text: string; author_person: string | null }>('SELECT thread_id, deleted, text, author_person FROM messages WHERE ref = ?', it.ref);
          assert.ok(r, `${it.id}: ${it.ref}`);
          assert.equal(Boolean(r.deleted), it.truth.deleted, `${it.id}: deleted`);
          if (it.truth.deleted) continue;
          assert.equal(r.thread_id, it.threadId, `${it.id}: thread`);
          assert.equal(r.text, texts.get(it.id), `${it.id}: final text`);
          const author = it.truth.identities.find((o) => o.field === 'author')!;
          if (author.expected === 'mapped') assert.equal(r.author_person, author.truth, `${it.id}: "${author.raw}" resolves`);
        } else if (it.type === 'task') {
          const r = one<{ key: string; comments: string }>('SELECT key, comments FROM tasks WHERE ref = ?', it.ref);
          assert.ok(r, it.ref);
          const last = it.lines.at(-1)!.record;
          assert.equal(r.key, last.key, `${it.id}: the last state wins`);
          assert.equal((JSON.parse(r.comments) as unknown[]).length, (last.comments as unknown[]).length);
        } else if (it.type === 'comment') {
          const [task, cid] = it.ref.split('#c');
          const r = one<{ comments: string }>('SELECT comments FROM tasks WHERE ref = ?', task!);
          const c = (JSON.parse(r!.comments) as { id: string; text: string }[]).find((x) => x.id === cid);
          assert.equal(c?.text, texts.get(it.id), `${it.id}: comment text`);
        } else {
          const table = it.type === 'meeting' ? 'meetings' : it.type === 'event' ? 'events' : 'activity';
          assert.ok(one(`SELECT ref FROM ${table} WHERE ref = ?`, it.ref), `${it.id}: ${it.ref}`);
        }
      }
      // Live thread sizes as planned.
      const live = new Map<string, number>();
      for (const it of items) if (it.type === 'message' && !it.truth.deleted) live.set(it.threadId, (live.get(it.threadId) ?? 0) + 1);
      for (const [tid, n] of live) if (n > 1) assert.equal(one<{ n: number }>('SELECT n FROM threads WHERE thread_id = ?', tid)?.n, n, tid);
      // Recorder copies of the call cluster into one call (unless the plan made it a split trap).
      const copies = items.filter((i) => i.type === 'meeting');
      const ids = new Set(copies.map((c) => one<{ call_id: string }>('SELECT call_id FROM meetings WHERE ref = ?', c.ref)!.call_id));
      assert.equal(ids.size, copies.some((c) => c.truth.noise.includes('call_split_trap')) ? 2 : 1);
      // People: the GIVEN roster, seeded.
      assert.equal(one<{ n: number }>('SELECT count(*) AS n FROM people')!.n, plan.world.people.filter((p) => p.given).length);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The committed fixture is what `lab synth build` falls back to: it must still render THIS plan, or the dataset it
// rebuilds would carry texts that no longer match their truth. A planner change means: render again, then
// `lab synth fixture`.
test('the committed fixture renders the current plan, every slot filled', { skip: !existsSync(join(FIXTURE_DIR, 'plan.rendered.jsonl.gz')) }, () => {
  const { items, world } = readFixture();
  assert.deepEqual(planMismatches(items, plan), [], 'stale fixture: re-render and run `lab synth fixture`');
  assert.equal(JSON.stringify(world), JSON.stringify(plan.world));
  assert.deepEqual(items.filter((i) => !i.rendered).map((i) => i.id), []);
  const lines = [...rawFiles(items).values()].reduce((a, l) => a + l.length, 0);
  assert.equal(lines, plan.items.reduce((a, i) => a + i.lines.length, 0));
});

// The fixture is public, and model-written: whatever a render slips in ships with the repo (public-guard.sh reads
// inside the .gz for our own identifiers). Generic shapes are checked here: every e-mail domain and URL host is a
// reserved .example name (the Gmail permalink is the puller's own shape), and no text holds a phone number.
test('the committed fixture stays fictional: .example addresses and hosts only, no phone numbers', { skip: !existsSync(join(FIXTURE_DIR, 'plan.rendered.jsonl.gz')) }, () => {
  const text = `${gunzipSync(readFileSync(join(FIXTURE_DIR, 'plan.rendered.jsonl.gz'))).toString('utf8')}\n${readFileSync(join(FIXTURE_DIR, 'world.json'), 'utf8')}`;
  const domains = new Set([...text.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)].map((m) => m[1]!.toLowerCase()));
  assert.ok(domains.size > 10);
  assert.deepEqual([...domains].filter((d) => !d.endsWith('.example')), []);
  const hosts = new Set([...text.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)].map((m) => m[1]!.toLowerCase()));
  assert.deepEqual([...hosts].filter((h) => !h.endsWith('.example') && h !== 'mail.google.com'), []);
  assert.deepEqual(text.match(/\+\d{1,3}[ \d]{6,}\d/g) ?? [], []);
});
