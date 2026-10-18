import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_COMMANDS, collapseStars, exposedSkills, invokeSkill, isSkillPattern, notOursOf, wildcardMatch, type ProjectSkill } from './skills.js';
import { cliOwnNames, initNames } from './clinames.js';

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

test('notOursOf — the static floor, the CLI\'s own names (never subtracted), and session names beyond the project\'s own (plugins)', () => {
  const x = notOursOf(['schedule', 'code-review'], ['schedule', 'brand-profile', 'acme-plugin-tool'], FOUND);
  for (const b of BUILTIN_COMMANDS) assert.ok(x.has(b), b);
  assert.ok(x.has('schedule') && x.has('code-review'), 'the CLI\'s own names');
  assert.ok(x.has('acme-plugin-tool'), 'a plugin name the session reported');
  assert.ok(!x.has('brand-profile'), 'the project\'s own skill, as init lists it');
});

test('a project skill named like a CLI command (`schedule`) is withheld — the same list feeds the card and the check', () => {
  const found: ProjectSkill[] = [...FOUND, { name: 'schedule', description: 'Our own scheduler', origin: 'brand-studio' }];
  // What a session of this project reports in init: the CLI's names plus the project's own skills.
  const session = [...cliOwnNames('2.1.292'), ...found.map((s) => s.name)];
  const notOurs = notOursOf(cliOwnNames('2.1.292'), session, found);
  const x = exposedSkills(['*'], found, notOurs);
  assert.ok(!x.skills.some((s) => s.id === 'schedule'));
  assert.deepEqual(x.withheld.find((w) => w.name === 'schedule'), { name: 'schedule', reason: '/schedule is a command of the CLI' });
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

// ── the CLI's own names (clinames.ts) ─────────────────────────────────────────────────────────────
test('cliOwnNames — from the probe\'s recorded bare session: 2.1.292 takes schedule, insights, usage, goal, simplify, code-review…', () => {
  const v = cliOwnNames('2.1.292');
  for (const n of ['schedule', 'insights', 'usage', 'goal', 'simplify', 'code-review', 'compact', 'init', 'plugin-authoring']) assert.ok(v.has(n), n);
  assert.ok(v.size >= 50, `${v.size} names`);
  assert.ok(!cliOwnNames('2.1.282').has('plugin-authoring'), 'per version');
  assert.ok(cliOwnNames('9.9.9').has('plugin-authoring') && cliOwnNames(undefined).has('schedule'), 'an unknown or unset version gets the union');
});

test('initNames — slash_commands and skills of the first init frame', () => {
  const rec = [JSON.stringify({ frame: { type: 'system', subtype: 'hook' } }), JSON.stringify({ frame: { type: 'system', subtype: 'init', slash_commands: ['compact', 'x'], skills: ['x', 'loop'] } })].join('\n');
  assert.deepEqual([...initNames(rec)!].sort(), ['compact', 'loop', 'x']);
  assert.equal(initNames('{}'), undefined);
});

// ── the wildcard matcher ─────────────────────────────────────────────────────────────────────────
test('wildcardMatch — `*` matches any run, anchored at both ends', () => {
  for (const [p, n] of [['*', 'anything'], ['newsletter-*', 'newsletter-weekly'], ['*-helper', 'tailwind-helper'], ['a*b*c', 'axxbyyc'], ['brand-profile', 'brand-profile'], ['*', '']])
    assert.equal(wildcardMatch(p!, n!), true, `${p} ~ ${n}`);
  for (const [p, n] of [['newsletter-*', 'weekly-newsletter'], ['a*b', 'ab-c'], ['brand', 'brand-profile'], ['*-x', 'x']]) assert.equal(wildcardMatch(p!, n!), false, `${p} !~ ${n}`);
});

test('wildcardMatch — the worst patterns on the longest names finish in milliseconds (no backtracking regex)', () => {
  const name = 'a'.repeat(63) + 'b';
  const worst = ['*a'.repeat(32), '*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*x', `${'*'.repeat(64)}x`, `${'a*'.repeat(32)}x`];
  const t0 = performance.now();
  for (let i = 0; i < 100; i++) for (const p of worst) wildcardMatch(collapseStars(p), name);
  for (const p of worst) wildcardMatch(p, name); // uncollapsed too
  assert.ok(performance.now() - t0 < 200, `took ${Math.round(performance.now() - t0)} ms`);
  assert.equal(collapseStars('a***b**'), 'a*b*');
});
