// The names the Claude Code CLI itself takes — its slash commands and its bundled skills — per probed version
// (OpenSpec `agent-skills`, S3). A project skill with one of these names is never offered to another agent:
// `/name` could run the CLI's command (e.g. `/schedule`) instead of the skill.
//
// Source: the cli-probe's recorded `turn` session of each version in PROBED_CLI_VERSIONS
// (`src/fixtures/cli/<version>/turn.jsonl`). It runs in a bare working directory, so its `system/init` lists
// the CLI's own `slash_commands` and `skills` and nothing of any project. The pinned version is always one of
// them (cliversion.ts gates the pin on a probe report), so the set is exact for what the sandbox runs. Read
// once, at first use.
import { readFileSync } from 'node:fs';
import { PROBED_CLI_VERSIONS } from '../cliversion.js';
import { log } from '../log.js';

const FIXTURES = new URL('../fixtures/cli/', import.meta.url);
const cache = new Map<string, ReadonlySet<string>>();

/** `slash_commands` and `skills` of the first `system/init` in a recording; undefined when it has none. Exported for tests. */
export function initNames(recording: string): Set<string> | undefined {
  for (const line of recording.split('\n')) {
    if (!line.trim()) continue;
    let r: unknown;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const f = ((r as { frame?: unknown }).frame ?? r) as { type?: unknown; subtype?: unknown; slash_commands?: unknown; skills?: unknown };
    if (f && f.type === 'system' && f.subtype === 'init') {
      const names = [...(Array.isArray(f.slash_commands) ? f.slash_commands : []), ...(Array.isArray(f.skills) ? f.skills : [])];
      return new Set(names.filter((n): n is string => typeof n === 'string'));
    }
  }
  return undefined;
}

function load(version: string): ReadonlySet<string> {
  const hit = cache.get(version);
  if (hit) return hit;
  let names: ReadonlySet<string> = new Set();
  try {
    names = initNames(readFileSync(new URL(`${version}/turn.jsonl`, FIXTURES), 'utf8')) ?? new Set();
    if (!names.size) log.warn(`clinames: no init names recorded for Claude Code ${version}`);
  } catch (e) {
    log.warn(`clinames: cannot read the recording of Claude Code ${version}: ${e instanceof Error ? e.message : String(e)}`);
  }
  cache.set(version, names);
  return names;
}

/**
 * The CLI's own names at `version` (the project's pin, or the fleet's). A version outside the probed set, or
 * none, gets the union over every probed version: a superset errs towards withholding.
 */
export function cliOwnNames(version: string | undefined): ReadonlySet<string> {
  if (version && PROBED_CLI_VERSIONS.includes(version)) return load(version);
  return new Set(PROBED_CLI_VERSIONS.flatMap((v) => [...load(v)]));
}
