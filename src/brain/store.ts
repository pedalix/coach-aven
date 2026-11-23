// Company brain: the files derived from a project's mirrored memory — `brain/<slug>/index.json` and `lint.json`
// in the installation directory, beside `memory/<slug>/` (the mirror itself). The one impure part of src/brain/:
// it reads the previous index, calls the pure builders and writes the two files. Everything here runs only when
// the installation sets BRAIN=1; with it off no caller reaches this module and no `brain/` directory exists.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { brainDir } from '../paths.js';
import { safeSlug, type MirrorResult } from '../memjournal.js';
import { log } from '../log.js';
import { buildIndex, type BrainIndex } from './index.js';
import { lint, type Finding } from './lint.js';

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

export async function rebuildBrain(slug: string, files: Record<string, string>, now: Date): Promise<{ index: BrainIndex; findings: Finding[] }> {
  const dir = brainProjectDir(slug);
  await mkdir(dir, { recursive: true });
  const index = buildIndex(files, now, await readIndex(slug));
  const findings = lint(index, { now });
  await writeJson(join(dir, 'index.json'), index);
  await writeJson(join(dir, 'lint.json'), findings);
  return { index, findings };
}

// The turn's hook (turn.ts, after the answer is posted): mirror, then rebuild. Never throws — a failure is logged
// and the answer, already delivered, stands. Returns what the turn changed, for the logs built on top of it.
export async function brainAfterTurn(
  session: { mirrorMemory?: (message: string) => Promise<MirrorResult> },
  slug: string,
  turnId: string,
  now: Date = new Date(),
): Promise<MirrorResult | undefined> {
  if (!session.mirrorMemory) return undefined;
  try {
    const m = await session.mirrorMemory(`turn ${turnId}`);
    // No memory at all yet: nothing to index, and no directory for a project that never wrote a record.
    if (Object.keys(m.files).length) await rebuildBrain(slug, m.files, now);
    return m;
  } catch (e) {
    log.warn(`brain ${slug} turn ${turnId}: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}
