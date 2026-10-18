// Project skills, as agent-skills relies on them (OpenSpec `agent-skills`, lean v1). Exploratory until the
// first recording on a probed version (the probe needs a CLI_PROBE_TOKEN run): then both become contract
// scenarios, so a CLI bump re-checks them. Verified by hand on 2.1.292 in a project sandbox (design.md).
import type { ProbeCtx } from '../ctx.js';
import type { Scenario } from '../types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const S = 1000;

// A skill that proves it ran: it answers a marker and the last word of its arguments. `tags` and
// `examples` are the optional frontmatter keys agent cards read; the CLI must still load the skill.
const markerSkill = (name: string): string =>
  [
    '---',
    `name: ${name}`,
    'description: A probe skill. Use it only when it is invoked explicitly.',
    'tags: [probe]',
    'examples:',
    `  - /${name} hello`,
    '---',
    'When this skill runs, reply with exactly the text SKILL-RAN, a space, and the last word of the arguments you were given — nothing else.',
    '',
  ].join('\n');

const skillsOf = (ctx: ProbeCtx): string[] => ((ctx.frames.find(ctx.is.init) as Any)?.skills ?? []) as string[];

const addDirLoadsSkills: Scenario<ProbeCtx> = {
  meta: {
    id: 'add-dir-loads-skills',
    contract: false,
    runs: 1,
    files: { 'repo-a/.claude/skills/probe-alpha/SKILL.md': markerSkill('probe-alpha') },
    extras: { args: ['--add-dir', 'repo-a'] },
    hypothesis: 'A skill folder under an `--add-dir` directory is a session skill: it is listed in `system/init` `skills` (a multi-repo project loads its repos’ skills this way).',
  },
  async run(ctx) {
    await ctx.send('Reply with the single word OK.');
    await ctx.precondition(ctx.is.init, 60 * S, 'the session starts');
    await ctx.expect(ctx.is.result, 120 * S, 'a result');
    const skills = skillsOf(ctx);
    ctx.check(skills.includes('probe-alpha'), `init lists the --add-dir skill (got ${JSON.stringify(skills.filter((s) => s.startsWith('probe')))})`);
    return { listed: skills.includes('probe-alpha') };
  },
};

const skillSlashViaStdin: Scenario<ProbeCtx> = {
  meta: {
    id: 'skill-slash-via-stdin',
    contract: false,
    runs: 1,
    files: { '.claude/skills/probe-marker/SKILL.md': markerSkill('probe-marker') },
    hypothesis: 'A user message `/<skill> <text>` written to stream-json stdin runs that project skill with the whole text, every line of it, as its arguments; unknown frontmatter keys (`tags`, `examples`) do not stop it from loading.',
  },
  async run(ctx) {
    await ctx.send('/probe-marker A request from agent bluefin/caldora.\nThe second line of the frame.\nfinal-word-xyz');
    await ctx.precondition(ctx.is.init, 60 * S, 'the session starts');
    ctx.require(skillsOf(ctx).includes('probe-marker'), 'init lists the project skill');
    const res = (await ctx.expect(ctx.is.result, 120 * S, 'a result')) as Any;
    const text = String(res.result ?? '');
    ctx.check(/SKILL-RAN\s+final-word-xyz/.test(text), `the skill ran with the whole text (got ${JSON.stringify(text.slice(0, 80))})`);
    return { result: text.slice(0, 80) };
  },
};

export const SKILLS: Scenario<ProbeCtx>[] = [addDirLoadsSkills, skillSlashViaStdin];
