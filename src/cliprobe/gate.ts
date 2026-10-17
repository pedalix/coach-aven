// Pure: the rules that make the repository pin only probed CLI versions (design D8). The gate test
// (gate.test.ts) feeds it the committed state; a non-empty answer fails CI.
//   1. every probed version has a report where every contract scenario holds, and every recording
//      hashes as the report says;
//   2. every contract scenario the probe knows has a verdict in the report of every probed version;
//   3. the CLI versions the repository pins (the images' ARG default, .env.example) are probed.
import type { ReportJson } from './report.js';
import { rowId } from './types.js';

export interface GateInput {
  probed: readonly string[];
  reports: Record<string, ReportJson | undefined>;
  /** version → recording file → its committed text's SHA-256 (undefined: the file is missing). */
  hashes: Record<string, Record<string, string | undefined>>;
  contractIds: readonly string[];
  pins: { source: string; version: string | undefined }[];
}

export function gateProblems(g: GateInput): string[] {
  const out: string[] = [];
  if (!g.probed.length) out.push('the probed set is empty');
  for (const v of g.probed) {
    const r = g.reports[v];
    if (!r) {
      out.push(`${v}: no committed report (src/fixtures/cli/${v}/report.json)`);
      continue;
    }
    if (r.cli !== v) out.push(`${v}: the report is for ${r.cli}`);
    for (const s of r.scenarios) {
      const hash = g.hashes[v]?.[s.recording.file];
      if (hash === undefined) out.push(`${v}: ${s.recording.file} is missing`);
      else if (hash !== s.recording.sha256) out.push(`${v}: ${s.recording.file} changed after its report (hash mismatch)`);
      if (s.contract && s.verdict !== 'holds') out.push(`${v}: contract scenario ${rowId(s.id, s.variant)} does not hold (${s.verdict})`);
    }
    for (const id of g.contractIds) {
      if (!r.scenarios.some((s) => s.id === id && s.contract)) out.push(`${v}: contract scenario ${id} has no verdict — probe the version again`);
    }
  }
  for (const p of g.pins) {
    if (!p.version) out.push(`${p.source}: no CLI version found`);
    else if (!g.probed.includes(p.version)) out.push(`${p.source} pins Claude Code ${p.version}, which is not a probed version (${g.probed.join(', ') || 'none'})`);
  }
  return out;
}
