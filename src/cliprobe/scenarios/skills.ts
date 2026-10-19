// Project skills, as agent-skills relies on them (OpenSpec `agent-skills`, lean v1). Contract scenarios,
// recorded on every probed version, so a CLI bump re-checks them; their replay assertions are in
// claudeSession.recorded.test.ts. First verified by hand on 2.1.292 in a project sandbox (design.md).
import { LEDGER_ARGS } from '../../claudeSession.js';
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
    contract: true,
    runs: 1,
    // As the bot launches a multi-repo session: two absolute checkouts after one `--add-dir`, last on the line.
    files: { 'repo-a/.claude/skills/probe-alpha/SKILL.md': markerSkill('probe-alpha'), 'repo-b/.claude/skills/probe-beta/SKILL.md': markerSkill('probe-beta') },
    extras: { args: ['--add-dir', '{work}/repo-a', '{work}/repo-b'] },
    hypothesis: 'A skill folder under each `--add-dir` directory is a session skill: both are listed in `system/init` `skills` (a multi-repo project loads its repos’ skills this way).',
  },
  async run(ctx) {
    await ctx.send('Reply with the single word OK.');
    await ctx.precondition(ctx.is.init, 60 * S, 'the session starts');
    await ctx.expect(ctx.is.result, 120 * S, 'a result');
    const skills = skillsOf(ctx);
    const got = JSON.stringify(skills.filter((s) => s.startsWith('probe')));
    ctx.check(skills.includes('probe-alpha') && skills.includes('probe-beta'), `init lists both --add-dir skills (got ${got})`);
    return { listed: got };
  },
};

const skillSlashViaStdin: Scenario<ProbeCtx> = {
  meta: {
    id: 'skill-slash-via-stdin',
    contract: true,
    runs: 1,
    files: { '.claude/skills/probe-marker/SKILL.md': markerSkill('probe-marker') },
    // As every shadow session runs: with the message ledger.
    extras: { args: [...LEDGER_ARGS] },
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
