import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bitbucketRepos, githubRepos, isBitbucket, parseRepo, repoProblems } from './repohost.js';

test('a two-segment entry is GitHub, with exactly the URL and name the bot always used', () => {
  assert.deepEqual(parseRepo('northwind/web'), {
    entry: 'northwind/web',
    host: 'github',
    owner: 'northwind',
    name: 'web',
    url: 'https://github.com/northwind/web.git',
  });
});

test('a bitbucket.org entry is Bitbucket Cloud: workspace, name, tokenless clone URL', () => {
  assert.deepEqual(parseRepo('bitbucket.org/northwind/booking-api'), {
    entry: 'bitbucket.org/northwind/booking-api',
    host: 'bitbucket',
    owner: 'northwind',
    name: 'booking-api',
    url: 'https://bitbucket.org/northwind/booking-api.git',
  });
});

test('another host throws, naming the entry', () => {
  assert.throws(() => parseRepo('gitlab.com/northwind/web'), /gitlab\.com\/northwind\/web.*only/);
  assert.throws(() => parseRepo('bitbucket.org/northwind/a/b'), /only/);
});

test('a one-segment entry keeps today\'s lenient name (the clone fails later, as before)', () => {
  assert.equal(parseRepo('web').name, 'web');
});

test('the host filters keep config order', () => {
  const repos = ['northwind/web', 'bitbucket.org/northwind/booking-api', 'northwind/infra', 'bitbucket.org/northwind/vault'];
  assert.deepEqual(githubRepos(repos), ['northwind/web', 'northwind/infra']);
  assert.deepEqual(bitbucketRepos(repos), ['bitbucket.org/northwind/booking-api', 'bitbucket.org/northwind/vault']);
  assert.equal(isBitbucket('northwind/web'), false);
});

test('repoProblems: a fine list has none', () => {
  assert.deepEqual(repoProblems(['northwind/web', 'bitbucket.org/northwind/booking-api']), []);
});

test('repoProblems: an unsupported host and a shared checkout name are both reported', () => {
  const p = repoProblems(['northwind/booking-api', 'bitbucket.org/northwind/booking-api', 'gitlab.com/x/y']);
  assert.equal(p.length, 2);
  assert.match(p[0]!, /"northwind\/booking-api" and "bitbucket\.org\/northwind\/booking-api" would share the checkout "booking-api"/);
  assert.match(p[1]!, /gitlab\.com/);
});
