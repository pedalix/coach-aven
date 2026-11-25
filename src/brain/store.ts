// Company brain: the files derived from a project's mirrored memory — `brain/<slug>/index.json` and `lint.json`
// — and the two logs the host writes there, `uses.jsonl` (record names per turn) and `answers.jsonl` (what was
// answered on an investigation), in the installation directory beside `memory/<slug>/` (the mirror itself). The one impure part of src/brain/:
// it reads the previous index, calls the pure builders and writes the two files. `tidy.json` is the nightly tidy's
// state (tidy.ts). A project that never wrote a record has no `brain/` directory.

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { brainDir } from '../paths.js';
import { safeSlug, type MirrorResult } from '../memjournal.js';
import { log } from '../log.js';
import { buildIndex, type BrainIndex } from './index.js';
import { lint, type Finding } from './lint.js';
import { parseJsonl, provenance, useEntry, type Starter, type UseEntry } from './uses.js';
import { answerEntry, type AnswerEntry } from './answers.js';
import { changedInstructions, emptyTidyState, instructionsChanged, type Digests, type TidyState } from './tidy.js';

export const brainProjectDir = (slug: string): string => join(brainDir(), safeSlug(slug));

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return undefined; // absent or torn: rebuilt from the mirror, which is the truth
  }
}
// Write-then-rename: a reader (a command, the nightly check) never sees half a file.
async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 1) + '\n');
  await rename(`${path}.tmp`, path);
}

export const readIndex = (slug: string): Promise<BrainIndex | undefined> => readJson<BrainIndex>(join(brainProjectDir(slug), 'index.json'));
export const readLint = (slug: string): Promise<Finding[] | undefined> => readJson<Finding[]>(join(brainProjectDir(slug), 'lint.json'));

async function readJsonl<T>(path: string): Promise<T[]> {
  try {
    return parseJsonl<T>(await readFile(path, 'utf8'));
  } catch {
    return []; // no log yet
  }
}
export const readUses = (slug: string): Promise<UseEntry[]> => readJsonl<UseEntry>(join(brainProjectDir(slug), 'uses.jsonl'));
export const readAnswers = (slug: string): Promise<AnswerEntry[]> => readJsonl<AnswerEntry>(join(brainProjectDir(slug), 'answers.jsonl'));

export const readTidy = async (slug: string): Promise<TidyState> => ({ ...emptyTidyState(), ...(await readJson<TidyState>(join(brainProjectDir(slug), 'tidy.json'))) });

// tidy.json has two writers — a turn's mirror noting CLAUDE.md digests and the nightly tidy settling its counts —
// and both read, change and write it: every update goes through one queue per project, so neither writes back a
// copy the other has already replaced. Written only when the update changed something.
const tidyQueues = new Map<string, Promise<unknown>>();
export function updateTidy(slug: string, change: (state: TidyState) => TidyState): Promise<TidyState> {
  const run = async (): Promise<TidyState> => {
    const before = await readTidy(slug);
    const next = change(before);
    if (JSON.stringify(next) !== JSON.stringify(before)) await writeJson(join(brainProjectDir(slug), 'tidy.json'), next);
    return next;
  };
  const queued = (tidyQueues.get(slug) ?? Promise.resolve()).then(run, run);
  tidyQueues.set(slug, queued.catch(() => {}));
  return queued;
}

// `instructions`: the CLAUDE.md digests the mirror just read (absent: the caller did not ask). A file noted for
// the first time becomes the baseline in tidy.json; one that differs from what the last tidy saw is a finding.
export async function rebuildBrain(
  slug: string,
  files: Record<string, string>,
  now: Date,
  instructions?: Digests,
): Promise<{ index: BrainIndex; findings: Finding[] }> {
  const dir = brainProjectDir(slug);
  await mkdir(dir, { recursive: true });
  const index = buildIndex(files, now, await readIndex(slug), provenance(await readUses(slug)));
  let changed: string[] = [];
  if (instructions) changed = changedInstructions(await updateTidy(slug, (tidy) => instructionsChanged(tidy, instructions).state));
  const findings = lint(index, { now, instructionsChanged: changed });
  await writeJson(join(dir, 'index.json'), index);
  await writeJson(join(dir, 'lint.json'), findings);
  return { index, findings };
}

/** What the turn engine knows about the turn that just ended. */
export interface BrainTurn {
  turnId: string;
  key: string; // the conversation
  by: Starter;
  asker?: string;
  question: string; // as the sandbox received it
  answer: string; // as posted
  link?: string;
  // false for a marked (cross-domain) or shadow conversation — its text belongs to another domain — and for a
  // private one (a direct message, a command's own conversation): the log is read by the whole project. The use log holds names only and is written either way.
  logAnswer: boolean;
}

// The turn's hook (turn.ts, after the answer is posted): mirror, the use log, the index and the lint, the answer
// log. Never throws — a failure is logged and the answer, already delivered, stands.
export async function brainAfterTurn(
  session: { mirrorMemory?: (message: string) => Promise<MirrorResult>; memoryReads?: () => string[] },
  slug: string,
  turn: BrainTurn,
  now: Date = new Date(),
): Promise<MirrorResult | undefined> {
  if (!session.mirrorMemory) return undefined;
  try {
    const m = await session.mirrorMemory(`turn ${turn.turnId}`);
    // No memory at all yet: nothing to index, and no directory for a project that never wrote a record.
    if (!Object.keys(m.files).length) return m;
    const dir = brainProjectDir(slug);
    await mkdir(dir, { recursive: true });
    const at = now.toISOString();
    // The mirror's diff is the whole project's: a first mirror holds every record, and a turn of another
    // conversation (or a dream) may have written since the last one. This turn changed only what its own tool
    // inputs named.
    const named = session.memoryReads?.() ?? [];
    const changed = m.changed.filter((n) => named.includes(n));
    const use = useEntry({ at, key: turn.key, turnId: turn.turnId, by: turn.by, read: named, changed, known: Object.keys(m.files) });
    if (use) await appendFile(join(dir, 'uses.jsonl'), JSON.stringify(use) + '\n');
    const { index } = await rebuildBrain(slug, m.files, now, m.instructions);
    if (use && turn.logAnswer) {
      const entry = answerEntry({ at, key: turn.key, turnId: turn.turnId, asker: turn.asker, question: turn.question, answer: turn.answer, link: turn.link, used: [...use.read, ...use.changed], index });
      if (entry) await appendFile(join(dir, 'answers.jsonl'), JSON.stringify(entry) + '\n');
    }
    return m;
  } catch (e) {
    log.warn(`brain ${slug} turn ${turn.turnId}: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}
