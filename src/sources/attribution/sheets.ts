// The tenant's client sheets (`annotations/sheets.json`) and what was handed in (`ledger/submitted.jsonl`) — data only,
// validated here at build and stored for the sources MCP's `timesheet` readout (sync_state `att:sheets`,
// `att:submitted`). The MCP trusts what it reads, so every check lives here; a broken file never costs the layer its
// build: it is stored as `{error}` and the readout says it, naming the sheet and the rule.
//
// annotations/sheets.json:
//   { "sheets": [ {
//       "id": "northwind",                        what the person and the tool call it
//       "umbrella": "northwind",                  only billable evidence routed to this umbrella enters the sheet
//       "unit": "hour" | "half_day", "unitMinutes": 240,   minutes per unit (hour 60, half_day 240 by default)
//       "step": 1,                                rounding step in units, per row; each project's period total is the
//                                                 rounded total, spread over its rows by largest remainder
//       "columns": ["date", "comment", "project", "who", "units"],   the paste order; "skip" = a column the
//                                                 sheet fills itself (a formula)
//       "who": "Jane", "dateFormat": "DD/MM/YYYY",
//       "comment": { "language": "en", "style": "one line, what was done" },   for the agent: the platform writes none
//       "layout": { "weekends": "keep" | "shift", "maxUnitsPerDay": 2 },
//       "monthRange": { "min": 24, "max": 30 },   units a calendar month should bill: above max the month's rows
//                                                 shrink to it (largest remainder), below min the readout says by how
//                                                 much — it never pads
//       "projects": [ rules, first match wins ] } ] }
//
// A rule maps evidence to one sheet project — exactly one of:
//   "project": "shop-north"          that project;
//   "projectFrom": "billing_code"    the initiative's billing code (a sheet whose projects are the codes);
//   "sameDay": true                  the project an EARLIER explicit rule gave the same initiative's evidence that day
//                                    (most minutes); none that day → the rule does not apply and the next one is tried.
// Optional, AND-ed: "initiative": id | [ids] (of the umbrella; absent = any), "match": { "keys": tracker key prefixes,
// "repos": repo tails ("org/repo", "repo", `*` glob), "containers": channels or folders, exact, "title": a
// case-insensitive regular expression over the evidence title }.
import type { RegistryData } from './registry.js';

export type SheetColumn = 'date' | 'comment' | 'project' | 'who' | 'units' | 'skip';
export const SHEET_COLUMNS: readonly SheetColumn[] = ['date', 'comment', 'project', 'who', 'units', 'skip'];
export const DATE_FORMATS = ['YYYY-MM-DD', 'DD/MM/YYYY', 'DD.MM.YYYY', 'MM/DD/YYYY'] as const;

export interface SheetRule {
  project?: string;
  projectFrom?: 'billing_code';
  sameDay?: true;
  initiatives?: string[];
  match?: { keys?: string[]; repos?: string[]; containers?: string[]; title?: string };
}

export interface Sheet {
  id: string;
  umbrella: string;
  unit: 'hour' | 'half_day';
  unitMinutes: number;
  step: number;
  columns: SheetColumn[];
  who?: string;
  dateFormat: (typeof DATE_FORMATS)[number];
  comment: { language: string; style?: string };
  layout: { weekends: 'keep' | 'shift'; maxUnitsPerDay?: number };
  monthRange?: { min?: number; max?: number };
  projects: SheetRule[];
}

/** One handed-in sheet period (the last line per id wins). */
export interface Submitted {
  id: string;
  sheet: string;
  since: string;
  until: string;
  submitted_at?: string;
  by?: string;
  rows: { date: string; project: string; units: number; comment?: string }[];
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strList = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.length > 0);
const posNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isDay = (v: unknown): v is string => typeof v === 'string' && DAY_RE.test(v) && !Number.isNaN(Date.parse(v));

function unknownKeys(o: Record<string, unknown>, allowed: string[], w: string): void {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`${w}: unknown key${extra.length > 1 ? 's' : ''} ${extra.map((k) => `"${k}"`).join(', ')}`);
}

function parseRule(raw: unknown, w: string, umbrellaIds: Set<string>, umbrella: string): SheetRule {
  if (!isObj(raw)) throw new Error(`${w} must be an object`);
  unknownKeys(raw, ['project', 'projectFrom', 'sameDay', 'initiative', 'match'], w);
  const kinds = [raw.project !== undefined, raw.projectFrom !== undefined, raw.sameDay !== undefined].filter(Boolean).length;
  if (kinds !== 1) throw new Error(`${w}: exactly one of "project", "projectFrom" or "sameDay"`);
  const out: SheetRule = {};
  if (raw.project !== undefined) {
    if (typeof raw.project !== 'string' || !raw.project.trim()) throw new Error(`${w}: "project" must be a non-empty string`);
    out.project = raw.project;
  }
  if (raw.projectFrom !== undefined) {
    if (raw.projectFrom !== 'billing_code') throw new Error(`${w}: "projectFrom" must be "billing_code"`);
    out.projectFrom = 'billing_code';
  }
  if (raw.sameDay !== undefined) {
    if (raw.sameDay !== true) throw new Error(`${w}: "sameDay" must be true`);
    out.sameDay = true;
  }
  if (raw.initiative !== undefined) {
    const ids = typeof raw.initiative === 'string' ? [raw.initiative] : raw.initiative;
    if (!strList(ids)) throw new Error(`${w}: "initiative" must be an initiative id or a list of them`);
    for (const id of ids) if (!umbrellaIds.has(id)) throw new Error(`${w}: initiative "${id}" is not in the registry under umbrella "${umbrella}"`);
    out.initiatives = [...ids];
  }
  if (raw.match !== undefined) {
    const m = raw.match;
    if (!isObj(m)) throw new Error(`${w}: "match" must be an object`);
    unknownKeys(m, ['keys', 'repos', 'containers', 'title'], `${w}.match`);
    const match: NonNullable<SheetRule['match']> = {};
    for (const k of ['keys', 'repos', 'containers'] as const) {
      if (m[k] === undefined) continue;
      if (!strList(m[k])) throw new Error(`${w}.match: "${k}" must be a non-empty list of strings`);
      match[k] = [...(m[k] as string[])];
    }
    if (m.title !== undefined) {
      if (typeof m.title !== 'string' || !m.title) throw new Error(`${w}.match: "title" must be a regular expression`);
      try {
        new RegExp(m.title, 'i');
      } catch (e) {
        throw new Error(`${w}.match: "title" is not a valid regular expression: ${e instanceof Error ? e.message : String(e)}`);
      }
      match.title = m.title;
    }
    if (!Object.keys(match).length) throw new Error(`${w}: an empty "match" — leave it out to match everything`);
    out.match = match;
  }
  return out;
}

/** Throws with the sheet (and rule) named. `registry` gives the umbrella's initiatives and their billing codes. */
export function parseSheets(raw: unknown, registry: RegistryData, where = 'annotations/sheets.json'): Sheet[] {
  if (!isObj(raw) || !Array.isArray(raw.sheets)) throw new Error(`${where}: expected {"sheets": [...]}`);
  unknownKeys(raw, ['sheets'], where);
  const seen = new Set<string>();
  return raw.sheets.map((s, i) => {
    const w0 = `${where}: sheets[${i}]`;
    if (!isObj(s)) throw new Error(`${w0} must be an object`);
    if (typeof s.id !== 'string' || !ID_RE.test(s.id)) throw new Error(`${w0}: "id" must be a lowercase id like "northwind"`);
    if (seen.has(s.id)) throw new Error(`${w0}: sheet "${s.id}" is defined twice`);
    seen.add(s.id);
    const w = `${where}: sheet "${s.id}"`;
    unknownKeys(s, ['id', 'umbrella', 'unit', 'unitMinutes', 'step', 'columns', 'who', 'dateFormat', 'comment', 'layout', 'monthRange', 'projects'], w);
    if (typeof s.umbrella !== 'string' || !s.umbrella) throw new Error(`${w}: "umbrella" is required`);
    const umbrella = s.umbrella;
    const umbrellaIds = new Set(registry.initiatives.filter((x) => x.umbrella === umbrella).map((x) => x.id));
    if (!umbrellaIds.size) throw new Error(`${w}: no initiative in the registry has umbrella "${umbrella}"`);
    if (s.unit !== 'hour' && s.unit !== 'half_day') throw new Error(`${w}: "unit" must be "hour" or "half_day"`);
    if (s.unitMinutes !== undefined && !posNum(s.unitMinutes)) throw new Error(`${w}: "unitMinutes" must be a positive number`);
    if (s.step !== undefined && !posNum(s.step)) throw new Error(`${w}: "step" must be a positive number`);
    const columns = s.columns ?? ['date', 'project', 'units', 'comment'];
    if (!Array.isArray(columns) || columns.some((c) => !SHEET_COLUMNS.includes(c as SheetColumn))) throw new Error(`${w}: "columns" must list ${SHEET_COLUMNS.map((c) => `"${c}"`).join(', ')}`);
    for (const need of ['date', 'project', 'units'] as const) if (!columns.includes(need)) throw new Error(`${w}: "columns" must include "${need}"`);
    if (s.who !== undefined && (typeof s.who !== 'string' || !s.who)) throw new Error(`${w}: "who" must be a non-empty string`);
    if (columns.includes('who') && s.who === undefined) throw new Error(`${w}: the "who" column needs "who"`);
    if (s.dateFormat !== undefined && !DATE_FORMATS.includes(s.dateFormat as (typeof DATE_FORMATS)[number])) throw new Error(`${w}: "dateFormat" must be one of ${DATE_FORMATS.join(', ')}`);
    const c = s.comment ?? {};
    if (!isObj(c)) throw new Error(`${w}: "comment" must be an object`);
    unknownKeys(c, ['language', 'style'], `${w}.comment`);
    if (c.language !== undefined && (typeof c.language !== 'string' || !c.language)) throw new Error(`${w}.comment: "language" must be a language code`);
    if (c.style !== undefined && typeof c.style !== 'string') throw new Error(`${w}.comment: "style" must be a string`);
    const l = s.layout ?? {};
    if (!isObj(l)) throw new Error(`${w}: "layout" must be an object`);
    unknownKeys(l, ['weekends', 'maxUnitsPerDay'], `${w}.layout`);
    if (l.weekends !== undefined && l.weekends !== 'keep' && l.weekends !== 'shift') throw new Error(`${w}.layout: "weekends" must be "keep" or "shift"`);
    if (l.maxUnitsPerDay !== undefined && !posNum(l.maxUnitsPerDay)) throw new Error(`${w}.layout: "maxUnitsPerDay" must be a positive number`);
    if (!Array.isArray(s.projects) || !s.projects.length) throw new Error(`${w}: "projects" must be a non-empty list of rules`);
    const projects = s.projects.map((r, j) => parseRule(r, `${w} projects[${j}]`, umbrellaIds, umbrella));
    // A catch-all (no match, not sameDay) shadows every later rule over the same initiatives: say so instead of
    // leaving a rule that can never fire.
    projects.forEach((r, j) => {
      const covered = projects.slice(0, j).find((p) => !p.match && !p.sameDay && (!p.initiatives || (r.initiatives ?? [...umbrellaIds]).every((id) => p.initiatives!.includes(id))));
      if (covered) throw new Error(`${w} projects[${j}]: unreachable — projects[${projects.indexOf(covered)}] already takes all of its evidence`);
    });
    const unit = s.unit;
    const step = (s.step as number | undefined) ?? (unit === 'half_day' ? 0.5 : 0.1);
    const max = l.maxUnitsPerDay as number | undefined;
    const onStep = (x: number) => Math.abs(x / step - Math.round(x / step)) < 1e-9;
    if (max !== undefined && !onStep(max)) throw new Error(`${w}.layout: "maxUnitsPerDay" must be a multiple of "step" (${step})`);
    let monthRange: Sheet['monthRange'];
    if (s.monthRange !== undefined) {
      const r = s.monthRange;
      if (!isObj(r)) throw new Error(`${w}: "monthRange" must be an object like {"min": 24, "max": 30}`);
      unknownKeys(r, ['min', 'max'], `${w}.monthRange`);
      for (const k of ['min', 'max'] as const) if (r[k] !== undefined && (typeof r[k] !== 'number' || !Number.isFinite(r[k] as number) || (r[k] as number) < 0 || !onStep(r[k] as number))) throw new Error(`${w}.monthRange: "${k}" must be a number ≥ 0 and a multiple of "step" (${step})`);
      if (r.min === undefined && r.max === undefined) throw new Error(`${w}.monthRange: give "min", "max" or both`);
      if (r.min !== undefined && r.max !== undefined && (r.min as number) > (r.max as number)) throw new Error(`${w}.monthRange: "min" must not exceed "max"`);
      monthRange = { ...(r.min !== undefined ? { min: r.min as number } : {}), ...(r.max !== undefined ? { max: r.max as number } : {}) };
    }
    return {
      id: s.id,
      umbrella,
      unit,
      unitMinutes: (s.unitMinutes as number | undefined) ?? (unit === 'half_day' ? 240 : 60),
      step,
      columns: columns as SheetColumn[],
      ...(s.who !== undefined ? { who: s.who as string } : {}),
      dateFormat: (s.dateFormat as Sheet['dateFormat'] | undefined) ?? 'YYYY-MM-DD',
      comment: { language: (c.language as string | undefined) ?? 'en', ...(c.style !== undefined ? { style: c.style as string } : {}) },
      layout: { weekends: (l.weekends as 'keep' | 'shift' | undefined) ?? 'keep', ...(max !== undefined ? { maxUnitsPerDay: max } : {}) },
      ...(monthRange ? { monthRange } : {}),
      projects,
    };
  });
}

/** The sheets as the build stores them: the parsed list, or the error that names what to fix. */
export function sheetsForStore(text: string, registry: RegistryData): { sheets: Sheet[] } | { error: string } {
  try {
    return { sheets: parseSheets(JSON.parse(text), registry) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * ledger/submitted.jsonl → the handed-in periods, the last line per id winning (a corrected resubmission replaces).
 * A malformed line is reported by its number and skipped — one typo never hides the rest of the ledger.
 */
export function parseSubmitted(text: string, where = 'ledger/submitted.jsonl'): { periods: Submitted[]; errors: string[] } {
  const byId = new Map<string, Submitted>();
  const errors: string[] = [];
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    const w = `${where}:${i + 1}`;
    let r: unknown;
    try {
      r = JSON.parse(line);
    } catch {
      errors.push(`${w}: not JSON`);
      return;
    }
    if (!isObj(r)) return void errors.push(`${w}: expected an object`);
    if (typeof r.id !== 'string' || !r.id) return void errors.push(`${w}: "id" is required`);
    if (typeof r.sheet !== 'string' || !r.sheet) return void errors.push(`${w}: "sheet" is required`);
    if (!isDay(r.since) || !isDay(r.until) || r.since > r.until) return void errors.push(`${w}: "since"/"until" must be YYYY-MM-DD, since ≤ until`);
    if (!Array.isArray(r.rows)) return void errors.push(`${w}: "rows" must be an array`);
    const rows: Submitted['rows'] = [];
    for (const [j, x] of r.rows.entries()) {
      if (!isObj(x) || !isDay(x.date) || typeof x.project !== 'string' || typeof x.units !== 'number' || !Number.isFinite(x.units) || x.units < 0) return void errors.push(`${w}: rows[${j}] needs date (YYYY-MM-DD), project and units ≥ 0`);
      if (x.date < (r.since as string) || x.date > (r.until as string)) return void errors.push(`${w}: rows[${j}] ${x.date} is outside ${r.since}..${r.until}`);
      rows.push({ date: x.date, project: x.project, units: x.units, ...(typeof x.comment === 'string' ? { comment: x.comment } : {}) });
    }
    byId.set(r.id, { id: r.id, sheet: r.sheet, since: r.since as string, until: r.until as string, ...(typeof r.submitted_at === 'string' ? { submitted_at: r.submitted_at } : {}), ...(typeof r.by === 'string' ? { by: r.by } : {}), rows });
  });
  return { periods: [...byId.values()].sort((a, b) => a.since.localeCompare(b.since) || a.id.localeCompare(b.id)), errors };
}
