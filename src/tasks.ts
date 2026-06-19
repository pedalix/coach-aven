import type { Config } from './config.js';
import type { Store, TaskRecord } from './state.js';
import { makeDaytona, ensureSnapshot, ensureSandbox, exec } from './daytona.js';
import { getGitHubToken } from './github.js';
import {
  ensureClone,
  addWorktree,
  seedGitHubAuth,
  seedClaudeAuth,
  provisionTooling,
  worktreeDir,
  cloneRepo,
  repoCheckout,
  projectDir,
} from './project.js';
import {
  runHeadless,
  startInteractive,
  streamClaude,
  type InteractiveSession,
  type StreamResult,
} from './agent.js';
import { log } from './log.js';

// Short, filesystem-safe task id.
function newTaskId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Prepare a project's warm sandbox: snapshot active, sandbox started, repo cloned,
// GitHub auth seeded. Returns the live Sandbox + default branch. Idempotent.
async function prepareProject(cfg: Config, store: Store, slug: string, repo: string) {
  const daytona = makeDaytona(cfg);
  await ensureSnapshot(daytona, cfg);

  const proj = store.upsertProject(slug, repo);
  const sandbox = await ensureSandbox(daytona, cfg, proj.sandboxName, slug);
  await provisionTooling(sandbox);

  const token = await getGitHubToken(cfg, [repo]);
  await seedGitHubAuth(sandbox, token);
  await seedClaudeAuth(sandbox, cfg.claudeOauthToken);

  const { defaultBranch } = await ensureClone(sandbox, cfg, proj);
  proj.defaultBranch = defaultBranch;
  proj.clonedAt = proj.clonedAt ?? new Date().toISOString();
  store.setProject(proj);

  return { daytona, sandbox, proj, defaultBranch, token };
}

export interface RunTaskOpts {
  slug: string;
  repo: string; // "Org/name"
  prompt: string;
  draftPr?: boolean;
}

// End-to-end: ensure sandbox → worktree → headless agent → push → open PR.
export async function runTask(cfg: Config, store: Store, opts: RunTaskOpts): Promise<TaskRecord> {
  const { sandbox, defaultBranch } = await prepareProject(cfg, store, opts.slug, opts.repo);

  const taskId = newTaskId();
  const { worktreePath, branch, composeProject } = await addWorktree(
    sandbox,
    cfg,
    opts.slug,
    taskId,
    defaultBranch,
  );

  const now = () => new Date().toISOString();
  const task: TaskRecord = {
    id: taskId,
    branch,
    worktreePath,
    composeProject,
    prompt: opts.prompt,
    status: 'running',
    createdAt: now(),
    updatedAt: now(),
  };
  store.upsertTask(opts.slug, task);

  log.step(`running agent on task ${taskId} (branch ${branch})`);
  const result = await runHeadless(sandbox, {
    cwd: worktreePath,
    prompt: opts.prompt,
    composeProject,
  });

  if (result.exitCode !== 0) {
    task.status = 'failed';
    task.updatedAt = now();
    store.upsertTask(opts.slug, task);
    log.error(`agent exited ${result.exitCode} for task ${taskId}`);
    return task;
  }

  // Commit anything the agent left uncommitted, then push + open a PR.
  await exec(sandbox, `git -C ${worktreePath} add -A`, { check: true });
  const diff = await exec(sandbox, `git -C ${worktreePath} diff --cached --quiet; echo $?`);
  if (diff.result.trim() !== '0') {
    await exec(
      sandbox,
      `git -C ${worktreePath} commit -m ${shArg(`task ${taskId}: ${firstLine(opts.prompt)}`)}`,
      { check: true },
    );
  }
  await exec(sandbox, `git -C ${worktreePath} push -u origin ${branch}`, {
    check: true,
    timeout: 600,
  });

  const prFlag = opts.draftPr ? '--draft ' : '';
  const pr = await exec(
    sandbox,
    `cd ${worktreePath} && gh pr create ${prFlag}--fill --head ${branch} --base ${defaultBranch}`,
    { timeout: 120 },
  );
  const prUrl = (pr.result.match(/https:\/\/github\.com\/\S+/) || [])[0];

  task.status = 'done';
  task.prUrl = prUrl;
  task.updatedAt = now();
  store.upsertTask(opts.slug, task);
  log.info(`task ${taskId} done${prUrl ? ` — ${prUrl}` : ''}`);
  return task;
}

// "Chat with the project": ensure the sandbox + clone ALL the project's repos, then
// open a chat session against them (one repo → that repo's dir; many → the project
// root, so Claude sees each repo as a subdir). The agent can read AND edit; it pushes
// or opens a PR only if asked. Each ask() chains Claude's session via --resume.
export interface ChatSession {
  // onStep receives a human-readable line per agent tool call (for live UI progress).
  // signal aborts the in-flight turn (→ throws 'canceled').
  ask(prompt: string, onStep?: (step: string) => void, signal?: AbortSignal): Promise<string>;
  // The Claude conversation id, known after the first ask(). Persist it so a
  // restarted bot can resume the same thread via openChat({ resumeSessionId }).
  sessionId(): string | undefined;
}

// Prepare a project's sandbox for the CHAT path: snapshot active, sandbox started,
// tooling + auth seeded, and ALL the project's repos cloned side by side. The GitHub
// token is scoped to exactly these repos. cwd is the single repo's dir when there's
// one repo, else the project root (so Claude sees every repo as a subdir).
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

export async function openChat(
  cfg: Config,
  store: Store,
  opts: { slug: string; repos: string[]; resumeSessionId?: string },
): Promise<ChatSession> {
  const prep = await prepareChat(cfg, store, opts.slug, opts.repos);
  const { daytona, proj, cwd } = prep;
  let sandbox = prep.sandbox;
  let sessionId: string | undefined = opts.resumeSessionId;

  return {
    sessionId: () => sessionId,
    ask: async (
      prompt: string,
      onStep?: (step: string) => void,
      signal?: AbortSignal,
    ): Promise<string> => {
      // A cached chat session reuses a sandbox handle that may have auto-stopped on
      // idle. Wake it before exec (ensureSandbox is idempotent — fast when running,
      // starts it when stopped) and re-seed the CC token in case a restart reset the
      // filesystem. Source of truth is Daytona's state, not a keepalive we track.
      sandbox = await ensureSandbox(daytona, cfg, proj.sandboxName, opts.slug);
      await seedClaudeAuth(sandbox, cfg.claudeOauthToken);
      const run = () =>
        streamClaude(sandbox, { cwd, prompt, resumeSessionId: sessionId, onStep, signal });

      let r: StreamResult;
      try {
        r = await run();
      } catch (e) {
        if (!isSandboxAsleep(e)) throw e;
        // Stopped in the race between ensure and exec — wake and retry once.
        log.warn('sandbox went down mid-request — waking and retrying');
        sandbox = await ensureSandbox(daytona, cfg, proj.sandboxName, opts.slug);
        await seedClaudeAuth(sandbox, cfg.claudeOauthToken);
        r = await run();
      }

      if (r.status === 'canceled') throw new Error('canceled');
      if (r.status === 'timeout') throw new Error('timed out (no result within the time limit)');
      if (r.exitCode !== 0 || r.isError) {
        throw new Error(r.resultText?.trim() || `claude exited ${r.exitCode}`);
      }
      if (r.sessionId) sessionId = r.sessionId; // chain the conversation
      return r.resultText.trim() || '(no output)';
    },
  };
}

// A stopped/asleep sandbox surfaces as a toolbox "can't resolve container IP" error.
function isSandboxAsleep(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /resolve container IP|no IP address|not started|not running|Sandbox started/i.test(m);
}

// One-shot convenience (used by `chat -p`).
export async function chatTask(
  cfg: Config,
  store: Store,
  opts: { slug: string; repo: string; prompt: string },
): Promise<string> {
  const chat = await openChat(cfg, store, { slug: opts.slug, repos: [opts.repo] });
  log.step('asking the agent (first question explores the repo — can take a minute)…');
  return chat.ask(opts.prompt);
}

// Open an interactive session against an existing task's worktree, for sending
// follow-up messages to a live agent.
export async function attachTask(
  cfg: Config,
  store: Store,
  slug: string,
  taskId: string,
  onData: (text: string) => void,
): Promise<InteractiveSession> {
  const proj = store.getProject(slug);
  if (!proj) throw new Error(`Unknown project: ${slug}`);
  const task = proj.tasks[taskId];
  if (!task) throw new Error(`Unknown task: ${taskId}`);

  const daytona = makeDaytona(cfg);
  const sandbox = await ensureSandbox(daytona, cfg, proj.sandboxName, slug);
  // refresh GH + CC auth in case the prior tokens expired
  await seedGitHubAuth(sandbox, await getGitHubToken(cfg, [proj.repo]));
  await seedClaudeAuth(sandbox, cfg.claudeOauthToken);

  return startInteractive(sandbox, {
    cwd: task.worktreePath || worktreeDir(cfg, slug, taskId),
    composeProject: task.composeProject,
    sessionId: `pty-${taskId}`,
    onData,
  });
}

function firstLine(s: string): string {
  return s.split('\n')[0].slice(0, 72);
}
function shArg(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
