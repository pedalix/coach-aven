import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePr } from './pr.js';

const PROJECTS = [
  { slug: 'caldora', repos: ['BluefinOrg/caldora-admin', 'BluefinOrg/caldora-frontend'] },
  { slug: 'bluefin-infra', repos: ['BluefinOrg/bluefin-infra'] },
];

test('resolvePr — URL identifies project + canonical repo', () => {
  assert.deepEqual(resolvePr('https://github.com/BluefinOrg/caldora-frontend/pull/23', PROJECTS), {
    slug: 'caldora',
    repo: 'BluefinOrg/caldora-frontend',
    number: 23,
  });
  // URL wins even with words around it.
  assert.deepEqual(resolvePr('pls review https://github.com/BluefinOrg/bluefin-infra/pull/7 thx', PROJECTS), {
    slug: 'bluefin-infra',
    repo: 'BluefinOrg/bluefin-infra',
    number: 7,
  });
});

test('resolvePr — URL for an unowned repo errors', () => {
  assert.ok('error' in resolvePr('https://github.com/Other/repo/pull/1', PROJECTS));
});

test('resolvePr — "<repo> #n" finds the owning project, no channel needed (works in DM)', () => {
  assert.deepEqual(resolvePr('caldora-admin 15', PROJECTS), { slug: 'caldora', repo: 'BluefinOrg/caldora-admin', number: 15 });
  assert.deepEqual(resolvePr('caldora-admin #15', PROJECTS), { slug: 'caldora', repo: 'BluefinOrg/caldora-admin', number: 15 });
  assert.deepEqual(resolvePr('BluefinOrg/caldora-frontend 23', PROJECTS), {
    slug: 'caldora',
    repo: 'BluefinOrg/caldora-frontend',
    number: 23,
  });
});

test('resolvePr — bare number uses the channel project when single-repo', () => {
  assert.deepEqual(resolvePr('#7', PROJECTS, 'bluefin-infra'), { slug: 'bluefin-infra', repo: 'BluefinOrg/bluefin-infra', number: 7 });
});

test('resolvePr — bare number is ambiguous in a multi-repo channel', () => {
  assert.ok('error' in resolvePr('#15', PROJECTS, 'caldora'));
});

test('resolvePr — bare number with no channel (DM) asks for a repo', () => {
  assert.ok('error' in resolvePr('#15', PROJECTS));
});

test('resolvePr — unknown repo and garbage error out', () => {
  assert.ok('error' in resolvePr('nope 15', PROJECTS));
  assert.ok('error' in resolvePr('garbage', PROJECTS));
  assert.ok('error' in resolvePr('', PROJECTS));
});
