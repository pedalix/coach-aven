import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';
import type { SandboxHandle } from './driver.js';
import { projectCwd } from './project.js';
import { memoryDir } from './memory.js';
import { log } from './log.js';
import { memoryDir as memoryBase } from './paths.js';

// Host-side, per-project git journal of the agent's auto memory (see docs/memory.md#dreaming).
// One repo per project under ./memory/<slug>/ (next to state.json; server-owned, gitignored,
// deploy-excluded) so projects never collide. After each dream we commit a snapshot, so the
// memory state is reconstructable at any point (git log / checkout) and survives the rare
// sandbox rebuild. The sandbox stays the working source of truth; this is the durable log.

const execFileAsync = promisify(execFile);
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
  // memory/ in the installation directory, beside state.json (src/paths.ts).
  return join(memoryBase(), safeSlug(slug));
}

async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoDir, ...args], { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

// One writer at a time per journal: turns of one project end concurrently, a dream snapshots the same repo, and
// two gits in one repo collide.
const queues = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  queues.set(key, next.catch(() => {}));
  return next;
}

// Mirror `files` into the repo (a snapshot replaces the working tree, so pruned topics
// disappear) and commit if anything changed. Returns true when a commit was made.
export function commitSnapshot(repoDir: string, files: Record<string, string>, message: string): Promise<boolean> {
  // Through the journal's queue: a dream's snapshot empties and refills the tree, and a turn's mirror must not
  // read it half-way (or meet its git lock).
  return serial(repoDir, () => commitSnapshotNow(repoDir, files, message));
}
async function commitSnapshotNow(repoDir: string, files: Record<string, string>, message: string): Promise<boolean> {
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
async function collectMemoryFiles(sandbox: SandboxHandle, dir: string): Promise<Record<string, string>> {
  const ls = await sandbox.exec(`ls -1 ${dir} 2>/dev/null || true`);
  const names = (ls.result ?? '').split('\n').map((s) => s.trim()).filter(safeName);
  const files: Record<string, string> = {};
  for (const name of names) {
    // The name came from `ls`, so the file exists — record it even if empty (an emptied topic
    // is real state; dropping it would silently un-prune it on the mirror snapshot).
    const r = await sandbox.exec(`cat ${dir}/${name} 2>/dev/null || true`);
    files[name] = r.result ?? '';
  }
  return files;
}

// Snapshot a project's sandbox memory into its journal and commit. Best-effort: a journal
// failure must never break the dream that triggered it.
export async function snapshotMemory(
  sandbox: SandboxHandle,
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

// ── The mirror after a turn (OpenSpec company-brain, BRAIN=1; design D2) ────────────────────────────────────────
// The same journal, fed when a turn ends instead of only after a dream: ONE exec lists a hash per memory file,
// only the files whose hash differs from the host's copy are read back in a second one (base64, as the outbox reads files — `cat`
// through exec does not promise the exact bytes, and the hash must match), and the change is committed. A turn
// that changed nothing costs that one exec.

const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

// "<sha256>  <name>" per regular file directly in the directory. A missing directory lists nothing and succeeds
// (a project that has no memory yet); a hash that fails makes the whole listing fail — a partial listing would
// read as "the other files were deleted". POSIX shell: the plain sandbox image is Alpine.
export function hashListScript(dir: string): string {
  return `[ -d ${sq(dir)} ] || exit 0; cd ${sq(dir)} || exit 1; for f in *; do [ -f "$f" ] || continue; sha256sum -- "$f" || exit 1; done`;
}

export function parseHashListing(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trimEnd());
    if (m && safeName(m[2])) out[m[2]] = m[1];
  }
  return out;
}

// The changed files in ONE exec, a line "<name> <base64>" each (a first mirror of a project with a hundred
// records must not be a hundred execs). A file that vanished since the listing is skipped — the next mirror
// sees it gone.
export function readBackScript(dir: string, names: readonly string[]): string {
  return `cd ${sq(dir)} || exit 1; for f in ${names.map(sq).join(' ')}; do [ -f "$f" ] || continue; printf '%s ' "$f"; base64 -w0 -- "$f" || exit 1; echo; done`;
}

export function parseReadBack(stdout: string): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  for (const line of stdout.split('\n')) {
    const m = /^(\S+) ?([A-Za-z0-9+/=]*)$/.exec(line.trimEnd());
    if (m && safeName(m[1])) out[m[1]] = Buffer.from(m[2], 'base64');
  }
  return out;
}
const READ_BACK_BATCH = 40; // files per exec: keeps a command line and one exec's output small

export type MirrorExec = (command: string) => Promise<{ exitCode: number; result: string }>;
export interface MirrorResult {
  files: Record<string, string>; // the host's copy after the mirror, by file name
  changed: string[]; // created or changed by what the sandbox holds now
  removed: string[];
}

// Throws on a failed listing or read-back — the caller logs it and the turn's answer stands. An EMPTY listing
// changes nothing: a rebuilt sandbox has no memory until it is re-seeded from this very journal.
export function mirrorMemory(exec: MirrorExec, repoDir: string, dir: string, message: string): Promise<MirrorResult> {
  return serial(repoDir, async () => {
    const ls = await exec(hashListScript(dir));
    if (ls.exitCode !== 0) throw new Error(`memory listing failed (exit ${ls.exitCode})`);
    const listed = parseHashListing(ls.result ?? '');
    const host = new Map<string, Buffer>();
    if (existsSync(repoDir)) {
      for (const name of await readdir(repoDir)) if (name !== '.git' && safeName(name)) host.set(name, await readFile(join(repoDir, name)));
    }
    const text = (): Record<string, string> => Object.fromEntries([...host].sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, b]) => [n, b.toString('utf8')]));
    if (!Object.keys(listed).length) return { files: text(), changed: [], removed: [] };

    const differ = Object.entries(listed).filter(([name, hash]) => {
      const have = host.get(name);
      return !have || sha256(have) !== hash;
    });
    const changed: string[] = [];
    for (let i = 0; i < differ.length; i += READ_BACK_BATCH) {
      const batch = differ.slice(i, i + READ_BACK_BATCH);
      const r = await exec(readBackScript(dir, batch.map(([n]) => n)));
      if (r.exitCode !== 0) throw new Error(`memory read-back failed (exit ${r.exitCode})`);
      const got = parseReadBack(r.result ?? '');
      for (const [name, hash] of batch) {
        const data = got[name];
        // Written (or removed) between the listing and the read: keep the host's version, the next mirror takes it.
        if (!data || sha256(data) !== hash) continue;
        host.set(name, data);
        changed.push(name);
      }
    }
    const removed = [...host.keys()].filter((n) => !(n in listed));
    for (const name of removed) host.delete(name);
    if (!changed.length && !removed.length) return { files: text(), changed, removed };

    await mkdir(repoDir, { recursive: true });
    if (!existsSync(join(repoDir, '.git'))) await git(repoDir, ['init', '-q']);
    for (const name of changed) await writeFile(join(repoDir, name), host.get(name)!);
    for (const name of removed) await rm(join(repoDir, name), { force: true });
    await git(repoDir, ['add', '-A']);
    if ((await git(repoDir, ['status', '--porcelain'])).trim()) {
      await git(repoDir, [...BOT, 'commit', '-q', '-m', message.trim() || 'memory mirror']);
    }
    return { files: text(), changed: changed.sort(), removed: removed.sort() };
  });
}

// Seed a freshly-rebuilt sandbox from the journal: only when the sandbox has NO memory yet
// (otherwise the sandbox is the newer source of truth and we leave it alone). Best-effort.
export async function restoreMemoryIfEmpty(sandbox: SandboxHandle, cfg: Config, slug: string, repos: string[]): Promise<boolean> {
  try {
    // Cheap local check first: no journal → nothing to restore, skip the sandbox round-trip.
    // (Journaling is off by default, so this short-circuits on every prepare for most projects.)
    const repoDir = memoryRepoDir(slug);
    if (!existsSync(join(repoDir, '.git'))) return false;
    const dir = memoryDir(projectCwd(cfg, slug, repos));
    const ls = await sandbox.exec(`ls -1 ${dir} 2>/dev/null | head -1 || true`);
    if ((ls.result ?? '').trim()) return false; // sandbox already has memory
    const names = (await readdir(repoDir)).filter((n) => n !== '.git');
    if (!names.length) return false;
    await sandbox.exec(`mkdir -p ${dir}`);
    for (const name of names) {
      await sandbox.uploadFile(Buffer.from(await readFile(join(repoDir, name))), `${dir}/${name}`);
    }
    log.info(`memory restored into ${slug} sandbox from journal (${names.length} files)`);
    return true;
  } catch (e) {
    log.error(`memory restore ${slug}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
