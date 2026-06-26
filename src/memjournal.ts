import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';
import type { Sandbox } from '@daytonaio/sdk';
import { exec } from './daytona.js';
import { projectCwd } from './project.js';
import { memoryDir } from './memory.js';
import { log } from './log.js';

// Host-side, per-project git journal of the agent's auto memory (see docs/memory.md#dreaming).
// One repo per project under ./memory/<slug>/ (next to state.json; server-owned, gitignored,
// deploy-excluded) so projects never collide. After each dream we commit a snapshot, so the
// memory state is reconstructable at any point (git log / checkout) and survives the rare
// sandbox rebuild. The sandbox stays the working source of truth; this is the durable log.

const execFileAsync = promisify(execFile);
// ./memory at the package root (one level up from src/), mirroring state.json's location.
const MEMORY_BASE = new URL('../memory', import.meta.url).pathname;
// Commit author for journal snapshots (cosmetic; history is what matters).
const BOT = ['-c', 'user.name=coach-aven[bot]', '-c', 'user.email=coach-aven@users.noreply.github.com'];

// Validate a slug before it becomes a path segment / git target. Slugs are config-controlled
// and conventionally [A-Za-z0-9_-]; reject anything else so a journal path can't escape.
export function safeSlug(slug: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(slug)) throw new Error(`unsafe project slug: ${slug}`);
  return slug;
}

// A memory file is a single safe path segment (no `/`, no `..`, no shell metachars). One
// predicate, reused everywhere a filename is interpolated into a path or shell `cat`, so the
// sanitization can't drift between call sites.
export function safeName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name);
}

// Host path of a project's journal repo.
export function memoryRepoDir(slug: string): string {
  return join(MEMORY_BASE, safeSlug(slug));
}

async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoDir, ...args], { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

// Mirror `files` into the repo (a snapshot replaces the working tree, so pruned topics
// disappear) and commit if anything changed. Returns true when a commit was made.
export async function commitSnapshot(repoDir: string, files: Record<string, string>, message: string): Promise<boolean> {
  await mkdir(repoDir, { recursive: true });
  if (!existsSync(join(repoDir, '.git'))) await git(repoDir, ['init', '-q']);
  for (const name of await readdir(repoDir)) {
    if (name !== '.git') await rm(join(repoDir, name), { recursive: true, force: true });
  }
  for (const [name, content] of Object.entries(files)) {
    if (safeName(name)) await writeFile(join(repoDir, name), content);
  }
  await git(repoDir, ['add', '-A']);
  if (!(await git(repoDir, ['status', '--porcelain'])).trim()) return false; // unchanged
  await git(repoDir, [...BOT, 'commit', '-q', '-m', message.trim() || 'memory snapshot']);
  return true;
}

// Read one file from the journal's current tree (offline — no sandbox). null if absent/unsafe.
export async function readSnapshotFile(repoDir: string, fileName: string): Promise<string | null> {
  if (!safeName(fileName)) return null;
  const p = join(repoDir, fileName);
  return existsSync(p) ? readFile(p, 'utf8') : null;
}

// One-line-per-commit history of the journal (offline). Returns [] for a missing repo OR a
// repo with no commits yet (git log errors on the latter — don't surface that to the user).
export async function snapshotLog(repoDir: string, n = 10): Promise<string[]> {
  if (!existsSync(join(repoDir, '.git'))) return [];
  try {
    const out = await git(repoDir, ['log', `-n${n}`, '--pretty=%h %ad %s', '--date=short']);
    return out.split('\n').filter(Boolean);
  } catch {
    return []; // no commits yet
  }
}

// Read the memory files out of a (started) sandbox. Flat dir of small text files; cat each.
async function collectMemoryFiles(sandbox: Sandbox, dir: string): Promise<Record<string, string>> {
  const ls = await exec(sandbox, `ls -1 ${dir} 2>/dev/null || true`);
  const names = (ls.result ?? '').split('\n').map((s) => s.trim()).filter(safeName);
  const files: Record<string, string> = {};
  for (const name of names) {
    // The name came from `ls`, so the file exists — record it even if empty (an emptied topic
    // is real state; dropping it would silently un-prune it on the mirror snapshot).
    const r = await exec(sandbox, `cat ${dir}/${name} 2>/dev/null || true`);
    files[name] = r.result ?? '';
  }
  return files;
}

// Snapshot a project's sandbox memory into its journal and commit. Best-effort: a journal
// failure must never break the dream that triggered it.
export async function snapshotMemory(
  sandbox: Sandbox,
  cfg: Config,
  slug: string,
  repos: string[],
  message: string,
): Promise<void> {
  try {
    const files = await collectMemoryFiles(sandbox, memoryDir(projectCwd(cfg, slug, repos)));
    if (!Object.keys(files).length) return; // nothing to snapshot
    if (await commitSnapshot(memoryRepoDir(slug), files, message)) {
      log.info(`memory snapshot ${slug}: ${message}`);
    }
  } catch (e) {
    log.error(`memory snapshot ${slug}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Seed a freshly-rebuilt sandbox from the journal: only when the sandbox has NO memory yet
// (otherwise the sandbox is the newer source of truth and we leave it alone). Best-effort.
export async function restoreMemoryIfEmpty(sandbox: Sandbox, cfg: Config, slug: string, repos: string[]): Promise<boolean> {
  try {
    // Cheap local check first: no journal → nothing to restore, skip the sandbox round-trip.
    // (Journaling is off by default, so this short-circuits on every prepare for most projects.)
    const repoDir = memoryRepoDir(slug);
    if (!existsSync(join(repoDir, '.git'))) return false;
    const dir = memoryDir(projectCwd(cfg, slug, repos));
    const ls = await exec(sandbox, `ls -1 ${dir} 2>/dev/null | head -1 || true`);
    if ((ls.result ?? '').trim()) return false; // sandbox already has memory
    const names = (await readdir(repoDir)).filter((n) => n !== '.git');
    if (!names.length) return false;
    await exec(sandbox, `mkdir -p ${dir}`);
    for (const name of names) {
      await sandbox.fs.uploadFile(Buffer.from(await readFile(join(repoDir, name))), `${dir}/${name}`);
    }
    log.info(`memory restored into ${slug} sandbox from journal (${names.length} files)`);
    return true;
  } catch (e) {
    log.error(`memory restore ${slug}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
