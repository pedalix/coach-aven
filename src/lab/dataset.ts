// Dataset IO for the bench (layout in types.ts). JSONL everywhere: append-friendly, diffable, and a
// torn last line from a killed labeller costs one row, not the file.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatasetMeta, GoldRow, GoldTier, TaskId, Unit, UnitKind } from './types.js';
import { UNIT_OF } from './types.js';

export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* torn line */
    }
  }
  return out;
}

export function writeJsonl(path: string, rows: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

export interface Dataset {
  dir: string;
  meta: DatasetMeta;
  units: Partial<Record<UnitKind, Unit[]>>;
  gold: Partial<Record<TaskId, GoldRow[]>>;
}

export function loadDataset(dir: string): Dataset {
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as DatasetMeta;
  const units: Dataset['units'] = {};
  for (const k of ['fragment', 'item', 'mention'] as UnitKind[]) {
    const rows = readJsonl<Unit>(join(dir, 'units', `${k}.jsonl`));
    if (rows.length) units[k] = rows;
  }
  const gold: Dataset['gold'] = {};
  for (const t of Object.keys(UNIT_OF) as TaskId[]) {
    const rows = readJsonl<GoldRow>(join(dir, 'gold', `${t}.jsonl`));
    if (rows.length) gold[t] = rows;
  }
  return { dir, meta, units, gold };
}

export function saveMeta(dir: string, meta: DatasetMeta): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
}

export function unitsFor(ds: Dataset, task: TaskId): Unit[] {
  return ds.units[UNIT_OF[task]] ?? [];
}

// Several tiers may label the same unit. The scorer wants ONE row per unit: the most trusted tier wins
// (human > synthetic > opus > model > rule); `tiers` restricts the pool (e.g. score on human only).
const TIER_RANK: Record<GoldTier, number> = { human: 0, synthetic: 1, opus: 2, model: 3, rule: 4 };

export function goldFor(ds: Dataset, task: TaskId, tiers?: GoldTier[]): Map<string, GoldRow> {
  const out = new Map<string, GoldRow>();
  for (const g of ds.gold[task] ?? []) {
    if (tiers && !tiers.includes(g.tier)) continue;
    const cur = out.get(g.id);
    if (!cur || TIER_RANK[g.tier] < TIER_RANK[cur.tier]) out.set(g.id, g);
  }
  return out;
}

export const dayOf = (u: Unit): string => ('day' in u ? (u as { day: string }).day : '');
