#!/usr/bin/env -S npx tsx
// Turn captured event-journal lines into committable twin fixtures.
//
//   scripts/pull-fixtures.sh | npx tsx scripts/scrub-fixtures.ts
//
// Reads eventlog JSONL (AVEN_EVENT_LOG=full records, i.e. with `raw`) on stdin, keeps the
// FIRST envelope per (kind, subtype), scrubs it (src/fixtures.ts — by shape, not by
// blacklist), and writes src/fixtures/<kind>[.<subtype>].json. Never run it on unscrubbed
// output paths; never commit anything from tmp. The scrubber's own tests are the guarantee
// that no id, token, name, URL or message text survives — but eyeball a new fixture once
// anyway before the first commit of a new kind.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scrubEnvelope } from '../src/fixtures.js';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'fixtures');

interface JournalLine {
  at: string;
  kind: string;
  subtype?: string;
  raw?: Record<string, unknown>;
}

// view_submission lines carry no `subtype` in the journal — the callback_id is the
// natural discriminator; commands carry the slash command itself.
function subtypeOf(l: JournalLine): string | undefined {
  if (l.subtype) return l.subtype.replace(/^\//, '');
  const raw = l.raw ?? {};
  const view = raw.view as Record<string, unknown> | undefined;
  if (typeof view?.callback_id === 'string') return view.callback_id;
  if (typeof raw.command === 'string') return raw.command.replace(/^\//, '');
  return undefined;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const seen = new Set<string>();
  let written = 0;
  mkdirSync(OUT_DIR, { recursive: true });
  for (const line of input.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let l: JournalLine;
    try {
      l = JSON.parse(t) as JournalLine;
    } catch {
      continue;
    }
    if (!l.raw || !l.kind) continue;
    const subtype = subtypeOf(l);
    const stem = subtype ? `${l.kind}.${subtype}` : l.kind;
    if (seen.has(stem)) continue;
    seen.add(stem);
    const fixture = scrubEnvelope(l.raw, { kind: l.kind, subtype, capturedOn: l.at.slice(0, 10) });
    writeFileSync(join(OUT_DIR, `${stem}.json`), JSON.stringify(fixture, null, 2) + '\n');
    written++;
    console.error(`wrote ${stem}.json  roles=${JSON.stringify(fixture.roles)}`);
  }
  console.error(`${written} fixture(s) → ${OUT_DIR}`);
});
