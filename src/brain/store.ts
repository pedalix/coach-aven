// Company brain: the files derived from a project's mirrored memory — `brain/<slug>/index.json` and `lint.json`
// — and the two logs the host writes there, `uses.jsonl` (record names per turn) and `answers.jsonl` (what was
// answered on an investigation), in the installation directory beside `memory/<slug>/` (the mirror itself). The one impure part of src/brain/:
// it reads the previous index, calls the pure builders and writes the two files. Everything here runs only when
// the installation sets BRAIN=1; with it off no caller reaches this module and no `brain/` directory exists.

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { brainDir } from '../paths.js';
import { safeSlug, type MirrorResult } from '../memjournal.js';
import { log } from '../log.js';
import { buildIndex, type BrainIndex } from './index.js';
import { lint, type Finding } from './lint.js';
import { parseJsonl, provenance, useEntry, type Starter, type UseEntry } from './uses.js';
import { answerEntry, type AnswerEntry } from './answers.js';

export const brainProjectDir = (slug: string): string => join(brainDir(), safeSlug(slug));

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return undefined; // absent or torn: rebuilt from the mirror, which is the truth
  }
}
// Write-then-rename: a reader (a command, the dream) never sees half a file.
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

export async function rebuildBrain(slug: string, files: Record<string, string>, now: Date): Promise<{ index: BrainIndex; findings: Finding[] }> {
  const dir = brainProjectDir(slug);
  await mkdir(dir, { recursive: true });
  const index = buildIndex(files, now, await readIndex(slug), provenance(await readUses(slug)));
  const findings = lint(index, { now });
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
    const { index } = await rebuildBrain(slug, m.files, now);
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
