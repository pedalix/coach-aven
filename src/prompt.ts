import { MESSAGING_PROMPT_PARAGRAPH } from './messaging/wrap.js';
import { repoName } from './project.js';
import { SOURCES_PROMPT_PARAGRAPH } from './sources/mcp.js';
import type { GitFlow } from './projects.js';
import type { ResolvedSandboxOptions } from './sandboxopts.js';

// Layer 1 (orchestrator-owned) system prompt: the mechanics true for ALL projects —
// identity, repo layout, how changes leave the sandbox, AskUserQuestion. `projectPrompt`
// (layer 2, from the project config) is APPENDED after it, never overrides. (Layer 3 = each
// repo's own CLAUDE.md, auto-loaded by Claude Code when working in that repo.)
//
// Pure: inputs in, string out. src/prompt.test.ts pins the production text byte-exact
// (src/fixtures/prompt/*.txt) — this is what every client session reads, so an edit here is
// a deliberate change, re-snapshotted on purpose. Two inputs vary the text per project, both
// straight from projects.config.json — nothing is inferred from repo names or `sources`:
//   - `gitFlow` (ProjectConfig.gitFlow, default "pr"): a worktree + pull request for code
//     under review, or commits straight onto the checkout's branch for a repo nobody reviews
//     (an ops ledger the agent itself keeps). Git hygiene (no identity, no token in a remote
//     URL) is the same in both.
//   - `sandbox.dind` (resolved sandbox options): the Sail/Docker-in-Docker toolchain
//     paragraph only where dockerd exists — a plain container has no shims to explain.
export interface SystemPromptInputs {
  slug: string;
  cwd: string;
  repos: string[];
  projectPrompt?: string;
  slackUrl?: string;
  // Same-org private dependency repos on record (facts → deps.ts) — what auth.json covers.
  packageRepos?: string[];
  // ProjectConfig.sources set → the `sources` MCP server is injected; tell the agent how to use it.
  sourcesEnabled?: boolean;
  // ProjectConfig.messaging.send → the messaging tools are on `host` (agent-messaging D9); absent → today's text.
  messagingSend?: boolean;
  // ProjectConfig.gitFlow; absent → "pr".
  gitFlow?: GitFlow;
  // GITHUB_AUTH=none (config.ts): no GitHub access at all; absent → today's text, byte for byte.
  noGitHub?: boolean;
  // The project's container options as resolved at boot (sandboxopts.ts) — `dind` gates the
  // toolchain paragraph, exactly as it gates the dockerd guard in prepareChat.
  sandbox: ResolvedSandboxOptions;
}

// The git rules every project gets, whatever its flow: the identity and the auth belong to
// the sandbox, never to the agent. No terminator — each flow punctuates its own sentence.
const GIT_HYGIENE =
  `never set a git identity (no \`-c user.name/user.email\`, no \`--author\`, no \`git config user.*\`) — ` +
  `the sandbox already commits as coach-aven[bot]; ` +
  `git auth is already configured via a credential helper (and gh) — use the plain ` +
  `https://github.com/<org>/<repo>.git remote and NEVER embed a token in a remote URL ` +
  `(no x-access-token:<token>@github.com): a baked-in token expires within the hour and ` +
  `breaks later pushes`;

// GITHUB_AUTH=none: this installation reads public repositories anonymously and can push nothing — the
// quickstart's read-only trial (OpenSpec quickstart D10). It overrides the flow's last step, not the flow.
const NO_GITHUB =
  `This installation has NO GitHub access: the repositories were cloned anonymously, nothing can be ` +
  `pushed, no pull request can be opened, and gh is not logged in. Answer questions as usual. When asked ` +
  `for a change, make it in a worktree as described, show the diff in your reply, and say that a GitHub ` +
  `token in the installation's .env (\`GITHUB_TOKEN\`, with Contents and Pull requests read and write) lets you ` +
  `open the pull request yourself. Never ask the user to paste a token into the chat.`;

// "pr": a dedicated worktree off the fresh remote default, a PR via gh. The shared checkout
// is never edited in place — the sandbox outlives the task and may sit on an old branch.
const PR_FLOW =
  `To make changes, work in a DEDICATED git worktree forked from the fresh remote default — never ` +
  `edit the shared checkout in place (this sandbox is reused across sessions and may be left on an ` +
  `old branch from previous work). In the relevant repo: ` +
  `(1) \`git fetch origin\`; ` +
  `(2) \`git worktree add -b <branch> <path> origin/main\` — fork from the fresh remote default ` +
  `(usually main; if unsure, check \`git remote show origin\` for "HEAD branch"), and put <path> in ` +
  `a sibling dir, e.g. ../<repo>-wt/<branch>; ` +
  `(3) cd into <path>, make your changes there, commit, push, and open a PR against the default ` +
  `branch with the gh CLI; ` +
  `${GIT_HYGIENE}; ` +
  `(4) when the PR is open you may \`git worktree remove <path>\` (the orchestrator also reaps ` +
  `finished worktrees automatically). ` +
  `For a change spanning multiple repos, do this in each relevant repo, sharing a ` +
  `feature name and noting the merge order in the PR descriptions. `;

// "direct": the checkout IS the working tree and its current branch IS the target — no
// worktree, no branch, no PR. Pull with rebase first because other turns (and the user)
// push to the same branch between sessions.
const DIRECT_FLOW =
  `To make changes, work in the checkout on its current branch — no worktrees, no feature ` +
  `branches, no pull requests: this project commits straight to its branch (this sandbox is ` +
  `reused across sessions, and others may have pushed since you last looked). In the relevant repo: ` +
  `(1) before editing, run \`git pull --rebase --autostash\` so you build on what is already pushed; ` +
  `(2) make your changes, commit, and \`git push\` (a rejected push means something landed ` +
  `meanwhile — pull --rebase again and retry); ` +
  `${GIT_HYGIENE}. ` +
  `For a change spanning multiple repos, do this in each relevant repo, and say in the commit ` +
  `messages which order they must land in. `;

// Docker-in-Docker sandboxes only (sandbox.dind): the php/composer/artisan shims and Sail.
const TOOLCHAIN =
  `Toolchain — this sandbox is a Docker-in-Docker image with NO host PHP or Composer: bare ` +
  `\`php\`/\`composer\`/\`artisan\` are shims that forward into a repo's Laravel Sail containers ` +
  `(\`./vendor/bin/sail\`). For any Laravel(+Sail) repo, on a fresh checkout: ` +
  `(1) \`composer install\` — this works even before \`vendor/\` exists (the shim auto-bootstraps ` +
  `it in a throwaway container, which is how \`vendor/bin/sail\` first appears); ` +
  `(2) copy \`.env\` from \`.env.example\`; ` +
  `(3) \`./vendor/bin/sail up -d\`. After that \`php\`/\`composer\`/\`artisan\` forward into the ` +
  `container, and project JS/tests run via \`sail npm ...\` / \`sail artisan test\`. If a ` +
  `\`[sail-shim]\` command exits 127, the stack isn't up yet — do steps 1–3 first. When a project ` +
  `has SEVERAL Laravel repos side by side, give each its own \`COMPOSE_PROJECT_NAME\` (or bring ` +
  `them up one at a time) so their Sail containers/ports don't collide. ` +
  `Host \`node\`/\`npm\` are real and fine to use for a plain Node repo; \`bun\`/\`pnpm\`/\`yarn\` ` +
  `are NOT installed. JS deps are usually npm (\`package-lock.json\`) — ignore any stray extra ` +
  `lockfiles unless a repo's CI says otherwise. Anything that deviates from this (a non-Sail ` +
  `repo, a bun/pnpm repo, an infra repo) is called out in the project-specific instructions below.`;

export function buildSystemPrompt(inp: SystemPromptInputs): string {
  const { slug, cwd, repos, projectPrompt, slackUrl, packageRepos = [], sourcesEnabled = false } = inp;
  const pr = (inp.gitFlow ?? 'pr') === 'pr';
  const lines = [
    `You are the ${pr ? 'coding assistant' : 'agent'} for the project "${slug}", reachable from a Slack channel.`,
  ];
  if (repos.length === 1) {
    lines.push(`Your working directory is the repository ${repos[0]} (cwd: ${cwd}).`);
  } else {
    lines.push(`This project has ${repos.length} repositories cloned side by side under ${cwd} (your cwd):`);
    for (const r of repos) lines.push(`  - ${repoName(r)}/   (${r})`);
    lines.push(
      `Each is its own git checkout — cd into a repo and read ITS own CLAUDE.md before working there ` +
        `(sub-repo CLAUDE.md files are not auto-loaded from the project root).`,
    );
  }
  lines.push(
    (pr ? PR_FLOW : DIRECT_FLOW) +
      `Replies render in Slack — be concise and use code blocks for code. ` +
      `When a decision is yours to make but you're genuinely unsure between approaches, or an ` +
      `action is risky/irreversible, use the AskUserQuestion tool to present the options instead ` +
      `of guessing — the user answers with a button click. ` +
      `Files the user attaches are saved under /root/inbox/<turn>/ and named in the message; ` +
      `Read them directly (you can view images and PDFs). Images are pre-scaled to fit — if a ` +
      `Read ever reports an image exceeds the size limit, run \`magick <in> -resize '1568x1568>' ` +
      `<out>\` and Read <out>; do NOT hand-write an image resizer.`,
  );
  lines.push(
    `When a reply diagnoses a problem (a bug, an incident, "why is X happening?"), write for a ` +
      `mixed audience: open with a 1–2 sentence plain-language conclusion a non-developer can act ` +
      `on, then a short "What I checked" list (each system or source you consulted and the key ` +
      `thing it showed), then the technical detail.`,
  );
  lines.push(
    `Commands you expect to run VERY long (a full e2e suite, a big build/seed — tens of minutes) ` +
      `should not block your reply: run them with Bash's run_in_background (or a background ` +
      `Task/Agent) and finish the reply with what you know so far — the orchestrator automatically ` +
      `posts each background completion to the Slack thread as a "🔔 Background update", so the ` +
      `user still gets the outcome; a ScheduleWakeup result is posted the same way — as a ` +
      `"🔔 Background update" in the thread, never as the turn's answer. For ordinary commands ` +
      `(unit tests, typecheck, installs), keep waiting normally — do NOT background things just ` +
      `to answer faster.`,
  );
  if (inp.sandbox.dind) {
    lines.push('', TOOLCHAIN);
  }
  if (inp.noGitHub) lines.push('', NO_GITHUB);
  if (packageRepos.length) {
    lines.push(
      '',
      `Private packages: this project's composer manifests pull from these private GitHub repos, ` +
        `and your credentials already cover them (both \`git clone\` and composer): ` +
        `${packageRepos.join(', ')}. Every checkout with a composer.json has an \`auth.json\` in its ` +
        `root (git-excluded, refreshed each turn) — composer picks it up automatically there. ` +
        // Only the pr flow ever runs composer outside the checkout.
        (pr
          ? `A git WORKTREE does NOT inherit it: before running composer in a worktree, copy it in first ` +
            `(\`cp <checkout>/auth.json <worktree>/\` — it stays untracked via the shared git exclude). `
          : '') +
        `Never commit auth.json or paste its contents anywhere.`,
    );
  }
  if (sourcesEnabled) {
    lines.push('', SOURCES_PROMPT_PARAGRAPH);
  }
  if (inp.messagingSend) {
    lines.push('', MESSAGING_PROMPT_PARAGRAPH);
  }
  if (slackUrl) {
    lines.push(
      '',
      pr
        ? `This conversation is the Slack thread ${slackUrl} — when you open a PR for work from it, ` +
            `include that link in the PR description (e.g. a "Slack thread: <url>" line) so reviewers can ` +
            `trace the change back to the discussion.`
        : `This conversation is the Slack thread ${slackUrl} — when you commit work from it, ` +
            `reference that link in the commit message (e.g. a "Slack thread: <url>" trailer line) so ` +
            `the change can be traced back to the discussion.`,
    );
  }
  if (projectPrompt?.trim()) {
    lines.push('', '--- Project-specific instructions ---', projectPrompt.trim());
  }
  return lines.join('\n');
}
