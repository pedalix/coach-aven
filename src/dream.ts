// Dreaming: a scheduled, memory-only consolidation pass (see docs/memory.md#dreaming). The
// agent tidies its OWN project auto memory; it must not touch code. The pure framing text and
// the log-digest extraction live here (tested) so the "no code" guardrail and the one-line
// digest can't silently drift.

// Prepended to a dream turn. Memory-only, with a hard "no code" guardrail. Tools aren't
// sandbox-gated, so this is a strong instruction, not enforcement (mirrors REPORT_FRAMING).
export const DREAM_FRAMING =
  '[Dreaming — memory maintenance] Do NOT modify code, run builds, create branches, commit, ' +
  'or open PRs. Your only job is to curate your own project memory: review MEMORY.md and your ' +
  'memory topic files alongside recent work, consolidate and merge duplicates, prune obsolete ' +
  'or wrong entries, and record durable learnings — keeping MEMORY.md a concise, accurate ' +
  'index (aim well under 200 lines). Be conservative: do not delete anything you are unsure ' +
  'about. End with a one-line summary of what you changed.\n\n';

// Reduce a dream's output to a single log line: first non-empty line, markdown stripped,
// capped. Used for the journal log + the routine's stored digest (visibility, no channel noise).
export function dreamDigest(text: string, max = 200): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? 'no changes';
  const stripped = line.replace(/[*_`#>~[\]()]/g, '');
  return stripped.length > max ? `${stripped.slice(0, max - 1)}…` : stripped;
}
