import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSystemPrompt } from './tasks.js';

// Golden snapshot of the layer-1 system prompt that PRODUCTION sends to every session:
// src/fixtures/prompt/*.txt were captured byte-exact from buildSystemPrompt on main@3f293c7,
// BEFORE the builder moved out of tasks.ts. The three shapes are what prod projects look like
// (dind default, one or several repos, with and without the `sources` MCP paragraph — a
// project's `mcp` list itself never reaches the prompt, it goes to --mcp-config). Any change
// to this text is a change to what every client session reads — it must be deliberate:
// re-capture the golden on purpose, never "fix the test".
const golden = (name: string) => readFileSync(new URL(`./fixtures/prompt/${name}.txt`, import.meta.url), 'utf8');

// Single repo, nothing optional: the smallest production shape.
const SINGLE = { slug: 'acme', cwd: '/root/work/acme/acme-admin', repos: ['AcmeOrg/acme-admin'] };
// Two repos side by side + project prompt (untrimmed on purpose) + Slack thread link + a
// private composer package on record — the typical production shape.
const MULTI = {
  slug: 'acme-suite',
  cwd: '/root/work/acme-suite',
  repos: ['AcmeOrg/acme-admin', 'AcmeOrg/acme-shop'],
  projectPrompt: '\n  Domain: ski-pass shop.\n  acme-admin deploys before acme-shop.\n',
  slackUrl: 'https://acme.slack.com/archives/C0123ABCD/p1700000000000100',
  packageRepos: ['AcmeOrg/acme-core'],
};

test('golden: production prompt, single repo', () => {
  assert.equal(buildSystemPrompt(SINGLE.slug, SINGLE.cwd, SINGLE.repos), golden('single-repo'));
});

test('golden: production prompt, multi-repo + project prompt + Slack link + private package', () => {
  const out = buildSystemPrompt(
    MULTI.slug, MULTI.cwd, MULTI.repos, MULTI.projectPrompt, MULTI.slackUrl, MULTI.packageRepos, false,
  );
  assert.equal(out, golden('multi-repo'));
});

test('golden: production prompt, multi-repo with the sources MCP paragraph', () => {
  const out = buildSystemPrompt(
    MULTI.slug, MULTI.cwd, MULTI.repos, MULTI.projectPrompt, MULTI.slackUrl, MULTI.packageRepos, true,
  );
  assert.equal(out, golden('multi-repo-sources'));
});
