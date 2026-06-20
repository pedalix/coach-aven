import type { Config } from './config.js';
import type { Store } from './state.js';
import { makeDaytona, ensureSnapshot, ensureSandbox, exec } from './daytona.js';
import { getGitHubToken } from './github.js';
import {
  seedGitHubAuth,
  seedClaudeAuth,
  provisionTooling,
  cloneRepo,
  repoCheckout,
  repoName,
  projectDir,
} from './project.js';
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
  const cwd = repos.length === 1 ? repoCheckout(cfg, slug, repos[0]) : projectDir(cfg, slug);

  proj.clonedAt = proj.clonedAt ?? new Date().toISOString();
  store.setProject(proj);
  return { daytona, sandbox, proj, cwd };
}

// Orient the agent: who it is, where the repos live (esp. multi-repo), how to work.
function buildSystemPrompt(slug: string, cwd: string, repos: string[]): string {
  const lines = [`You are the coding assistant for the project "${slug}", reachable from a Slack channel.`];
  if (repos.length === 1) {
    lines.push(`Your working directory is the repository ${repos[0]} (cwd: ${cwd}).`);
  } else {
    lines.push(`This project has ${repos.length} repositories cloned side by side under ${cwd} (your cwd):`);
    for (const r of repos) lines.push(`  - ${repoName(r)}/   (${r})`);
    lines.push(`Each is its own git checkout — read that repo's own CLAUDE.md when you work in it.`);
  }
  lines.push(
    `To make changes, create a branch in the relevant repository and open a PR with the gh CLI. ` +
      `Replies render in Slack — be concise and use code blocks for code. ` +
      `When a decision is yours to make but you're genuinely unsure between approaches, or an ` +
      `action is risky/irreversible, use the AskUserQuestion tool to present the options instead ` +
      `of guessing — the user answers with a button click.`,
  );
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
  opts: { slug: string; repos: string[]; resumeSessionId?: string },
): Promise<ChatSession> {
  const prep = await withSandboxLock(opts.slug, () => prepareChat(cfg, store, opts.slug, opts.repos));
  const { daytona, proj, cwd } = prep;
  let sandbox = prep.sandbox;
  let sessionId: string | undefined = opts.resumeSessionId;
  let session: ClaudeSession | undefined;
  let droppedResume = false;
  const systemPrompt = buildSystemPrompt(opts.slug, cwd, opts.repos);

  // Wake the sandbox (it auto-stops on idle) + re-seed the CC token, then (re)open the
  // persistent Claude process if we don't have a live one (first turn, or after death).
  // Sandbox-scoped lock: don't let sibling conversations re-prepare the box concurrently.
  async function ensureSession(): Promise<ClaudeSession> {
    if (session && !session.isDead()) {
      // still need to keep the box awake + token fresh for the next turn
      await withSandboxLock(opts.slug, async () => {
        sandbox = await ensureSandbox(daytona, cfg, proj.sandboxName, opts.slug);
        await seedClaudeAuth(sandbox, cfg.claudeOauthToken);
      });
      return session;
    }
    return withSandboxLock(opts.slug, async () => {
      if (session && !session.isDead()) return session;
      sandbox = await ensureSandbox(daytona, cfg, proj.sandboxName, opts.slug);
      await seedClaudeAuth(sandbox, cfg.claudeOauthToken);
      let resume: string | undefined;
      if (sessionId) {
        if (await sessionTranscriptValid(sandbox, cwd, sessionId)) resume = sessionId;
        else droppedResume = true; // had an id but its transcript is gone → start fresh
      }
      session = new ClaudeSession(sandbox, { cwd, resumeSessionId: resume, systemPrompt });
      await session.open();
      return session;
    });
  }

  return {
    sessionId: () => sessionId,
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
  };
}
