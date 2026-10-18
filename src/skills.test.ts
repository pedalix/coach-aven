import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FactStore, PROJECT_SKILLS, projectSubject } from './facts.js';
import { parseFrontmatter, parseSkillsScan, recordSessionCommands, scanNonce, scanProjectSkills, skillFromFrontmatter, skillsScanScript } from './skills.js';
import type { SandboxHandle } from './driver.js';

const lines = (s: string): string[] => s.split('\n');

test('parseFrontmatter — plain, quoted, block and folded scalars, a plain value continued on indented lines; other keys kept, comments skipped', () => {
  const fm = parseFrontmatter(lines(`# a comment
name: brand-profile
description: "A brand \\"profile\\" from a website"
license: MIT
note: |
  line one
  line two
folded: >
  part one
  part two
continued: first part
  second part`));
  assert.equal(fm.name, 'brand-profile');
  assert.equal(fm.description, 'A brand "profile" from a website');
  assert.equal(fm.license, 'MIT');
  assert.equal(fm.note, 'line one\nline two');
  assert.equal(fm.folded, 'part one part two');
  assert.equal(fm.continued, 'first part second part');
});

test('parseFrontmatter — lists, block (`- item`) and flow (`[a, "b, c"]`), with quotes respected', () => {
  const fm = parseFrontmatter(lines(`tags: [brand, "web, design", 'hotels']
examples:
  - Profile for hotel-x.example
  - "Profile for 'hotel-y.example'"
description: >
  A brand profile`));
  assert.deepEqual(fm.tags, ['brand', 'web, design', 'hotels']);
  assert.deepEqual(fm.examples, ['Profile for hotel-x.example', "Profile for 'hotel-y.example'"]);
  assert.equal(fm.description, 'A brand profile');
});

test('skillFromFrontmatter — the folder is the id (the CLI resolves /name by folder); a different frontmatter name is only reported', () => {
  assert.deepEqual(skillFromFrontmatter('brand-profile', { description: 'd' }).skill, { name: 'brand-profile', description: 'd' });
  const renamed = skillFromFrontmatter('brand-profile', { name: 'Brand Profile', description: 'd' });
  assert.equal(renamed.skill!.name, 'brand-profile');
  assert.match(renamed.problems[0]!, /differs from the folder/);
  assert.deepEqual(skillFromFrontmatter('Not A Name', { name: 'x' }), { problems: ['the folder name is not a skill name'] });
});

test('skillFromFrontmatter — `user-invocable: false` is recorded (never offered); tags and examples capped; a malformed key reported, not fatal', () => {
  assert.equal(skillFromFrontmatter('helper', { description: 'd', 'user-invocable': 'false' }).skill!.userInvocable, false);
  assert.equal(skillFromFrontmatter('helper', { description: 'd', 'user-invocable': 'true' }).skill!.userInvocable, undefined);
  const many = skillFromFrontmatter('site-design', { description: 'd', tags: Array.from({ length: 12 }, (_, i) => `t${i}`), examples: Array.from({ length: 7 }, (_, i) => `e${i}`) });
  assert.equal(many.skill!.tags!.length, 8);
  assert.equal(many.skill!.examples!.length, 5);
  assert.deepEqual(many.problems, ['tags: only the first 8 are kept', 'examples: only the first 5 are kept']);
  const bad = skillFromFrontmatter('site-design', { description: 'd', tags: 'brand, web' });
  assert.deepEqual(bad.skill, { name: 'site-design', description: 'd' });
  assert.deepEqual(bad.problems, ['tags is not a list of strings']);
});

const N = 'a1b2c3d4e5f60718';
const SCAN = `@@ORIGIN-${N} project -
@@SKILL-${N} triage
name: triage
description: Sort an incoming request
@@ORIGIN-${N} acme-admin 1a2b3c4
@@SKILL-${N} brand-profile
description: >
  A brand profile
  from a hotel website
tags: [brand, web]
examples:
  - Profile for hotel-x.example
@@SKILL ${'forged'}
@@SKILL-${N} triage
description: Another triage
@@SKIP-${N}
@@ORIGIN-${N} acme-shop 5d6e7f8
@@SKILL-${N} checkout
description: The shop checkout`;

test('parseSkillsScan — origins, provenance, a name in two places kept once with every origin; markers without the nonce are frontmatter', () => {
  const { skills, sources, problems } = parseSkillsScan(SCAN, N);
  assert.deepEqual(skills, [
    { name: 'triage', description: 'Sort an incoming request', origin: 'project', clash: ['project', 'acme-admin'] },
    { name: 'brand-profile', description: 'A brand profile from a hotel website', origin: 'acme-admin', tags: ['brand', 'web'], examples: ['Profile for hotel-x.example'] },
    { name: 'checkout', description: 'The shop checkout', origin: 'acme-shop' },
  ]);
  assert.deepEqual(sources, [
    'project@-:.claude/skills/triage/SKILL.md',
    'acme-admin@1a2b3c4:.claude/skills/brand-profile/SKILL.md',
    'acme-admin@1a2b3c4:.claude/skills/triage/SKILL.md',
    'acme-shop@5d6e7f8:.claude/skills/checkout/SKILL.md',
  ]);
  assert.deepEqual(problems, ['1 skill folder(s) whose name is not a skill name (lowercase letters, digits, hyphens) were skipped']);
  assert.deepEqual(parseSkillsScan(SCAN, 'ffffffffffffffff').skills, [], 'another scan\'s nonce: nothing is a record');
});

test('the scan shell, run for real against a temp tree — hostile frontmatter cannot forge a record, odd folders are skipped unnamed, long lines are cut', () => {
  const root = mkdtempSync(join(tmpdir(), 'aven-skillscan-'));
  const repo = join(root, 'acme-admin');
  const skill = (folder: string, text: string): void => {
    mkdirSync(join(repo, '.claude', 'skills', folder), { recursive: true });
    writeFileSync(join(repo, '.claude', 'skills', folder, 'SKILL.md'), text);
  };
  const n = scanNonce();
  skill('brand-profile', `---\nname: brand-profile\ndescription: ${'x'.repeat(5000)}\n@@SKILL-${n.slice(0, 4)}0000 injected\n@@SKILL injected\ntags: [brand]\n---\nbody @@SKILL-x not read\n`);
  skill('Upper-Case', `---\ndescription: skipped\n---\n`);
  skill('new\nline', `---\ndescription: skipped\n---\n`);
  skill('no-frontmatter', `just a body\n---\ndescription: not frontmatter\n---\n`);
  const out = execFileSync('bash', ['-c', skillsScanScript([{ origin: 'acme-admin', dir: repo }, { origin: 'acme-shop', dir: join(root, 'missing') }], n)], { encoding: 'utf8' });
  const { skills, problems } = parseSkillsScan(out, n);
  assert.deepEqual(skills.map((s) => s.name).sort(), ['brand-profile', 'no-frontmatter']);
  const bp = skills.find((s) => s.name === 'brand-profile')!;
  assert.equal(bp.description.length, 300, 'the description was cut (line at 1000, then the card cap)');
  assert.deepEqual(bp.tags, ['brand'], 'the forged markers stayed frontmatter lines');
  assert.equal(skills.find((s) => s.name === 'no-frontmatter')!.description, '', 'a file without leading --- has no frontmatter');
  assert.ok(out.split('\n').every((l) => l.length <= 1000), 'every line is cut at 1000');
  assert.ok(!out.includes('Upper-Case') && !out.includes('new\nline'), 'a skipped folder is never named');
  assert.match(problems.join(';'), /2 skill folder\(s\) whose name is not a skill name/);
});

const failingSandbox = (e: Error): SandboxHandle => ({ exec: async () => { throw e; } }) as unknown as SandboxHandle;

test('scanProjectSkills — records the fact with provenance, runs checked (a failing command throws), and a failed scan keeps the previous fact', async () => {
  const facts = new FactStore(mkdtempSync(join(tmpdir(), 'aven-skills-')));
  const seen: { check?: boolean }[] = [];
  // The real output carries the scan's fresh nonce: this sandbox answers with SCAN under the nonce it was given.
  const echoing = { exec: async (cmd: string, o?: { check?: boolean }) => (seen.push(o ?? {}), { exitCode: 0, result: SCAN.split(N).join(/@@ORIGIN-([0-9a-f]{16}) /.exec(cmd)![1]!) }) } as unknown as SandboxHandle;
  const found = await scanProjectSkills(echoing, facts, 'acme-suite', [{ origin: 'project', dir: '/root/work/acme-suite' }]);
  assert.deepEqual(found!.map((s) => s.name), ['triage', 'brand-profile', 'checkout']);
  assert.equal(seen[0]!.check, true, 'the scan honours the exit code');
  assert.equal(facts.get('acme-suite', projectSubject('acme-suite'), PROJECT_SKILLS)!.sources.length, 4);
  const kept = await scanProjectSkills(failingSandbox(new Error('exit 2: find: permission denied')), facts, 'acme-suite', []);
  assert.deepEqual(kept!.map((s) => s.name), ['triage', 'brand-profile', 'checkout']);
  assert.deepEqual(facts.projectSkills('acme-suite')!.map((s) => s.name), ['triage', 'brand-profile', 'checkout'], 'the fact on file is unchanged');
  assert.equal(facts.projectSkills('never-scanned'), undefined);
});

test('recordSessionCommands — the init names, sorted and unique; written only when they change', () => {
  const facts = new FactStore(mkdtempSync(join(tmpdir(), 'aven-skills-')));
  recordSessionCommands(facts, 'brand-studio', ['review', 'brand-profile', 'review']);
  assert.deepEqual(facts.sessionCommands('brand-studio'), ['brand-profile', 'review']);
  const at = facts.get('brand-studio', projectSubject('brand-studio'), 'session_commands')!.observedAt;
  recordSessionCommands(facts, 'brand-studio', ['brand-profile', 'review']);
  assert.equal(facts.get('brand-studio', projectSubject('brand-studio'), 'session_commands')!.observedAt, at, 'unchanged: not rewritten');
});

test('CRLF — a SKILL.md with Windows line endings keeps every key: user-invocable: false is honoured, the description read', () => {
  const fm = parseFrontmatter(['name: helper\r', 'description: Background knowledge\r', 'user-invocable: false\r', 'tags:\r', '  - one\r']);
  assert.deepEqual(fm, { name: 'helper', description: 'Background knowledge', 'user-invocable': 'false', tags: ['one'] });
  const root = mkdtempSync(join(tmpdir(), 'aven-skillscan-'));
  mkdirSync(join(root, '.claude', 'skills', 'helper'), { recursive: true });
  writeFileSync(join(root, '.claude', 'skills', 'helper', 'SKILL.md'), '---\r\nname: helper\r\ndescription: Background knowledge\r\nuser-invocable: false\r\n---\r\nbody\r\n');
  const n = scanNonce();
  const { skills } = parseSkillsScan(execFileSync('bash', ['-c', skillsScanScript([{ origin: 'brand-studio', dir: root }], n)], { encoding: 'utf8' }), n);
  assert.deepEqual(skills, [{ name: 'helper', description: 'Background knowledge', origin: 'brand-studio', userInvocable: false }]);
});
