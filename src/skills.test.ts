import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FactStore, PROJECT_SKILLS, projectSubject } from './facts.js';
import { parseFrontmatter, parseSkillsScan, scanProjectSkills, skillFromFrontmatter, skillsScanScript } from './skills.js';
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

test('skillFromFrontmatter — the name falls back to the folder; tags and examples are capped; a malformed key is reported, not fatal', () => {
  assert.deepEqual(skillFromFrontmatter('brand-profile', { description: 'd' }).skill, { name: 'brand-profile', description: 'd' });
  const many = skillFromFrontmatter('x', { name: 'site-design', description: 'd', tags: Array.from({ length: 12 }, (_, i) => `t${i}`), examples: Array.from({ length: 7 }, (_, i) => `e${i}`) });
  assert.equal(many.skill!.tags!.length, 8);
  assert.equal(many.skill!.examples!.length, 5);
  assert.deepEqual(many.problems, ['tags: only the first 8 are kept', 'examples: only the first 5 are kept']);
  const bad = skillFromFrontmatter('x', { name: 'site-design', description: 'd', tags: 'brand, web' });
  assert.deepEqual(bad.skill, { name: 'site-design', description: 'd' });
  assert.deepEqual(bad.problems, ['tags is not a list of strings']);
  const unnamed = skillFromFrontmatter('Not A Name', { name: 'Also Bad' });
  assert.equal(unnamed.skill, undefined);
  assert.deepEqual(unnamed.problems, ['name "Also Bad" is not a skill name', 'no valid name']);
});

test('skillsScanScript — one guarded block per origin: only the frontmatter of each SKILL.md is printed, the commit for provenance', () => {
  const sh = skillsScanScript([{ origin: 'project', dir: '/root/work/acme-suite' }, { origin: 'acme-admin', dir: '/root/work/acme-suite/acme-admin' }]);
  assert.match(sh, /if \[ -d '\/root\/work\/acme-suite'\/\.claude\/skills \]; then echo "@@ORIGIN project /);
  assert.match(sh, /echo "@@ORIGIN acme-admin \$\(git -C '\/root\/work\/acme-suite\/acme-admin' rev-parse --short HEAD/);
  assert.match(sh, /for f in '\/root\/work\/acme-suite\/acme-admin'\/\.claude\/skills\/\*\/SKILL\.md; do/);
  assert.match(sh, /echo "@@SKILL \$\(basename "\$\(dirname "\$f"\)"\)"; awk /);
});

const SCAN = `@@ORIGIN project -
@@SKILL triage
name: triage
description: Sort an incoming request
@@ORIGIN acme-admin 1a2b3c4
@@SKILL brand-profile
name: brand-profile
description: >
  A brand profile
  from a hotel website
tags: [brand, web]
examples:
  - Profile for hotel-x.example
@@SKILL triage
name: triage
description: Another triage
@@ORIGIN acme-shop 5d6e7f8
@@SKILL checkout
description: The shop checkout`;

test('parseSkillsScan — skills with origin and provenance; a name defined in two places is kept once, marked with every origin', () => {
  const { skills, sources, problems } = parseSkillsScan(SCAN);
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
  assert.deepEqual(problems, []);
});

const fakeSandbox = (result: string | Error): SandboxHandle =>
  ({ exec: async () => { if (result instanceof Error) throw result; return { exitCode: 0, result }; } }) as unknown as SandboxHandle;

test('scanProjectSkills — records the project_skills fact with provenance; a failed scan keeps the previous fact', async () => {
  const facts = new FactStore(mkdtempSync(join(tmpdir(), 'aven-skills-')));
  const found = await scanProjectSkills(fakeSandbox(SCAN), facts, 'acme-suite', []);
  assert.deepEqual(found!.map((s) => s.name), ['triage', 'brand-profile', 'checkout']);
  const fact = facts.get('acme-suite', projectSubject('acme-suite'), PROJECT_SKILLS)!;
  assert.equal(fact.sources.length, 4);
  assert.deepEqual(facts.projectSkills('acme-suite')!.map((s) => s.name), ['triage', 'brand-profile', 'checkout']);
  const kept = await scanProjectSkills(fakeSandbox(new Error('sandbox gone')), facts, 'acme-suite', []);
  assert.deepEqual(kept!.map((s) => s.name), ['triage', 'brand-profile', 'checkout']);
  assert.equal(facts.projectSkills('never-scanned'), undefined);
});
