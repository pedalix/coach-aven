// Which skills an agent's card offers (OpenSpec `agent-skills`, lean v1). Pure: the project's skills come
// from the skills scanner's fact (src/skills.ts), the allowlist from the project's `messaging.skills`, and
// the receiving installation alone decides — every sender it accepts sees this same set, and a task that
// names anything else is rejected `unknown skill` (service.ts onAsk).
import type { AgentSkill } from './a2a.js';
import { SKILL_LIMITS } from './a2a.js';

/** One of a project's own Claude Code skills, as the scanner found it (`.claude/skills/<dir>/SKILL.md`). */
export interface ProjectSkill {
  name: string;
  description: string;
  /** Where it was found: a repo's short name, or `project` (the project folder of a multi-repo project). */
  origin: string;
  /** Optional SKILL.md frontmatter keys, capped (SKILL_LIMITS). */
  tags?: string[];
  examples?: string[];
  /** `user-invocable: false` in its frontmatter: the CLI will not run it by name, so it is never offered. */
  userInvocable?: false;
  /**
   * The same name defined in more than one place: every origin, in scan order. Such a skill is never
   * offered — which definition the CLI would load is not ours to guess — until it is renamed.
   */
  clash?: string[];
}

/**
 * A `messaging.skills` entry: an optional leading `!` (an exclusion), then kebab-case segments in which `*`
 * matches any run of name characters — `brand-profile`, `*`, `newsletter-*`, `!openspec-*`.
 */
const PATTERN_RE = /^!?[a-z0-9*]+(-[a-z0-9*]+)*$/;
export const isSkillPattern = (p: unknown): p is string => typeof p === 'string' && p.replace(/^!/, '').length <= 64 && PATTERN_RE.test(p);
/** A run of `*` matches what one does: collapsed at load (config.ts) and here, defensively. */
export const collapseStars = (p: string): string => p.replace(/\*+/g, '*');

/**
 * Whether `name` matches the wildcard pattern (`*` = any run of characters). Linear-time two-pointer
 * matching that backtracks only to the last `*` — never a backtracking regex: a pattern of many stars must
 * not stall `agents()` or an incoming task.
 */
export function wildcardMatch(pattern: string, name: string): boolean {
  let p = 0;
  let n = 0;
  let star = -1;
  let mark = 0;
  while (n < name.length) {
    if (p < pattern.length && pattern[p] !== '*' && pattern[p] === name[n]) {
      p++;
      n++;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      mark = n;
    } else if (star !== -1) {
      p = star + 1;
      n = ++mark;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

/**
 * Names of the CLI's own commands, withheld even when a project skill takes one: `/name` would run the
 * CLI's command, not the skill. The session's `init` lists complete it per project (`notOurs`).
 */
export const BUILTIN_COMMANDS: readonly string[] = ['init', 'context', 'recap', 'debug', 'verify', 'run', 'design', 'review', 'clear', 'compact', 'help', 'config'];

export interface Exposure {
  skills: AgentSkill[];
  /** Listed names the scan did not find. */
  missing: string[];
  /** Names withheld from the card, and why (defined twice, a CLI command's name, not invocable by name). */
  withheld: { name: string; reason: string }[];
}

const card = (s: ProjectSkill): AgentSkill => ({
  id: s.name,
  name: s.name.slice(0, SKILL_LIMITS.name),
  description: s.description.slice(0, SKILL_LIMITS.description),
  tags: (s.tags ?? []).slice(0, SKILL_LIMITS.tags),
  ...(s.examples?.length ? { examples: s.examples.slice(0, SKILL_LIMITS.examples) } : {}),
});

/**
 * The skills a card offers — only what a task can really run — with what the caller should warn about:
 * - no allowlist → none: a project's skills stay internal unless its operator lists them;
 * - never scanned (`found` undefined: no session since the skills were listed) → none, whatever the list;
 * - scanned → the skills the entries include (names or `*` globs) and no `!` entry excludes, with their
 *   descriptions, tags and examples; a listed plain name that matches nothing is `missing`; whatever the
 *   entries say, a name defined twice, one marked `user-invocable: false`, and one a CLI command takes
 *   (`notOurs`: BUILTIN_COMMANDS plus the session's `init` commands that are not the project's own) are withheld;
 * - at most SKILL_LIMITS.card.
 */
export function exposedSkills(allow: readonly string[] | '*' | undefined, found: readonly ProjectSkill[] | undefined, notOurs: ReadonlySet<string> = new Set(BUILTIN_COMMANDS)): Exposure {
  const out: Exposure = { skills: [], missing: [], withheld: [] };
  if (allow === undefined || found === undefined) return out;
  const entries = allow === '*' ? ['*'] : allow;
  const includes = entries.filter((e) => !e.startsWith('!')).map(collapseStars);
  const excludes = entries.filter((e) => e.startsWith('!')).map((e) => collapseStars(e.slice(1)));
  const excluded = (n: string): boolean => excludes.some((x) => wildcardMatch(x, n));
  // In the order of the inclusions (a plain list keeps its order), scan order within a glob; exclusions win.
  const picked: ProjectSkill[] = [];
  for (const inc of includes) {
    const hits = found.filter((s) => wildcardMatch(inc, s.name));
    if (!hits.length && !inc.includes('*')) out.missing.push(inc);
    for (const s of hits) if (!excluded(s.name) && !picked.includes(s)) picked.push(s);
  }
  for (const s of picked) {
    if (s.clash) out.withheld.push({ name: s.name, reason: `defined in ${s.clash.join(' and ')}` });
    else if (s.userInvocable === false) out.withheld.push({ name: s.name, reason: 'user-invocable: false' });
    else if (notOurs.has(s.name)) out.withheld.push({ name: s.name, reason: `/${s.name} is a command of the CLI` });
    else if (out.skills.length < SKILL_LIMITS.card) out.skills.push(card(s));
  }
  return out;
}

/**
 * The names not ours to offer: the static floor (BUILTIN_COMMANDS), the CLI's own names at the pinned
 * version (clinames.ts, from the probe's bare-session recording — these are never subtracted, so a project
 * skill named like one is withheld), and what the project's sessions reported in `init` beyond its own skills
 * (plugins: the `session_commands` fact).
 */
export function notOursOf(cliOwn: Iterable<string>, sessionCommands: readonly string[] | undefined, found: readonly ProjectSkill[] | undefined): Set<string> {
  const ours = new Set((found ?? []).map((s) => s.name));
  return new Set([...BUILTIN_COMMANDS, ...cliOwn, ...(sessionCommands ?? []).filter((n) => !ours.has(n))]);
}

/** The first message of a task's shadow conversation: the skill's slash invocation, then the plain frame (S6). */
export const invokeSkill = (skill: string | undefined, frame: string): string => (skill ? `/${skill} ${frame}` : frame);
