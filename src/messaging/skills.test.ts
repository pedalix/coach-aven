import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exposedSkills, invokeSkill, type ProjectSkill } from './skills.js';

const FOUND: ProjectSkill[] = [
  { name: 'brand-profile', description: 'A brand profile from a hotel website', origin: 'brand-studio', tags: ['brand', 'web'], examples: ['profile for hotel-x.example'] },
  { name: 'release', description: 'Cut a release', origin: 'brand-studio' },
  { name: 'twice', description: 'Defined twice', origin: 'acme-admin', clash: ['acme-admin', 'acme-shop'] },
];

test('exposedSkills — no allowlist offers none: a project\'s skills stay internal unless listed', () => {
  assert.deepEqual(exposedSkills(undefined, FOUND), { skills: [], missing: [], clashing: [] });
});

test('exposedSkills — a list offers the listed names that exist, in list order, as A2A skills (tags always, examples when given)', () => {
  const x = exposedSkills(['release', 'brand-profile'], FOUND);
  assert.deepEqual(x.skills, [
    { id: 'release', name: 'release', description: 'Cut a release', tags: [] },
    { id: 'brand-profile', name: 'brand-profile', description: 'A brand profile from a hotel website', tags: ['brand', 'web'], examples: ['profile for hotel-x.example'] },
  ]);
  assert.deepEqual(x.missing, []);
});

test('exposedSkills — a listed name not found is reported missing; a name defined twice is withheld with its origins', () => {
  const x = exposedSkills(['brand-profile', 'ghost', 'twice'], FOUND);
  assert.deepEqual(x.skills.map((s) => s.id), ['brand-profile']);
  assert.deepEqual(x.missing, ['ghost']);
  assert.deepEqual(x.clashing, [{ name: 'twice', origins: ['acme-admin', 'acme-shop'] }]);
});

test('exposedSkills — `*` offers every skill found except the ones defined twice', () => {
  const x = exposedSkills('*', FOUND);
  assert.deepEqual(x.skills.map((s) => s.id), ['brand-profile', 'release']);
  assert.deepEqual(x.clashing.map((c) => c.name), ['twice']);
});

test('exposedSkills — never scanned: an explicit list is offered by name only; `*` offers nothing until the scan', () => {
  assert.deepEqual(exposedSkills(['brand-profile'], undefined).skills, [{ id: 'brand-profile', name: 'brand-profile', description: '', tags: [] }]);
  assert.deepEqual(exposedSkills('*', undefined).skills, []);
});

test('invokeSkill — the slash invocation, then the frame; without a skill the frame alone, byte for byte', () => {
  assert.equal(invokeSkill('brand-profile', 'A request from agent x.'), '/brand-profile A request from agent x.');
  assert.equal(invokeSkill(undefined, 'A request from agent x.'), 'A request from agent x.');
});
