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
  /**
   * The same name defined in more than one place: every origin, in scan order. Such a skill is never
   * offered — which definition the CLI would load is not ours to guess — until it is renamed.
   */
  clash?: string[];
}

export interface Exposure {
  skills: AgentSkill[];
  /** Listed names the scan did not find. */
  missing: string[];
  /** Listed (or, with `*`, found) names withheld because they are defined twice: name → origins. */
  clashing: { name: string; origins: string[] }[];
}

const card = (s: ProjectSkill): AgentSkill => ({
  id: s.name,
  name: s.name,
  description: s.description.slice(0, SKILL_LIMITS.description),
  tags: (s.tags ?? []).slice(0, SKILL_LIMITS.tags),
  ...(s.examples?.length ? { examples: s.examples.slice(0, SKILL_LIMITS.examples) } : {}),
});

/**
 * The skills a card offers, with what the caller should warn about:
 * - no allowlist → none: a project's skills stay internal unless its operator lists them;
 * - never scanned (`found` undefined, before the project's first session since the skills were added) →
 *   an explicit list is offered by name, without description, so a first task does not fail on a missing
 *   scan; `*` offers nothing yet;
 * - scanned → the listed names that exist (`*`: all of them), with their descriptions, tags and examples;
 *   a name defined twice is withheld and reported.
 */
export function exposedSkills(allow: string[] | '*' | undefined, found: readonly ProjectSkill[] | undefined): Exposure {
  if (allow === undefined) return { skills: [], missing: [], clashing: [] };
  if (found === undefined) return { skills: allow === '*' ? [] : allow.map((n) => ({ id: n, name: n, description: '', tags: [] })), missing: [], clashing: [] };
  const byName = new Map(found.map((s) => [s.name, s]));
  const names = allow === '*' ? found.map((s) => s.name) : allow;
  const out: Exposure = { skills: [], missing: [], clashing: [] };
  for (const n of names) {
    const s = byName.get(n);
    if (!s) out.missing.push(n);
    else if (s.clash) out.clashing.push({ name: n, origins: s.clash });
    else out.skills.push(card(s));
  }
  return out;
}

/** The first message of a task's shadow conversation: the skill's slash invocation, then the plain frame (S6). */
export const invokeSkill = (skill: string | undefined, frame: string): string => (skill ? `/${skill} ${frame}` : frame);
