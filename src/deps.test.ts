import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseScan,
  reachableDependencyRepos,
  repoFromFragment,
  reposFromFragments,
  scanDependencyRepos,
  tokenRepos,
} from './deps.js';
import { FactStore } from './facts.js';
import type { SandboxHandle } from './driver.js';

test('repoFromFragment — every URL shape composer uses → "Owner/name"', () => {
  assert.equal(repoFromFragment('github.com/BluefinOrg/mews.git'), 'BluefinOrg/mews');
  assert.equal(repoFromFragment('github.com/BluefinOrg/mews'), 'BluefinOrg/mews');
  assert.equal(repoFromFragment('github.com:BluefinOrg/laravel-apaleo.git'), 'BluefinOrg/laravel-apaleo'); // git@ form
  assert.equal(repoFromFragment('api.github.com/repos/BluefinOrg/bill-php-sdk'), 'BluefinOrg/bill-php-sdk'); // dist zipball
  assert.equal(repoFromFragment('github.com/ace18/filament-flatpickr.git'), 'ace18/filament-flatpickr');
  assert.equal(repoFromFragment('github.com/settings/tokens'), undefined);
  assert.equal(repoFromFragment('gitlab.git.example.org/bluefin/nova-guest-card-package.git'), undefined);
  assert.equal(repoFromFragment(''), undefined);
});

test('reposFromFragments — de-duplicates the https/ssh/api spellings of one repo, sorted', () => {
  assert.deepEqual(
    reposFromFragments([
      'github.com/BluefinOrg/mews.git',
      'api.github.com/repos/BluefinOrg/mews',
      'github.com:BluefinOrg/laravel-apaleo.git',
      'github.com/BluefinOrg/laravel-apaleo.git',
      'github.com/BluefinOrg/laravel-apaleo',
      'github.com/ace18/filament-flatpickr.git',
    ]),
    ['BluefinOrg/laravel-apaleo', 'BluefinOrg/mews', 'ace18/filament-flatpickr'],
  );
});

test('parseScan — "@<checkout> <sha>" headers become provenance, the rest become repos', () => {
  const out = [
    '@caldora-admin d825c18e',
    'github.com/BluefinOrg/mews.git',
    'github.com:BluefinOrg/laravel-apaleo.git',
    '',
  ].join('\n');
  assert.deepEqual(parseScan(out), {
    repos: ['BluefinOrg/laravel-apaleo', 'BluefinOrg/mews'],
    sources: ['caldora-admin@d825c18e:composer.json'],
  });
  // A project with no composer manifests at all: empty fact, no provenance.
  assert.deepEqual(parseScan(''), { repos: [], sources: [] });
});

test('tokenRepos — project repos + same-org deps only; foreign-org deps never enter the mint', () => {
  const project = ['BluefinOrg/caldora-admin', 'BluefinOrg/caldora-frontend'];
  const deps = ['BluefinOrg/laravel-apaleo', 'BluefinOrg/mews', 'ace18/filament-flatpickr', 'BluefinOrg/caldora-admin'];
  assert.deepEqual(tokenRepos(project, deps), [
    'BluefinOrg/caldora-admin',
    'BluefinOrg/caldora-frontend',
    'BluefinOrg/laravel-apaleo',
    'BluefinOrg/mews',
  ]);
  assert.deepEqual(tokenRepos(project, []), project);
  assert.deepEqual(reachableDependencyRepos(project, deps), ['BluefinOrg/laravel-apaleo', 'BluefinOrg/mews']);
});

// A fake sandbox: records the script it was asked to run and returns canned output.
const fakeSandbox = (output: string, fail = false): SandboxHandle & { ran: string[] } => {
  const ran: string[] = [];
  return {
    name: 'fake',
    started: true,
    ran,
    async exec(command: string) {
      ran.push(command);
      if (fail) throw new Error('sandbox gone');
      return { exitCode: 0, result: output };
    },
    async uploadFile() {},
    async createSession() {},
    async startSessionCommand() {
      return { cmdId: 'c' };
    },
  } as unknown as SandboxHandle & { ran: string[] };
};

test('scanDependencyRepos — writes the fact with provenance and only greps checkouts that have composer.json', async () => {
  const facts = new FactStore(mkdtempSync(join(tmpdir(), 'aven-facts-')));
  const sb = fakeSandbox('@caldora-admin d825c18e\ngithub.com/BluefinOrg/mews.git\n');
  const repos = await scanDependencyRepos(sb, facts, 'caldora', [
    { repo: 'BluefinOrg/caldora-admin', dir: '/root/work/caldora/caldora-admin' },
    { repo: 'BluefinOrg/caldora-frontend', dir: '/root/work/caldora/caldora-frontend' },
  ]);
  assert.deepEqual(repos, ['BluefinOrg/mews']);
  assert.deepEqual(facts.dependsOnRepos('caldora'), ['BluefinOrg/mews']);
  const fact = facts.read('caldora')[0];
  assert.deepEqual(fact.sources, ['caldora-admin@d825c18e:composer.json']);
  assert.ok(Date.parse(fact.observedAt) > 0);
  // One exec for all checkouts, each guarded by a composer.json test.
  assert.equal(sb.ran.length, 1);
  assert.ok(sb.ran[0].includes('[ -f /root/work/caldora/caldora-admin/composer.json ]'));
  assert.ok(sb.ran[0].includes('[ -f /root/work/caldora/caldora-frontend/composer.json ]'));
});

test('scanDependencyRepos — a failed scan keeps the previous fact (degrades to yesterday, never to nothing)', async () => {
  const facts = new FactStore(mkdtempSync(join(tmpdir(), 'aven-facts-')));
  await scanDependencyRepos(fakeSandbox('@a 1\ngithub.com/O/pkg.git'), facts, 'p', [{ repo: 'O/a', dir: '/w/a' }]);
  const repos = await scanDependencyRepos(fakeSandbox('', true), facts, 'p', [{ repo: 'O/a', dir: '/w/a' }]);
  assert.deepEqual(repos, ['O/pkg']);
  assert.deepEqual(facts.dependsOnRepos('p'), ['O/pkg']);
});
