// Quarterly hygiene: did any secret reach what the model can see? (`orch sources audit <slug>`)
//
// Rule of the house: secrets only, no guarantees, so compensate with hygiene — run this over a
// project's raw archive and replica and (optionally) the bot's event log, which is the exact
// record of everything that went to the model. Three parts:
//   1. our own detectors (src/scrub.ts) over every string field of every JSONL record — an
//      `exact` finding here means the scrubber at write time missed it, or the data bypassed
//      the scrubber (new writer, hand-copied file);
//   2. gitleaks, if installed, as an independent second opinion over the same directories;
//   3. the gold set (src/fixtures/scrub-gold.jsonl): planted secrets with known values → recall
//      per detector kind, so a change to the rules is measured, not felt.
// Nothing here ever prints a secret value: kind + hash6 + file:line only. Exit 1 when real
// data has a hit, so a scheduler can page. Every miss found by hand or by gitleaks goes into
// the gold set AND the canary fixture, which is how the number improves over time.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hash6, scrubText, type Finding } from '../scrub.js';

export const DEFAULT_GOLD = new URL('../fixtures/scrub-gold.jsonl', import.meta.url).pathname;

export interface Hit {
  file: string;
  line: number;
  field: string;
  kind: string;
  confidence: Finding['confidence'];
  hash6: string;
}

// Walk every string in a parsed JSONL record (nested objects/arrays included: Slack blocks,
// Graph bodies) and run the detectors. `path` is the dotted field name for the report.
export function scanRecord(rec: unknown, file: string, line: number, path = ''): Hit[] {
  const hits: Hit[] = [];
  if (typeof rec === 'string') {
    for (const f of scrubText(rec).findings) {
      hits.push({ file, line, field: path || '$', kind: f.kind, confidence: f.confidence, hash6: f.hash6 });
    }
  } else if (Array.isArray(rec)) {
    rec.forEach((v, i) => hits.push(...scanRecord(v, file, line, `${path}[${i}]`)));
  } else if (rec && typeof rec === 'object') {
    for (const [k, v] of Object.entries(rec as Record<string, unknown>)) {
      // The scrubber's own markers are not secrets; the `scrub` meta block describes what was removed.
      if (k === 'scrub' || k === 'raw_ref' || k === 'permalink' || k === 'link') continue;
      hits.push(...scanRecord(v, file, line, path ? `${path}.${k}` : k));
    }
  }
  return hits;
}

export function scanJsonl(file: string, text: string): { hits: Hit[]; records: number; malformed: number } {
  const hits: Hit[] = [];
  let records = 0;
  let malformed = 0;
  text.split('\n').forEach((raw, i) => {
    if (!raw.trim()) return;
    try {
      hits.push(...scanRecord(JSON.parse(raw), file, i + 1));
      records++;
    } catch {
      malformed++;
    }
  });
  return { hits, records, malformed };
}

export interface GoldRow {
  id: string;
  subject?: string;
  text: string;
  secrets: string[];
}

export interface GoldReport {
  total: number;
  caught: number;
  missed: { id: string; hash6: string }[];
  perKind: Record<string, { caught: number }>;
}

// Recall on the gold set: a planted secret counts as caught when it no longer appears in the
// scrubbed output; the kind credited is the finding whose span covered the secret's position.
export function goldRecall(rows: GoldRow[]): GoldReport {
  const report: GoldReport = { total: 0, caught: 0, missed: [], perKind: {} };
  for (const row of rows) {
    const input = `${row.subject ?? ''}\n${row.text}`;
    const { text, findings } = scrubText(input);
    for (const secret of row.secrets) {
      report.total++;
      const stillThere = text.includes(secret) || text.includes(secret.replace(/\s+/g, ''));
      if (stillThere) {
        report.missed.push({ id: row.id, hash6: hash6(secret) });
        continue;
      }
      report.caught++;
      const pos = input.indexOf(secret);
      const f = findings.find((x) => pos >= 0 && x.start <= pos && x.end >= pos + Math.min(secret.length, 4));
      const kind = f?.kind ?? 'covered-by-other';
      report.perKind[kind] = { caught: (report.perKind[kind]?.caught ?? 0) + 1 };
    }
  }
  return report;
}

interface GitleaksFinding {
  RuleID: string;
  File: string;
  StartLine: number;
  Secret?: string;
}

// gitleaks writes its report to a file and exits 1 when it finds something — both are normal
// here. We re-hash the secret ourselves so the printed line is comparable with our hits.
export function parseGitleaks(json: string): Hit[] {
  const arr = JSON.parse(json) as GitleaksFinding[];
  return arr.map((g) => ({
    file: g.File,
    line: g.StartLine,
    field: 'gitleaks',
    kind: `gitleaks:${g.RuleID}`,
    confidence: 'exact' as const,
    hash6: g.Secret ? hash6(g.Secret) : '------',
  }));
}

function listJsonl(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function runGitleaks(dir: string): Hit[] | null {
  try {
    execFileSync('gitleaks', ['version'], { stdio: 'ignore' });
  } catch {
    return null;
  }
  const report = join(dir, `.gitleaks-${process.pid}.json`);
  try {
    execFileSync('gitleaks', ['detect', '--no-git', '--source', dir, '--report-format', 'json', '--report-path', report, '--exit-code', '0'], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const hits = parseGitleaks(readFileSync(report, 'utf8') || '[]');
    execFileSync('rm', ['-f', report]);
    return hits;
  } catch (e) {
    console.error(`gitleaks failed on ${dir}: ${(e as Error).message}`);
    return [];
  }
}

export interface AuditOptions {
  dirs: string[];
  gold?: string;
  gitleaks?: boolean;
  out?: (line: string) => void;
}

/** Scan dirs + gold set; returns the exit code (1 = a real hit or a gold miss). */
export function runAudit(o: AuditOptions): number {
  const out = o.out ?? ((l: string) => console.log(l));
  const gold = o.gold ?? DEFAULT_GOLD;
  const useGitleaks = o.gitleaks ?? true;

  // 1 + 2: real data
  let exact = 0;
  let likely = 0;
  let records = 0;
  for (const dir of o.dirs) {
    if (!existsSync(dir)) {
      out(`note ${dir} does not exist — skipped`);
      continue;
    }
    for (const f of listJsonl(dir)) {
      const r = scanJsonl(f, readFileSync(f, 'utf8'));
      records += r.records;
      for (const h of r.hits) {
        if (h.confidence === 'exact') exact++;
        else likely++;
        out(`${h.confidence === 'exact' ? 'HIT ' : 'warn'} ${h.kind} ${h.hash6} ${h.file}:${h.line} ${h.field}`);
      }
      if (r.malformed) out(`note malformed lines in ${f}: ${r.malformed}`);
    }
    if (useGitleaks) {
      const g = runGitleaks(dir);
      if (g === null) out('note gitleaks not on PATH — second opinion skipped (brew install gitleaks / apt install gitleaks)');
      else for (const h of g) {
        exact++;
        out(`HIT  ${h.kind} ${h.hash6} ${h.file}:${h.line}`);
      }
    }
  }

  // 3: gold set
  let goldReport: GoldReport | null = null;
  try {
    const rows = readFileSync(gold, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as GoldRow);
    goldReport = goldRecall(rows);
  } catch (e) {
    out(`note gold set unreadable (${gold}): ${(e as Error).message}`);
  }

  out('');
  out(`records scanned: ${records} in ${o.dirs.length} dir(s); exact hits: ${exact}; likely: ${likely}`);
  if (goldReport) {
    const pct = goldReport.total ? Math.round((100 * goldReport.caught) / goldReport.total) : 0;
    out(`gold recall: ${goldReport.caught}/${goldReport.total} (${pct}%)` + (goldReport.missed.length ? ` — MISSED: ${goldReport.missed.map((m) => `${m.id}:${m.hash6}`).join(', ')}` : ''));
    for (const [k, v] of Object.entries(goldReport.perKind).sort()) out(`  ${k.padEnd(18)} ${v.caught}`);
  }
  return exact > 0 || (goldReport?.missed.length ?? 0) > 0 ? 1 : 0;
}
