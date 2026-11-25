// Company brain: the nightly tidy (design D9) — the one upkeep pass over a project's memory. The host decides,
// from the lint alone, whether a project needs a turn tonight; a model then resolves the findings it is given, in
// memory only. Pure: which findings are due (the three-run rule), the night's share, the prompt, and the state
// that carries the counts and the `CLAUDE.md` digests between nights (`brain/<slug>/tidy.json`, written by
// store.ts).

import { sha256, type BrainIndex } from './index.js';
import { tidyShare, type Finding } from './lint.js';

export const TIDY_RUNS = 3; // a finding given to this many tidies and still there no longer starts one

export interface TidyState {
  // Per finding (code + records): how many tidies it was given to, and the records' content right after the last
  // one. Content that differs now means someone else changed the record since — the finding is due again.
  given: Record<string, { n: number; hash: string }>;
  // Each repository's `CLAUDE.md` digest as the last tidy saw it (the first one noted is the baseline).
  instructions: Record<string, string>;
  // The digests the last mirror read. The "changed" finding is judged from these two maps, never from a lint
  // file a failed mirror left stale — and a tidy whose own mirror failed still settles the finding with them.
  seen?: Record<string, string>;
  lastDay?: string; // the local day the nightly check last settled this project (ran a tidy, or found none due)
}

export const TIDY_HOUR = 3; // installation time: the low-traffic hour

/** The local day's key while the tidy hour lasts (a busy project is retried inside it), else undefined. */
export const tidyDay = (p: { ho: number; dom: number; mon: number }): string | undefined =>
  p.ho === TIDY_HOUR ? `${String(p.mon).padStart(2, '0')}-${String(p.dom).padStart(2, '0')}` : undefined;

export const emptyTidyState = (): TidyState => ({ given: {}, instructions: {} });

export const findingKey = (f: Finding): string => `${f.code}:${f.records.join(',')}`;

/** The content of the records a finding names, as one digest (a record that is gone counts as empty). */
export function recordsHash(f: Finding, index: BrainIndex): string {
  const by = new Map(index.records.map((r) => [r.name, r.hash]));
  return sha256(f.records.map((n) => by.get(n) ?? '').join('\n'));
}

/** How many tidies a finding was already given to, on the records as they are now. */
export function timesGiven(f: Finding, index: BrainIndex, state: TidyState): number {
  const e = state.given[findingKey(f)];
  return e && e.hash === recordsHash(f, index) ? e.n : 0;
}

/** The findings that may start a tidy: every one not yet given to TIDY_RUNS tidies on its present content. */
export function dueFindings(findings: readonly Finding[], index: BrainIndex, state: TidyState): Finding[] {
  // A changed CLAUDE.md is cleared by the tidy that was given it (endTidy), so it is never counted — and it is
  // due only while the state itself says a file differs, whatever a stale lint still lists.
  return findings.filter((f) => (f.code === 'instructions-changed' ? changedInstructions(state).length > 0 : timesGiven(f, index, state) < TIDY_RUNS));
}

/** The repositories whose `CLAUDE.md`, as the last mirror read it, differs from the one the last tidy saw. */
export function changedInstructions(state: TidyState): string[] {
  return Object.entries(state.seen ?? {})
    .filter(([path, digest]) => state.instructions[path] !== undefined && state.instructions[path] !== digest)
    .map(([path]) => path)
    .sort();
}

/** Tonight's share and what each finding had been given before — endTidy needs the counts from before the run. */
export function startTidy(findings: readonly Finding[], index: BrainIndex, state: TidyState): { share: Finding[]; prior: Record<string, number> } {
  const share = tidyShare(dueFindings(findings, index, state));
  return { share, prior: Object.fromEntries(share.map((f) => [findingKey(f), timesGiven(f, index, state)])) };
}

/**
 * The state after a tidy: a given finding that is still listed counts one more, on the records as the tidy left
 * them (so its own edits do not make the finding due again); entries for findings no longer listed are dropped;
 * the `CLAUDE.md` digests become the ones the tidy saw.
 */
export function endTidy(
  state: TidyState,
  run: { share: readonly Finding[]; prior: Readonly<Record<string, number>> },
  after: { index: BrainIndex; findings: readonly Finding[]; instructions?: Readonly<Record<string, string>> },
  day: string,
): TidyState {
  const listed = new Map(after.findings.map((f) => [findingKey(f), f]));
  const given: TidyState['given'] = {};
  for (const [key, e] of Object.entries(state.given)) if (listed.has(key)) given[key] = e;
  for (const f of run.share) {
    const key = findingKey(f);
    const still = listed.get(key);
    if (!still || f.code === 'instructions-changed') {
      delete given[key];
      continue;
    }
    given[key] = { n: (run.prior[key] ?? 0) + 1, hash: recordsHash(still, after.index) };
  }
  // The tidy that was given the finding has seen the file: its mirror's digests become the baseline — or, when
  // that mirror failed, the last ones noted, so a project whose mirror keeps failing is not tidied every night.
  const sawInstructions = run.share.some((f) => f.code === 'instructions-changed');
  const seen = after.instructions ? { ...after.instructions } : state.seen;
  return {
    given,
    instructions: sawInstructions && seen ? { ...seen } : state.instructions,
    ...(seen ? { seen } : {}),
    lastDay: day,
  };
}

/**
 * The repositories whose `CLAUDE.md` differs from the one the last tidy saw, and the state with a baseline for
 * every file noted for the first time (a first digest is never a finding). A file that is gone is dropped.
 */
export function instructionsChanged(state: TidyState, current: Readonly<Record<string, string>>): { changed: string[]; state: TidyState } {
  const instructions: Record<string, string> = {};
  const changed: string[] = [];
  for (const [path, digest] of Object.entries(current)) {
    const seen = state.instructions[path];
    instructions[path] = seen ?? digest;
    if (seen !== undefined && seen !== digest) changed.push(path);
  }
  return { changed: changed.sort(), state: { ...state, instructions, seen: { ...current } } };
}

// The tidy turn's prompt. Memory only, with the same hard "no code" guardrail the dream had (tools are not
// sandbox-gated here, so it is a strong instruction, not enforcement); no transcripts — records are written during
// turns, and sweeping transcripts at night was the expensive part of what this replaces.
export function tidyPrompt(memoryDir: string, share: readonly Finding[]): string {
  return (
    `[Memory tidy] This is a MEMORY-ONLY pass over your project memory. It is NOT a coding task — do NOT modify ` +
    `code, run builds, install anything, create branches, commit, or open PRs, and do NOT edit any CLAUDE.md. ` +
    `Do not read session transcripts. You only read and edit your memory files.\n\n` +
    `Your memory: ${memoryDir}/ — MEMORY.md (the index) plus one file per record.\n\n` +
    `The host's check found the ${share.length === 1 ? 'problem' : `${share.length} problems`} below. Resolve each one, and touch no other record:\n` +
    share.map((f) => `- [${f.code}] ${f.text}`).join('\n') +
    `\n\nHow to resolve each kind:\n` +
    `- no-kind: read the record and add \`kind\` to its frontmatter — \`investigation\` (one ticket or incident), ` +
    `\`domain\` (how a business concept or flow works), \`method\` (how to count, query or check something) or ` +
    `\`decision\` (why something was built or changed). An investigation also gets \`status\` (\`open\`, ` +
    `\`answered\`, \`fixed\` or \`closed\`, from what the record says) and \`ticket: <id>\` when it belongs to one.\n` +
    `- no-status: add the \`status\` the record's text supports.\n` +
    `- open-stale, ticket-resolved: if the record itself says how it ended, set the \`status\` and rewrite the ` +
    `sentence that is no longer true; if it does not, leave it \`open\`.\n` +
    `- same-ticket: merge the records into one, or state in each what the other covers; fix MEMORY.md.\n` +
    `- not-linked, no-file: make MEMORY.md and the files agree — one line per record, no line without a file.\n` +
    `- personal-data: remove names of customers or guests, e-mail addresses and phone numbers; keep the finding.\n` +
    `- instructions-changed: read that CLAUDE.md and the records about the same subject; where a record ` +
    `contradicts it, the record is stale — rewrite it to agree or delete it.\n\n` +
    `While you have a record open, also fix a sentence in it that contradicts its own opening. Be conservative: ` +
    `never delete what you are unsure about. End with one line saying what you changed.`
  );
}

/** A tidy's answer as one log line: the first non-empty line, markdown stripped, capped. */
export function tidyDigest(text: string, max = 200): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? 'no changes';
  const stripped = line.replace(/[*_`#>~[\]()]/g, '');
  return stripped.length > max ? `${stripped.slice(0, max - 1)}…` : stripped;
}
