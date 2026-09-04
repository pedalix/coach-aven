import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeSlug } from './memjournal.js';
import { log } from './log.js';

// Project facts: structured, DERIVED state about a project that deterministic code writes
// and other deterministic code reads — the first sliver of the "world state" from
// ideas/aven-distributed-cognition-assessment.md. Everything else on disk is either
// orchestration bookkeeping (state.json, queue.jsonl) or free text only Claude reads
// (memory/). A fact is different: it is machine-produced, machine-consumed, and
// re-derivable from the environment, so it lives in its own per-project file
// (./facts/<slug>.json, beside drafts/ and memory/) and never in state.json.
//
// Deliberately minimal (see the assessment's pushback #2/#3): facts only — things that
// are objectively true of the environment right now — with mandatory provenance
// (`sources`: which files, at which commit) and an observation time. No confidence, no
// salience, no subscriptions; the store earns a second predicate when a second writer
// shows up. One record per (subject, predicate): a fresh observation REPLACES the old
// one, so a fact can go stale in only one direction (the file's observedAt says how).
//
// First writer: the dependency scanner (deps.ts) — `depends_on_repos`, the GitHub repos
// a project's package manifests pull from. Readers: the GitHub token mint (scope) and
// the composer auth seeder (which checkouts) in tasks.ts, and the system prompt.

export const DEPENDS_ON_REPOS = 'depends_on_repos';

export interface Fact {
  // What the fact is about, e.g. "project:caldora".
  subject: string;
  predicate: string;
  value: unknown;
  // Provenance — every fact must say where it came from, e.g.
  // "caldora-admin@d825c18e:composer.json,composer.lock". Load-bearing for the
  // transparency ask: a pre-cooked conclusion must still be traceable to its evidence.
  sources: string[];
  // ISO timestamp of the observation that produced the current value.
  observedAt: string;
}

const FACTS_BASE = new URL('../facts', import.meta.url).pathname;

export const projectSubject = (slug: string) => `project:${slug}`;

export class FactStore {
  // `base` is injectable so tests use a throwaway dir (same pattern as DraftStore).
  constructor(private readonly base: string = FACTS_BASE) {}

  private file(slug: string): string {
    return join(this.base, `${safeSlug(slug)}.json`);
  }

  // All facts on file for a project. A missing/corrupt file reads as "no facts" — the
  // store is a derived cache, and a reader must degrade to "unknown", never crash a turn.
  read(slug: string): Fact[] {
    const f = this.file(slug);
    if (!existsSync(f)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(f, 'utf8'));
      return Array.isArray(parsed) ? (parsed as Fact[]) : [];
    } catch (e) {
      log.error(`facts read ${slug}: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  get(slug: string, subject: string, predicate: string): Fact | undefined {
    return this.read(slug).find((x) => x.subject === subject && x.predicate === predicate);
  }

  // Upsert by (subject, predicate). Atomic (tmp + rename) like state.json: a crash
  // mid-write must not leave a half-file that reads as "no facts" next boot.
  put(slug: string, fact: Fact): void {
    const rest = this.read(slug).filter(
      (x) => !(x.subject === fact.subject && x.predicate === fact.predicate),
    );
    mkdirSync(this.base, { recursive: true });
    const f = this.file(slug);
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, JSON.stringify([...rest, fact], null, 2) + '\n');
    renameSync(tmp, f);
  }

  // Convenience for the one fact that exists today: the GitHub repos a project's package
  // manifests depend on ("Owner/name" strings). Empty when never scanned.
  dependsOnRepos(slug: string): string[] {
    const v = this.get(slug, projectSubject(slug), DEPENDS_ON_REPOS)?.value;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  }
}
