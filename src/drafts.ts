import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeSlug } from './memjournal.js';
import { log } from './log.js';
import { draftsDir } from './paths.js';

// Report drafts ("✏️ Edit & send") on disk: one markdown file per draft under
// <installation directory>/drafts/<slug>/<turnId>.md — per-project, mirroring memory/<slug>. Server-side because
// Slack rewrites `markdown` blocks to rich_text on delivery, so the posted message can't
// round-trip its own text (see PR #55). On disk rather than in memory so a deploy no
// longer kills every pending draft's button — a draft is minutes of agent work.

const MAX_PER_PROJECT = 100;

// Draft ids are bot-minted turnIds (`t<boot36>-<seq>`), but they round-trip through Slack
// button values, so validate before one becomes a path segment.
export function isDraftId(id: string): boolean {
  return /^t[a-z0-9]+-\d+$/.test(id);
}

export class DraftStore {
  // `base` is injectable so tests use a throwaway dir (same pattern as Store).
  constructor(private readonly base: string = draftsDir()) {}

  // Best-effort: a full disk must degrade the Edit&send button, never sink the turn.
  put(slug: string, id: string, text: string): void {
    if (!isDraftId(id)) return;
    try {
      const dir = join(this.base, safeSlug(slug));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${id}.md`), text);
      this.pruneOldest(dir);
    } catch (e) {
      log.error(`draft put ${slug}/${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Lookup by id alone (the button value carries no slug): scan the per-project dirs —
  // a handful of projects, one existsSync each, and only on an Edit&send click.
  get(id: string): string | undefined {
    if (!isDraftId(id)) return undefined;
    try {
      for (const dir of readdirSync(this.base, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        const path = join(this.base, dir.name, `${id}.md`);
        if (existsSync(path)) return readFileSync(path, 'utf8');
      }
    } catch {
      /* no drafts dir yet */
    }
    return undefined;
  }

  // Keep the newest MAX_PER_PROJECT per project (by mtime) — same bound the old
  // in-memory map had, now surviving restarts instead of resetting on each one.
  private pruneOldest(dir: string): void {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime);
    for (const { f } of files.slice(0, Math.max(0, files.length - MAX_PER_PROJECT))) {
      unlinkSync(join(dir, f));
    }
  }
}
