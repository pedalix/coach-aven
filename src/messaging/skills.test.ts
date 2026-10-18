import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_COMMANDS, exposedSkills, invokeSkill, isSkillPattern, notOursOf, type ProjectSkill } from './skills.js';

const FOUND: ProjectSkill[] = [
  { name: 'brand-profile', description: 'A brand profile from a hotel website', origin: 'brand-studio', tags: ['brand', 'web'], examples: ['profile for hotel-x.example'] },
  { name: 'release', description: 'Cut a release', origin: 'brand-studio' },
  { name: 'twice', description: 'Defined twice', origin: 'acme-admin', clash: ['acme-admin', 'acme-shop'] },
  { name: 'helper', description: 'Background knowledge', origin: 'brand-studio', userInvocable: false },
  { name: 'review', description: 'Review a draft', origin: 'brand-studio' },
];

test('exposedSkills — no allowlist offers none: a project\'s skills stay internal unless listed', () => {
  assert.deepEqual(exposedSkills(undefined, FOUND), { skills: [], missing: [], withheld: [] });
});

test('exposedSkills — a list offers the listed names that exist, in list order, as A2A skills (tags always, examples when given)', () => {
  const x = exposedSkills(['release', 'brand-profile'], FOUND);
  assert.deepEqual(x.skills, [
    { id: 'release', name: 'release', description: 'Cut a release', tags: [] },
    { id: 'brand-profile', name: 'brand-profile', description: 'A brand profile from a hotel website', tags: ['brand', 'web'], examples: ['profile for hotel-x.example'] },
  ]);
  assert.deepEqual(x.missing, []);
});

test('exposedSkills — only what really runs: missing, defined twice, `user-invocable: false` and a CLI command\'s name are not offered, each with its reason', () => {
  const x = exposedSkills(['brand-profile', 'ghost', 'twice', 'helper', 'review'], FOUND);
  assert.deepEqual(x.skills.map((s) => s.id), ['brand-profile']);
  assert.deepEqual(x.missing, ['ghost']);
  assert.deepEqual(x.withheld, [
    { name: 'twice', reason: 'defined in acme-admin and acme-shop' },
    { name: 'helper', reason: 'user-invocable: false' },
    { name: 'review', reason: '/review is a command of the CLI' },
  ]);
});

test('exposedSkills — `*` offers every skill found that really runs', () => {
  assert.deepEqual(exposedSkills('*', FOUND).skills.map((s) => s.id), ['brand-profile', 'release']);
});

test('exposedSkills — never scanned: nothing, for an explicit list as for `*`', () => {
  assert.deepEqual(exposedSkills(['brand-profile'], undefined).skills, []);
  assert.deepEqual(exposedSkills('*', undefined).skills, []);
});

test('exposedSkills — at most 32 skills on a card', () => {
  const many: ProjectSkill[] = Array.from({ length: 40 }, (_, i) => ({ name: `skill-${i}`, description: 'd', origin: 'p' }));
  assert.equal(exposedSkills('*', many).skills.length, 32);
});

test('notOursOf — the CLI\'s built-ins, and what a session\'s init reported minus the project\'s own skills', () => {
  const x = notOursOf(['code-review', 'brand-profile', 'compact'], FOUND);
  assert.ok(x.has('code-review'), 'a bundled command the project does not define');
  assert.ok(!x.has('brand-profile'), 'the project\'s own skill, as init lists it');
  for (const b of BUILTIN_COMMANDS) assert.ok(x.has(b), b);
  assert.equal(exposedSkills(['brand-profile', 'code-review'], [...FOUND, { name: 'code-review', description: 'ours too?', origin: 'p' }], notOursOf(['code-review'], FOUND)).skills.map((s) => s.id).join(), 'brand-profile');
});

test('invokeSkill — the slash invocation, then the frame; without a skill the frame alone, byte for byte', () => {
  assert.equal(invokeSkill('brand-profile', 'A request from agent x.'), '/brand-profile A request from agent x.');
  assert.equal(invokeSkill(undefined, 'A request from agent x.'), 'A request from agent x.');
});

// ── patterns (messaging.skills entries) ──────────────────────────────────────────────────────────────
const TOOLING: ProjectSkill[] = [
  { name: 'newsletter-weekly', description: 'd', origin: 'p' },
  { name: 'openspec-apply', description: 'd', origin: 'p' },
  { name: 'newsletter-daily', description: 'd', origin: 'p' },
  { name: 'openspec-archive', description: 'd', origin: 'p' },
  { name: 'brand-profile', description: 'd', origin: 'p' },
];

test('patterns — ["*", "!openspec-*"] offers everything except the OpenSpec workflow skills', () => {
  assert.deepEqual(exposedSkills(['*', '!openspec-*'], TOOLING).skills.map((s) => s.id), ['newsletter-weekly', 'newsletter-daily', 'brand-profile']);
});

test('patterns — exclusions win whatever their order; a glob includes in scan order; a plain list keeps its order', () => {
  assert.deepEqual(exposedSkills(['!openspec-*', '*'], TOOLING).skills.map((s) => s.id), ['newsletter-weekly', 'newsletter-daily', 'brand-profile']);
  assert.deepEqual(exposedSkills(['newsletter-*'], TOOLING).skills.map((s) => s.id), ['newsletter-weekly', 'newsletter-daily']);
  assert.deepEqual(exposedSkills(['brand-profile', 'newsletter-daily'], TOOLING).skills.map((s) => s.id), ['brand-profile', 'newsletter-daily']);
});

test('patterns — a name plus an exclusion of that same name offers nothing, and reports nothing missing', () => {
  assert.deepEqual(exposedSkills(['brand-profile', '!brand-profile'], TOOLING), { skills: [], missing: [], withheld: [] });
});

test('patterns — the string "*" behaves like ["*"]', () => {
  assert.deepEqual(exposedSkills('*', TOOLING), exposedSkills(['*'], TOOLING));
});

test('patterns — a glob that matches nothing is not "missing"; a plain name that matches nothing is', () => {
  assert.deepEqual(exposedSkills(['report-*', 'ghost'], TOOLING).missing, ['ghost']);
});

test('patterns — withheld skills stay withheld whatever the patterns say', () => {
  const x = exposedSkills(['*'], FOUND);
  assert.deepEqual(x.skills.map((s) => s.id), ['brand-profile', 'release']);
  assert.deepEqual(x.withheld.map((w) => w.name), ['twice', 'helper', 'review']);
});

test('isSkillPattern — an optional leading !, then kebab-case segments with *; at most 64 after the !', () => {
  for (const p of ['*', 'newsletter-*', '!openspec-*', 'brand-profile', '*-helper', 'a*b']) assert.equal(isSkillPattern(p), true, p);
  for (const p of ['Bad', 'a--b', '-a', 'a-', '!!x', '!', '', 'a b', 'a/b', 'x'.repeat(65), `!${'x'.repeat(65)}`]) assert.equal(isSkillPattern(p), false, p);
  assert.equal(isSkillPattern(`!${'x'.repeat(64)}`), true);
});
