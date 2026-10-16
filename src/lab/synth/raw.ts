// The bench-agency raw writer: rendered plan → raw/ exactly as the pullers would have left it, plus the Slack users
// map and the GIVEN tenant. The plan already holds every record in its puller's contract (plan.test.ts checks file
// kind, ref and thread id against store.ts); this module only fills the text slots and orders the lines.
//
//   slack/slack.messages.jsonl, slack/slack.users.json        slack/pull.ts (+ normalise.ts MessageRecord)
//   google/<account>/messages.jsonl, …/events.jsonl            google/pull.ts
//   meetings/<granola|gmeet|wispr>/<account>/meetings.jsonl    meetings/writer.ts
//   youtrack|jira/<host>/tasks.jsonl                           trackers/writer.ts (one line per ticket state)
//   local/activity.jsonl                                       local/pull.ts
//
// A slot takes a part of an item's final text: its text (through a DeriveOp for edits' first emission and Slack's
// `re: <parent…>` subjects), a meeting copy's summary / transcript / next steps in its recorder's style (formatCopy
// of the call's content), or the meeting's `text`, flattened from the filled record exactly as the puller does.
// Lines of a file go out in (emission time, plan order) — the order a puller appends them, which the store's
// last-line-wins replay depends on (edits, status changes, tombstones, late copies).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { applyDerive, formatCopy, givenTenant, meetingText } from './plan.js';
import type { CallContent, Fill, PlannedItem, World } from './types.js';
import type { RenderedItem } from './render.js';

/** Call id → its rendered content (carried by the call's primary copy). */
export function callContents(items: readonly RenderedItem[]): Map<string, CallContent> {
  const out = new Map<string, CallContent>();
  for (const it of items) if (it.call && it.meeting) out.set(it.meeting.call, it.call);
  return out;
}

export interface FillOpts {
  /** Text for an item the renderer has not filled yet (tests, partial smoke runs); default: throw. */
  placeholder?: (it: PlannedItem) => string;
  /** Content for a call that has none yet; default: throw. */
  placeholderCall?: (copy: PlannedItem) => CallContent;
}

function setPath(rec: Record<string, unknown>, path: string, v: unknown): void {
  const keys = path.split('.');
  let o = rec as Record<string, unknown>;
  for (const k of keys.slice(0, -1)) {
    const next = o[k];
    if (!next || typeof next !== 'object') throw new Error(`fill path ${path}: no object at ${k}`);
    o = next as Record<string, unknown>;
  }
  o[keys[keys.length - 1]!] = v;
}

/**
 * Every raw line of the plan with its slots filled → file (relative to raw/) → JSON lines in append order.
 * Pure: items in, strings out.
 */
export function rawFiles(items: readonly RenderedItem[], opts: FillOpts = {}): Map<string, string[]> {
  const byId = new Map(items.map((i) => [i.id, i]));
  const calls = callContents(items);
  const textMemo = new Map<string, string>();
  const textOf = (id: string, depth = 0): string => {
    const hit = textMemo.get(id);
    if (hit !== undefined) return hit;
    const it = byId.get(id);
    if (!it) throw new Error(`fill source ${id} is not in the plan`);
    let t: string;
    if (it.rendered && it.text !== null) t = it.text;
    else if (it.render.mode === 'derived' && depth < 10) t = applyDerive(textOf(it.render.from, depth + 1), it.render.op);
    else if (opts.placeholder) t = opts.placeholder(it);
    else throw new Error(`${id} has no text yet — render the plan first`);
    textMemo.set(id, t);
    return t;
  };
  const copyMemo = new Map<string, ReturnType<typeof formatCopy>>();
  const copyOf = (id: string) => {
    let c = copyMemo.get(id);
    if (c) return c;
    const it = byId.get(id);
    if (!it?.meeting) throw new Error(`${id} is not a meeting copy`);
    const content = calls.get(it.meeting.call) ?? opts.placeholderCall?.(it);
    if (!content) throw new Error(`call ${it.meeting.call} has no rendered content — render the plan first`);
    copyMemo.set(id, (c = formatCopy(it, content)));
    return c;
  };
  const value = (f: Fill, rec: Record<string, unknown>): unknown => {
    if (f.part === 'text') return applyDerive(textOf(f.item), f.op ?? {});
    if (f.part === 'flatten') return meetingText(String(rec.title ?? ''), String(rec.summary ?? ''), Array.isArray(rec.next_steps) ? (rec.next_steps as string[]) : []);
    return copyOf(f.item)[f.part];
  };
  const files = new Map<string, { at: string; n: number; line: string }[]>();
  let n = 0;
  for (const it of items) {
    for (const l of it.lines) {
      const rec = structuredClone(l.record);
      for (const f of l.fill) setPath(rec, f.path, value(f, rec)); // in slot order: a meeting's `text` flattens last
      const list = files.get(l.file);
      const row = { at: l.at, n: n++, line: JSON.stringify(rec) };
      if (list) list.push(row);
      else files.set(l.file, [row]);
    }
  }
  const out = new Map<string, string[]>();
  for (const f of [...files.keys()].sort()) out.set(f, files.get(f)!.sort((a, b) => a.at.localeCompare(b.at) || a.n - b.n).map((x) => x.line));
  return out;
}

/** slack.users.json as slack/pull.ts caches users.list: per team, with its fetch time. */
export const slackUsersJson = (world: World): string => `${JSON.stringify({ [world.accounts.slackTeam]: { fetched_at: world.now, users: world.slackUsers } }, null, 2)}\n`;

export function writeRaw(rawDir: string, items: readonly RenderedItem[], world: World, opts: FillOpts = {}): { files: number; lines: number } {
  let lines = 0;
  const files = rawFiles(items, opts);
  for (const [file, rows] of files) {
    mkdirSync(dirname(join(rawDir, file)), { recursive: true });
    writeFileSync(join(rawDir, file), rows.length ? `${rows.join('\n')}\n` : '');
    lines += rows.length;
  }
  mkdirSync(join(rawDir, 'slack'), { recursive: true });
  writeFileSync(join(rawDir, 'slack', 'slack.users.json'), slackUsersJson(world));
  return { files: files.size, lines };
}

/** The GIVEN tenant (initiatives.json + annotations/) as files under `dir`; returns the paths written. */
export function writeTenant(dir: string, world: World): string[] {
  const out: string[] = [];
  for (const [path, content] of Object.entries(givenTenant(world))) {
    const p = join(dir, path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
    out.push(p);
  }
  return out;
}
