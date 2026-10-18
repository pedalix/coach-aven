import type { SandboxHandle } from './driver.js';
import { PROJECT_SKILLS, projectSubject, type Fact, type FactStore } from './facts.js';
import { log } from './log.js';
import { capStrings, isSkillId, SKILL_LIMITS } from './messaging/a2a.js';
import type { ProjectSkill } from './messaging/skills.js';

// Skills scanner — the second writer of a project fact (OpenSpec `agent-skills`, lean v1).
//
// A project's agent can offer its own Claude Code skills to other agents (its card lists them, a task can
// ask for one). Which skills those are is read from the environment, never typed into a config: the
// `.claude/skills/<dir>/SKILL.md` files the session itself loads — the session's working directory (a
// single-repo project's checkout; a multi-repo project's folder) and, for a multi-repo project, each repo
// checkout passed with `--add-dir` (claudeSession.ts; REPO_SKILLS=0 turns that off, and then the repos'
// skills are not the session's, so they are not scanned either). Bundled CLI skills and plugin skills are
// not the project's to offer and are never read.
//
// The shell runs inside the sandbox and prints only each SKILL.md's frontmatter; the parsing is here,
// pure, with tests. Like the dependency scanner: best-effort, a failure keeps the previous fact.

/** A place the session loads skills from: `origin` is a repo's short name or `project`. */
export interface SkillOrigin {
  origin: string;
  dir: string;
}

const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
// Only the frontmatter: the block between a first line `---` and the next `---` (nothing if the file
// does not start with one), capped — a SKILL.md body can be long and is not ours to ship.
const FRONTMATTER_AWK = `awk 'NR==1 && /^---[[:space:]]*$/ {inside=1; next} NR==1 {exit} inside && /^---[[:space:]]*$/ {exit} inside {print}'`;

/** The scan shell: per origin with a `.claude/skills` folder, `@@ORIGIN <origin> <short sha|->`, then per skill `@@SKILL <dir>` and its frontmatter lines. */
export function skillsScanScript(origins: SkillOrigin[]): string {
  return origins
    .map(({ origin, dir }) => {
      const d = sq(dir);
      return (
        `if [ -d ${d}/.claude/skills ]; then ` +
        `echo "@@ORIGIN ${origin} $(git -C ${d} rev-parse --short HEAD 2>/dev/null || echo -)"; ` +
        `for f in ${d}/.claude/skills/*/SKILL.md; do [ -f "$f" ] || continue; ` +
        `echo "@@SKILL $(basename "$(dirname "$f")")"; ${FRONTMATTER_AWK} "$f" | head -n 120; done; ` +
        `fi`
      );
    })
    .join('; ');
}

const unquote = (v: string): string => {
  const t = v.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return t;
};

/** A YAML flow list `[a, "b, c", 'd']` → its items; quotes respected, nesting not supported. */
function flowList(v: string): string[] {
  const inner = v.trim().slice(1, -1);
  const items: string[] = [];
  let cur = '';
  let quote: string | undefined;
  for (const ch of inner) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ',') {
      items.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim() !== '') items.push(cur);
  return items.map(unquote).filter((x) => x !== '');
}

/**
 * The frontmatter keys a card uses, out of YAML lines — the subset SKILL.md files use: `key: value`
 * (plain or quoted), `key: |` / `key: >` block scalars, a plain value continued on indented lines, and
 * lists, block (`- item` lines) or flow (`[a, b]`). Other keys and comments are skipped.
 */
export function parseFrontmatter(lines: string[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const key = m[1]!;
    const value = m[2]!.trim();
    const block = /^[|>][+-]?$/.exec(value);
    if (value.startsWith('[') && value.endsWith(']')) out[key] = flowList(value);
    else if (block || value === '') {
      const cont: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || /^-\s/.test(lines[i + 1]!) || lines[i + 1]!.trim() === '')) cont.push(lines[++i]!);
      const filled = cont.filter((l) => l.trim() !== '');
      if (!block && filled.length && filled.every((l) => /^\s*-\s+/.test(l))) out[key] = filled.map((l) => unquote(l.replace(/^\s*-\s+/, ''))).filter((x) => x !== '');
      else out[key] = cont.map((l) => l.trim()).join(block && value.startsWith('|') ? '\n' : ' ').trim();
    } else if (/^["']/.test(value)) out[key] = unquote(value);
    else {
      // A plain scalar may continue on more-indented lines; YAML folds them into one line.
      const cont: string[] = [value];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!) && !/^\s*-\s/.test(lines[i + 1]!)) cont.push(lines[++i]!.trim());
      out[key] = cont.join(' ');
    }
  }
  return out;
}

/** One SKILL.md's frontmatter → the fields of a project skill, with what was malformed (warned, never fatal). */
export function skillFromFrontmatter(dir: string, fm: Record<string, string | string[]>): { skill?: Omit<ProjectSkill, 'origin'>; problems: string[] } {
  const problems: string[] = [];
  const name = isSkillId(fm.name) ? fm.name : isSkillId(dir) ? dir : undefined;
  if (fm.name !== undefined && !isSkillId(fm.name)) problems.push(`name ${JSON.stringify(fm.name)} is not a skill name`);
  if (!name) return { problems: [...problems, 'no valid name'] };
  const description = typeof fm.description === 'string' ? fm.description.replace(/\s+/g, ' ').trim().slice(0, SKILL_LIMITS.description) : '';
  if (fm.description !== undefined && typeof fm.description !== 'string') problems.push('description is not text');
  const list = (key: 'tags' | 'examples', max: number, len: number): string[] | undefined => {
    const v = fm[key];
    if (v === undefined) return undefined;
    if (!Array.isArray(v)) {
      problems.push(`${key} is not a list of strings`);
      return undefined;
    }
    if (v.length > max) problems.push(`${key}: only the first ${max} are kept`);
    return capStrings(v, max, len);
  };
  const tags = list('tags', SKILL_LIMITS.tags, SKILL_LIMITS.tag);
  const examples = list('examples', SKILL_LIMITS.examples, SKILL_LIMITS.example);
  return { skill: { name, description, ...(tags?.length ? { tags } : {}), ...(examples?.length ? { examples } : {}) }, problems };
}

/**
 * Parse the scan output into the fact's value and provenance. A name defined in more than one origin is
 * kept once, marked `clash` with every origin, and never offered (messaging/skills.ts) until renamed.
 */
export function parseSkillsScan(output: string): { skills: ProjectSkill[]; sources: string[]; problems: string[] } {
  const skills: ProjectSkill[] = [];
  const sources: string[] = [];
  const problems: string[] = [];
  let origin = '';
  let sha = '-';
  let current: { dir: string; lines: string[] } | undefined;
  const flush = (): void => {
    if (!current) return;
    const { skill, problems: p } = skillFromFrontmatter(current.dir, parseFrontmatter(current.lines));
    for (const x of p) problems.push(`${origin}:${current.dir}: ${x}`);
    if (skill) {
      sources.push(`${origin}@${sha}:.claude/skills/${current.dir}/SKILL.md`);
      const prior = skills.find((s) => s.name === skill.name);
      if (prior) prior.clash = [...(prior.clash ?? [prior.origin]), origin];
      else skills.push({ ...skill, origin });
    }
    current = undefined;
  };
  for (const line of output.split('\n')) {
    if (line.startsWith('@@ORIGIN ')) {
      flush();
      const [o, s] = line.slice('@@ORIGIN '.length).trim().split(/\s+/);
      origin = o ?? '';
      sha = s ?? '-';
    } else if (line.startsWith('@@SKILL ')) {
      flush();
      current = { dir: line.slice('@@SKILL '.length).trim(), lines: [] };
    } else if (current) current.lines.push(line);
  }
  flush();
  return { skills, sources, problems };
}

/** Scan a project's skill folders and record the `project_skills` fact. Best-effort: a failure logs and keeps the previous fact. */
export async function scanProjectSkills(sandbox: SandboxHandle, facts: FactStore, slug: string, origins: SkillOrigin[]): Promise<ProjectSkill[] | undefined> {
  try {
    const res = await sandbox.exec(skillsScanScript(origins));
    const { skills, sources, problems } = parseSkillsScan(res.result);
    const fact: Fact = { subject: projectSubject(slug), predicate: PROJECT_SKILLS, value: skills, sources, observedAt: new Date().toISOString() };
    facts.put(slug, fact);
    for (const s of skills) if (s.clash) log.warn(`skills: ${slug} defines "${s.name}" in ${s.clash.join(' and ')} — withheld from its card until one is renamed`);
    if (problems.length) log.warn(`skills: ${slug}: ${problems.join('; ')}`);
    if (skills.length) log.step(`skills: ${slug} has ${skills.length} skill(s): ${skills.map((s) => s.name).join(', ')}`);
    return skills;
  } catch (e) {
    log.error(`skills scan ${slug}: ${e instanceof Error ? e.message : String(e)}`);
    return facts.projectSkills(slug);
  }
}
