// Dreaming: a scheduled, memory-only consolidation pass (see docs/memory.md#dreaming). The
// agent tidies its OWN project auto memory; it must not touch code. The prompt and the
// log-digest extraction live here (tested) so the "no code" guardrail and the one-line digest
// can't silently drift.

import { memoryDir } from './memory.js';

// The dream turn prompt. A terse "consolidate your memory" instruction gives weak results —
// the agent has no idea where recent signal lives. This is a structured multi-phase pass
// (modelled on Claude Code's own dream prompt): orient on existing memory, MINE the session
// transcripts for recent signal, consolidate into topic files with Why/How, then prune the
// index. `cwd` is the session's working dir, from which both the memory dir and the transcript
// dir derive. Memory-only, with a hard "no code" guardrail (tools aren't sandbox-gated here, so
// this is a strong instruction, not enforcement).
export function dreamPrompt(cwd: string): string {
  const mem = memoryDir(cwd);
  const transcripts = mem.replace(/\/memory$/, ''); // sibling of memory/: where *.jsonl live
  return (
    `[Dreaming — memory consolidation] You are performing a *dream*: a reflective, MEMORY-ONLY ` +
    `pass over your project memory so future sessions orient fast. This is NOT a coding task — do ` +
    `NOT modify code, run builds, install anything, create branches, commit, or open PRs. You only ` +
    `read, and write/curate your memory files.\n\n` +
    `Your memory: ${mem}/ — MEMORY.md (the index) plus topic files.\n` +
    `Your recent session transcripts: ${transcripts}/*.jsonl — large JSONL; grep them NARROWLY, ` +
    `never read whole files.\n\n` +
    `Phase 1 — Orient\n` +
    `- \`ls ${mem}/\`; read MEMORY.md; skim existing topic files so you IMPROVE them rather than ` +
    `create near-duplicates.\n\n` +
    `Phase 2 — Gather recent signal (what's worth persisting, rough priority)\n` +
    `1. Recent transcripts — grep for narrow terms about recent work (decisions made, bugs fixed, ` +
    `errors hit, conventions/commands discovered, area names): ` +
    `\`grep -rn "<term>" ${transcripts}/ --include=*.jsonl | tail -50\`. Look only for things you ` +
    `already suspect matter; don't read whole files.\n` +
    `2. Drifted memories — existing facts that now contradict the codebase; open the relevant ` +
    `files to confirm before trusting old notes.\n` +
    `3. The repos themselves — verify architecture/conventions you're about to record.\n\n` +
    `Phase 3 — Consolidate\n` +
    `For each durable thing, write or update a topic file at the top level of ${mem}/. Lead with ` +
    `the fact or decision, then a "*Why:*" line (the motivation/constraint) and a "*How to apply:*" ` +
    `line (how it should shape future work). Merge new signal into existing topic files instead of ` +
    `near-duplicates. Convert relative dates ("yesterday") to absolute (YYYY-MM-DD). If today's ` +
    `reality contradicts an old memory, fix it at the source file (not just the index) or delete it.\n\n` +
    `Phase 4 — Prune & index\n` +
    `Keep MEMORY.md a true INDEX: under ~200 lines and ~25KB, one line per entry — ` +
    `\`- [Title](file.md) — one-line hook\` (≤ ~150 chars), never memory content inline. Remove ` +
    `pointers to stale/superseded memories; if an index line carries detail, move it into the topic ` +
    `file and shorten the line; add pointers to new memories.\n\n` +
    `Reconcile against CLAUDE.md\n` +
    `The repo's CLAUDE.md is the maintained, checked-in source. If a memory contradicts CLAUDE.md ` +
    `on the same task, the memory is stale — delete it or rewrite it to agree (keep the *why* if ` +
    `still useful). Do NOT edit CLAUDE.md during a dream.\n\n` +
    `Be conservative: don't delete anything you're unsure about. End with a one-line summary of ` +
    `what you consolidated, updated, or pruned (or say memories were already tight if nothing changed).`
  );
}

// Reduce a dream's output to a single log line: first non-empty line, markdown stripped,
// capped. Used for the journal log + the routine's stored digest (visibility, no channel noise).
export function dreamDigest(text: string, max = 200): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? 'no changes';
  const stripped = line.replace(/[*_`#>~[\]()]/g, '');
  return stripped.length > max ? `${stripped.slice(0, max - 1)}…` : stripped;
}
