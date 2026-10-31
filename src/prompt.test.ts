import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSystemPrompt, type SystemPromptInputs } from './prompt.js';
import type { ResolvedSandboxOptions } from './sandboxopts.js';

// Golden snapshot of the layer-1 system prompt that PRODUCTION sends to every session:
// src/fixtures/prompt/*.txt were captured byte-exact from buildSystemPrompt on main@3f293c7,
// BEFORE the builder moved out of tasks.ts (see the commit that added them — it ran this very
// test against the old function), and re-captured from the new output after the two deliberate
// changes since: the ScheduleWakeup background-update sentence (#136) and the sources paragraph
// (transcript tool, subagent pattern, replica-unavailable contract — feature/meeting-tools).
// The three shapes are what prod projects look like: dind
// default, gitFlow default, one or several repos, with and without the `sources` MCP paragraph
// (a project's `mcp` list itself never reaches the prompt — it goes to --mcp-config). Any
// change to this text is a change to what every client session reads, so it must be
// deliberate: re-capture the golden on purpose, never "fix the test".
const golden = (name: string) => readFileSync(new URL(`./fixtures/prompt/${name}.txt`, import.meta.url), 'utf8');

// The fleet default (privileged + dind) and the plain, docker-less container.
const DIND: ResolvedSandboxOptions = { privileged: true, dind: true, mounts: [] };
const PLAIN: ResolvedSandboxOptions = { privileged: false, dind: false, mounts: [] };

// Single repo, nothing optional: the smallest production shape.
const SINGLE: SystemPromptInputs = {
  slug: 'acme',
  cwd: '/root/work/acme/acme-admin',
  repos: ['AcmeOrg/acme-admin'],
  sandbox: DIND,
};
// Two repos side by side + project prompt (untrimmed on purpose) + Slack thread link + a
// private composer package on record — the typical production shape.
const MULTI: SystemPromptInputs = {
  slug: 'acme-suite',
  cwd: '/root/work/acme-suite',
  repos: ['AcmeOrg/acme-admin', 'AcmeOrg/acme-shop'],
  projectPrompt: '\n  Domain: ski-pass shop.\n  acme-admin deploys before acme-shop.\n',
  slackUrl: 'https://acme.slack.com/archives/C0123ABCD/p1700000000000100',
  packageRepos: ['AcmeOrg/acme-core'],
  sandbox: DIND,
};

test('golden: production prompt, single repo', () => {
  assert.equal(buildSystemPrompt(SINGLE), golden('single-repo'));
});

test('golden: production prompt, multi-repo + project prompt + Slack link + private package', () => {
  assert.equal(buildSystemPrompt(MULTI), golden('multi-repo'));
});

test('golden: production prompt, multi-repo with the sources MCP paragraph', () => {
  assert.equal(buildSystemPrompt({ ...MULTI, sourcesEnabled: true }), golden('multi-repo-sources'));
});

test('gitFlow absent and gitFlow "pr" are the same prompt — "pr" is the default', () => {
  assert.equal(buildSystemPrompt({ ...MULTI, gitFlow: 'pr' }), golden('multi-repo'));
  assert.equal(buildSystemPrompt({ ...SINGLE, gitFlow: 'pr' }), golden('single-repo'));
});

// ── gitFlow "direct" ────────────────────────────────────────────────────────

const direct = buildSystemPrompt({ ...MULTI, gitFlow: 'direct' });
const prLines = golden('multi-repo').split('\n');
const directLines = direct.split('\n');

test('direct: the opening line is neutral — an agent, not a coding assistant', () => {
  assert.equal(directLines[0], 'You are the agent for the project "acme-suite", reachable from a Slack channel.');
  assert.doesNotMatch(direct, /coding assistant/);
});

test('direct: commit on the checkout\'s current branch after a rebase pull — no worktree, no branch, no PR', () => {
  const flow = directLines.find((l) => l.startsWith('To make changes, '))!;
  assert.match(flow, /work in the checkout on its current branch/);
  assert.match(flow, /before editing, run `git pull --rebase --autostash`/);
  assert.match(flow, /commit, and `git push`/);
  // Nothing in the whole prompt points at the PR machinery any more — the one mention of
  // worktrees is the negation itself.
  assert.match(flow, /no worktrees, no feature branches, no pull requests/);
  assert.equal(direct.match(/worktree/gi)?.length, 1);
  assert.doesNotMatch(direct, /git worktree/);
  assert.doesNotMatch(direct, /origin\/main/);
  assert.doesNotMatch(direct, /\bPRs?\b|pull request(?!s:)/); // "no pull requests:" is the one allowed mention
  assert.doesNotMatch(direct, /gh CLI/);
});

test('direct: the git-hygiene sentences survive verbatim in both flows', () => {
  const hygiene = [
    'never set a git identity (no `-c user.name/user.email`, no `--author`, no `git config user.*`) — the sandbox already commits as coach-aven[bot]; ',
    'git auth is already configured via a credential helper (and gh) — use the plain https://github.com/<org>/<repo>.git remote and NEVER embed a token in a remote URL (no x-access-token:<token>@github.com): a baked-in token expires within the hour and breaks later pushes',
  ].join('');
  assert.ok(direct.includes(hygiene), 'direct keeps the hygiene text');
  assert.ok(golden('multi-repo').includes(hygiene), 'pr keeps the hygiene text');
});

test('direct: the Slack thread goes into the commit message instead of a PR description', () => {
  const slack = directLines.find((l) => l.startsWith('This conversation is the Slack thread '))!;
  assert.match(slack, /https:\/\/acme\.slack\.com\/archives\/C0123ABCD\/p1700000000000100/);
  assert.match(slack, /reference that link in the commit message/);
  assert.doesNotMatch(slack, /PR description/);
});

test('direct: everything else is byte-identical to the pr prompt (same lines, four differ)', () => {
  // Line-by-line diff against the production golden: only the identity line, the flow
  // paragraph, the private-packages paragraph (its worktree caveat) and the Slack-link
  // paragraph may change. The AskUserQuestion/attachments tail, the diagnosis and
  // background-update rules, the toolchain, sources and project prompt are untouched.
  assert.equal(directLines.length, prLines.length);
  const changed = prLines.map((l, i) => (l === directLines[i] ? -1 : i)).filter((i) => i >= 0);
  const expected = [
    0,
    prLines.findIndex((l) => l.startsWith('To make changes, ')),
    prLines.findIndex((l) => l.startsWith('Private packages: ')),
    prLines.findIndex((l) => l.startsWith('This conversation is the Slack thread ')),
  ];
  assert.deepEqual(changed, expected);
  // The flow paragraph differs only in its head: the shared tail is the same text.
  const tail = (s: string) => s.slice(s.indexOf('Replies render in Slack'));
  assert.equal(tail(directLines[expected[1]]), tail(prLines[expected[1]]));
});

// ── sandbox.dind ────────────────────────────────────────────────────────────

test('dind false: exactly the toolchain paragraph (and its blank line) disappears, nothing else', () => {
  const g = golden('multi-repo-sources').split('\n');
  const i = g.findIndex((l) => l.startsWith('Toolchain — this sandbox is a Docker-in-Docker image'));
  assert.ok(i > 0 && g[i - 1] === '', 'golden has the paragraph preceded by a blank line');
  const expected = [...g.slice(0, i - 1), ...g.slice(i + 1)].join('\n');
  assert.equal(buildSystemPrompt({ ...MULTI, sourcesEnabled: true, sandbox: PLAIN }), expected);
});

test('matrix: gitFlow × dind — the toolchain follows dind, the worktree flow follows gitFlow', () => {
  for (const gitFlow of ['pr', 'direct'] as const) {
    for (const sandbox of [DIND, PLAIN]) {
      const out = buildSystemPrompt({ ...MULTI, gitFlow, sandbox });
      const label = `${gitFlow}/dind=${sandbox.dind}`;
      assert.equal(out.includes('Toolchain — this sandbox is a Docker-in-Docker image'), sandbox.dind, label);
      assert.equal(out.includes('`php`/`composer`/`artisan` are shims'), sandbox.dind, label);
      assert.equal(out.includes('git worktree add'), gitFlow === 'pr', label);
      assert.equal(out.includes('`git pull --rebase --autostash`'), gitFlow === 'direct', label);
      // Shared across all four: identity rules, AskUserQuestion, the project prompt last.
      assert.ok(out.includes('coach-aven[bot]'), label);
      assert.ok(out.includes('use the AskUserQuestion tool'), label);
      assert.ok(out.endsWith('--- Project-specific instructions ---\nDomain: ski-pass shop.\n  acme-admin deploys before acme-shop.'), label);
    }
  }
});

test('golden: a project with messaging.send gets the messaging paragraph (agent-messaging D9); every other prompt is unchanged', () => {
  assert.equal(buildSystemPrompt({ ...MULTI, messagingSend: true }), golden('multi-repo-messaging'));
});
