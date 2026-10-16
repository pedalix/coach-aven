// Case keys the store knows better than a fragment id: every recorder copy of one call (Granola + Gemini of
// the same meeting) and every topic of it share `call:<call_id>`, so the dev/test split and a question both
// treat the call as one thing. Without it the two copies of a call — judged once by Owen — can land on
// opposite sides of the split and leak the answer into the threshold that is then scored on it.
//
// Runs over an exported dataset in place (units/fragment.jsonl), read-only on its store.sqlite; the exporter
// calls it at the end of every export.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readJsonl, writeJsonl } from './dataset.js';
import type { FragmentUnit } from './types.js';

// meeting:<source>:<id> → call:<call_id>, from the store's meetings table (null when the store has no calls).
export function callCases(storePath: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(storePath)) return out;
  const db = new DatabaseSync(storePath, { readOnly: true });
  try {
    const cols = db.prepare("SELECT name FROM pragma_table_info('meetings')").all() as { name: string }[];
    if (!cols.some((c) => c.name === 'call_id')) return out;
    for (const r of db.prepare('SELECT source, id, call_id FROM meetings WHERE call_id IS NOT NULL').all() as { source: string; id: string; call_id: string }[]) {
      out.set(`meeting:${r.source}:${r.id}`, `call:${r.call_id}`);
    }
  } finally {
    db.close();
  }
  return out;
}

export function annotateCases(dir: string): { fragments: number; annotated: number } {
  const file = join(dir, 'units', 'fragment.jsonl');
  const units = readJsonl<FragmentUnit>(file);
  if (!units.length) return { fragments: 0, annotated: 0 };
  const calls = callCases(join(dir, 'store.sqlite'));
  let annotated = 0;
  for (const u of units) {
    if (u.kind !== 'call') continue;
    const c = u.refs.map((r) => calls.get(r)).find(Boolean);
    if (c) {
      u.case = c;
      annotated++;
    }
  }
  writeJsonl(file, units);
  return { fragments: units.length, annotated };
}

export async function main(argv: string[]): Promise<void> {
  const base = process.env.LAB_DIR || 'data/lab';
  for (const name of argv.filter((a) => !a.startsWith('-'))) {
    const dir = name.includes('/') ? name : join(base, 'datasets', name);
    const r = annotateCases(dir);
    console.log(`${name}: ${r.annotated} of ${r.fragments} fragments carry a call case`);
  }
}
