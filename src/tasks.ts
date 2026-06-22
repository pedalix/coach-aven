import type { Config } from './config.js';
import type { Store } from './state.js';
import { makeDaytona, ensureSnapshot, ensureSandbox, exec } from './daytona.js';
import { getGitHubToken } from './github.js';
import {
  seedGitHubAuth,
  seedClaudeAuth,
  seedMcpConfig,
  provisionTooling,
  cloneRepo,
  reapWorktrees,
  repoCheckout,
  repoName,
  projectDir,
} from './project.js';
import type { McpServerSpec } from './projects.js';
import { ClaudeSession, type OnQuestion } from './claudeSession.js';

// "Chat with the project": ensure the sandbox + clone ALL the project's repos, then
// drive a persistent Claude process over it (the agent can read AND edit; it pushes /
// opens a PR only if asked). Each ask() is a turn on the same long-lived conversation.
export interface ChatSession {
  // onStep receives a human-readable line per agent tool call (for live UI progress).
  // signal aborts the in-flight turn cleanly (→ throws 'canceled'). onQuestion is
  // invoked when the agent calls AskUserQuestion (→ render options as Slack buttons).
  ask(
    prompt: string,
    onStep?: (step: string) => void,
    signal?: AbortSignal,
    onQuestion?: OnQuestion,
  ): Promise<string>;
  // The Claude conversation id, known after the first turn. Persist it so a restarted
  // bot can resume the same thread via openChat({ resumeSessionId }).
  sessionId(): string | undefined;
  // The running Daytona command's coordinates — persist so a restarted bot can REATTACH
  // (openChat({ attach })) to the still-running claude instead of spawning a duplicate.
  attachInfo(): { sessionKey: string; cmdId: string } | undefined;
  // Recover the turn that was in flight when the bot last restarted: reattach + return its
  // result (from the snapshot if it finished during downtime, else wait for the live
  // result). ok=false when it couldn't be recovered (timeout/error/dead).
  adoptInflight(onStep?: (step: string) => void): Promise<{ ok: boolean; status: string; text: string }>;
  // One-shot flag: true once if a resume id was set but its transcript was gone (sandbox
  // rebuilt) so we started fresh — the caller should warn the user. Resets on read.
  contextLost(): boolean;
}

// Serialize per-sandbox preparation so two conversations sharing one project sandbox
// don't race on clone / auth-file writes / tooling install (a project = one sandbox).
const sandboxLocks = new Map<string, Promise<unknown>>();
function withSandboxLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prev = sandboxLocks.get(name) ?? Promise.resolve();
  const run = prev.then(fn, fn); // run fn after prev settles, regardless of outcome
  sandboxLocks.set(name, run.catch(() => {}));
  return run;
}

// Prepare a project's sandbox for the chat path: snapshot active, sandbox started,
// tooling + auth seeded, and ALL the project's repos cloned side by side. The GitHub
// token is scoped to exactly these repos. cwd is the single repo's dir when there's one
// repo, else the project root (so Claude sees every repo as a subdir).
async function prepareChat(cfg: Config, store: Store, slug: string, repos: string[]) {
  if (repos.length === 0) throw new Error(`project ${slug} has no repos`);
  const daytona = makeDaytona(cfg);
  await ensureSnapshot(daytona, cfg);

  const proj = store.upsertProject(slug, repos[0]);
  const sandbox = await ensureSandbox(daytona, cfg, proj.sandboxName, slug);
  await provisionTooling(sandbox);

  await seedGitHubAuth(sandbox, await getGitHubToken(cfg, repos));
  await seedClaudeAuth(sandbox, cfg.claudeOauthToken);

  for (const repo of repos) await cloneRepo(sandbox, cfg, slug, repo);
  // Agents work in per-task worktrees (see the base prompt); reap finished/orphaned ones.
  for (const repo of repos) await reapWorktrees(sandbox, repoCheckout(cfg, slug, repo));
  const cwd = repos.length === 1 ? repoCheckout(cfg, slug, repos[0]) : projectDir(cfg, slug);

  proj.clonedAt = proj.clonedAt ?? new Date().toISOString();
  store.setProject(proj);
  return { daytona, sandbox, proj, cwd };
}

// Layer 1 (orchestrator-owned) system prompt: the mechanics true for ALL projects —
// identity, repo layout, branch/PR convention, AskUserQuestion. `projectPrompt` (layer 2,
// from the project config) is APPENDED after it, never overrides. (Layer 3 = each repo's
// own CLAUDE.md, auto-loaded by Claude Code when working in that repo.)
function buildSystemPrompt(slug: string, cwd: string, repos: string[], projectPrompt?: string): string {
  const lines = [`You are the coding assistant for the project "${slug}", reachable from a Slack channel.`];
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
    `To make changes, work in a DEDICATED git worktree forked from the fresh remote default — never ` +
      `edit the shared checkout in place (this sandbox is reused across sessions and may be left on an ` +
      `old branch from previous work). In the relevant repo: ` +
      `(1) \`git fetch origin\`; ` +
      `(2) \`git worktree add -b <branch> <path> origin/main\` — fork from the fresh remote default ` +
      `(usually main; if unsure, check \`git remote show origin\` for "HEAD branch"), and put <path> in ` +
      `a sibling dir, e.g. ../<repo>-wt/<branch>; ` +
      `(3) cd into <path>, make your changes there, commit, push, and open a PR against the default ` +
      `branch with the gh CLI; ` +
      `(4) when the PR is open you may \`git worktree remove <path>\` (the orchestrator also reaps ` +
      `finished worktrees automatically). ` +
      `For a change spanning multiple repos, do this in each relevant repo, sharing a ` +
      `feature name and noting the merge order in the PR descriptions. ` +
      `Replies render in Slack — be concise and use code blocks for code. ` +
      `When a decision is yours to make but you're genuinely unsure between approaches, or an ` +
      `action is risky/irreversible, use the AskUserQuestion tool to present the options instead ` +
      `of guessing — the user answers with a button click.`,
  );
  if (projectPrompt?.trim()) {
    lines.push('', '--- Project-specific instructions ---', projectPrompt.trim());
  }
  return lines.join('\n');
}

// Claude stores a session's transcript at ~/.claude/projects/<cwd with '/'→'-'>/<id>.jsonl.
// Resuming an id whose transcript isn't flushed/real fails silently — verify it first
// (file non-empty AND contains at least one real entry), else start fresh.
async function sessionTranscriptValid(
  sandbox: Awaited<ReturnType<typeof ensureSandbox>>,
  cwd: string,
  id: string,
): Promise<boolean> {
  const path = `/root/.claude/projects/${cwd.replace(/\//g, '-')}/${id}.jsonl`;
  const r = await exec(sandbox, `test -s ${path} && grep -ql '"uuid"' ${path} && echo ok || echo no`);
  return r.result.trim() === 'ok';
}

export async function openChat(
  cfg: Config,
  store: Store,
  opts: {
    slug: string;
    repos: string[];
    resumeSessionId?: string;
    systemPrompt?: string;
    mcp?: McpServerSpec[];
    // A still-running Daytona command from before a bot restart — reattach to it instead
    // of spawning a fresh process (tried once; falls back to --resume if it's gone).
    attach?: { sessionKey: string; cmdId: string };
    // Called whenever a session (re)opens, with its command coords — persist immediately
    // so even a mid-FIRST-turn crash leaves a reattachable record.
    onOpen?: (info: { sessionKey: string; cmdId: string }) => void;
  },
): Promise<ChatSession> {
  const prep = await withSandboxLock(opts.slug, () => prepareChat(cfg, store, opts.slug, opts.repos));
  const { daytona, proj, cwd } = prep;
  let sandbox = prep.sandbox;
  let sessionId: string | undefined = opts.resumeSessionId;
  let session: ClaudeSession | undefined;
  let droppedResume = false;
  let attach = opts.attach; // consumed once: cleared after the first (re)open attempt
  const systemPrompt = buildSystemPrompt(opts.slug, cwd, opts.repos, opts.systemPrompt);
  const emitOpen = () => {
    const a = session?.attachInfo();
    if (a) opts.onOpen?.(a);
  };

  // Wake the sandbox (it auto-stops on idle) + re-seed the CC token & MCP config (in case
  // a restart reset the fs), then (re)open the persistent Claude process if we don't have
  // a live one. Sandbox-scoped lock: don't let siblings re-prepare the box concurrently.
  async function ensureSession(): Promise<ClaudeSession> {
    if (session && !session.isDead()) {
      await withSandboxLock(opts.slug, async () => {
        sandbox = await ensureSandbox(daytona, cfg, proj.sandboxName, opts.slug);
        await seedClaudeAuth(sandbox, cfg.claudeOauthToken);
        await seedMcpConfig(sandbox, opts.mcp);
      });
      return session;
    }
    return withSandboxLock(opts.slug, async () => {
      if (session && !session.isDead()) return session;
      sandbox = await ensureSandbox(daytona, cfg, proj.sandboxName, opts.slug);
      await seedClaudeAuth(sandbox, cfg.claudeOauthToken);
      const mcpConfigPath = await seedMcpConfig(sandbox, opts.mcp);
      // Bot restarted while a command was still running? Reattach to it once, rather than
      // spawning a duplicate that would fight over the same working tree. If the command
      // already finished/vanished, attach throws → fall through to a fresh --resume open.
      if (attach) {
        const target = attach;
        attach = undefined;
        try {
          const reattached = new ClaudeSession(sandbox, {
            cwd,
            systemPrompt,
            mcpConfigPath,
            attach: target,
            resumeSessionId: sessionId, // seed claudeSessionId; not used to relaunch
          });
          await reattached.open();
          session = reattached;
          emitOpen();
          return session;
        } catch {
          /* command gone → fresh open below */
        }
      }
      let resume: string | undefined;
      if (sessionId) {
        if (await sessionTranscriptValid(sandbox, cwd, sessionId)) resume = sessionId;
        else droppedResume = true; // had an id but its transcript is gone → start fresh
      }
      session = new ClaudeSession(sandbox, { cwd, resumeSessionId: resume, systemPrompt, mcpConfigPath });
      await session.open();
      emitOpen();
      return session;
    });
  }

  return {
    sessionId: () => sessionId,
    attachInfo: () => session?.attachInfo(),
    contextLost: () => {
      const v = droppedResume;
      droppedResume = false;
      return v;
    },
    ask: async (
      prompt: string,
      onStep?: (step: string) => void,
      signal?: AbortSignal,
      onQuestion?: OnQuestion,
    ): Promise<string> => {
      let s = await ensureSession();
      let r = await s.send(prompt, onStep, signal, onQuestion);
      // Retry ONLY if the process died before the turn produced any output (started ===
      // false) — re-sending a turn that already ran tools could double-apply (duplicate
      // commits/PRs). A turn that began mutating is surfaced as an error instead.
      if (r.status === 'error' && !r.started && !signal?.aborted) {
        session = undefined;
        s = await ensureSession();
        r = await s.send(prompt, onStep, signal, onQuestion);
      }
      if (s.sessionId()) sessionId = s.sessionId(); // track from init/result (covers forks)

      if (r.status === 'canceled') throw new Error('canceled');
      if (r.status === 'timeout') throw new Error('timed out (no result within the time limit)');
      if (r.status === 'busy') throw new Error('the session is busy with another turn — try again');
      if (r.status === 'error' || r.isError) {
        const base = r.resultText?.trim() || 'claude error';
        throw new Error(
          r.started
            ? `${base}\n(the turn was interrupted mid-execution — check the repo state before resending)`
            : base,
        );
      }
      return r.resultText.trim() || '(no output)';
    },
    adoptInflight: async (onStep?: (step: string) => void) => {
      const s = await ensureSession(); // reattach (attach path) — parses the snapshot
      const r = await s.adoptInflight(onStep);
      if (s.sessionId()) sessionId = s.sessionId();
      const ok = r.status === 'ok' && !r.isError;
      return { ok, status: r.status, text: r.resultText.trim() || '(no output)' };
    },
  };
}
