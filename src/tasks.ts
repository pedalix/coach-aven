import type { Config, SandboxDriverKind } from './config.js';
import type { Store } from './state.js';
import { createDriver, type SandboxHandle } from './driver.js';
import { getGitHubToken } from './github.js';
import {
  seedGitHubAuth,
  seedClaudeAuth,
  seedComposerAuth,
  seedMcpConfig,
  seedGatewayAuth,
  provisionTooling,
  ensureDockerd,
  cloneRepo,
  reapWorktrees,
  repoCheckout,
  projectCwd,
} from './project.js';
import { dispatch } from './dispatch.js';
import type { HostServerRoute } from './hosttools.js';
import { buildSystemPrompt } from './prompt.js';
import type { GitFlow, McpServerSpec } from './projects.js';
import { resolveSandboxOptions, type SandboxOptions } from './sandboxopts.js';
import { FactStore } from './facts.js';
import { reachableDependencyRepos, scanDependencyRepos, tokenRepos } from './deps.js';
import { restoreMemoryIfEmpty } from './memjournal.js';
import { ClaudeSession, type OnQuestion, type TurnUsage } from './claudeSession.js';

// Project facts (facts/<slug>.json) — derived, machine-written state; today just the
// `depends_on_repos` fact the deps scanner writes at prepare time and the token mint reads.
const facts = new FactStore();

// The GitHub token for a project covers its repos PLUS the same-org dependency repos on
// record (private composer packages) — see deps.ts. Before the first scan the fact is
// empty and the scope is just the project's repos, which is all cloning needs.
const scopedRepos = (slug: string, repos: string[]) => tokenRepos(repos, facts.dependsOnRepos(slug));
import {
  planIngest,
  downloadAttachment,
  normalizeImage,
  isImage,
  inboxDir,
  inboxPath,
  attachmentPreamble,
  type AttachmentRef,
} from './attachments.js';

// "Chat with the project": ensure the sandbox + clone ALL the project's repos, then
// drive a persistent Claude process over it (the agent can read AND edit; it pushes /
// opens a PR only if asked). Each ask() is a turn on the same long-lived conversation.
import type { RateLimitInfo } from './ratelimit.js';

export interface ChatSession {
  // onStep receives a human-readable line per agent tool call (for live UI progress).
  // signal aborts the in-flight turn cleanly (→ throws 'canceled'). onQuestion is
  // invoked when the agent calls AskUserQuestion (→ render options as Slack buttons).
  // onLongRunning makes the turn's runtime limit SOFT: it fires once at the soft
  // deadline ("still working…" to the thread) and the turn keeps going to the hard cap
  // instead of erroring — without it the old kill-at-soft-deadline applies.
  ask(
    prompt: string,
    onStep?: (step: string) => void,
    signal?: AbortSignal,
    onQuestion?: OnQuestion,
    onLongRunning?: () => void,
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
  adoptInflight(
    onStep?: (step: string) => void,
    onLongRunning?: () => void,
  ): Promise<{ ok: boolean; status: string; text: string }>;
  // One-shot flag: true once if a resume id was set but its transcript was gone (sandbox
  // rebuilt) so we started fresh — the caller should warn the user. Resets on read.
  contextLost(): boolean;
  // Token/cost accounting of the LAST settled ask/adoptInflight (from the CLI's result
  // event; undefined when the turn ended without one). Read by the usage metering.
  lastUsage(): TurnUsage | undefined;
  // Download inbound attachments (Slack files / YouTrack ticket files) with `bearer` and drop
  // them into this turn's sandbox inbox so the agent can Read them. Returns a prompt preamble
  // naming the saved paths (and any skipped files) — '' if there's nothing to add — plus the
  // structured skip list, which the turn engine turns into a deterministic user-facing notice
  // (skippedNotice) rather than trusting the agent to relay it.
  ingest(
    refs: AttachmentRef[],
    bearer: string,
    turnId: string,
  ): Promise<{ preamble: string; skipped: { name: string; reason: string }[] }>;
  // Kill the sandbox-side persistent session-command and mark this object dead — an
  // explicit "forget this conversation" (vs. the LRU/prune paths, which only drop the
  // reference and let the sandbox's own idle lifecycle reap the process eventually).
  close(): Promise<void>;
  // Point (or clear) the callback for a background Task/Agent that finishes AFTER its
  // owning turn already settled (see ClaudeSession.onIdleResult). Callers re-set this on
  // every turn so it always targets the CURRENT channel/thread — it self-heals across
  // session recreation (LRU eviction, the error-retry reopen, post-restart reattach).
  setIdleNotify(fn: ((text: string) => void) | undefined): void;
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
// token is scoped to exactly these repos plus the dependency repos their manifests
// reference (deps scanner → facts). cwd is the single repo's dir when there's one repo,
// else the project root (so Claude sees every repo as a subdir).
async function prepareChat(
  cfg: Config,
  store: Store,
  slug: string,
  repos: string[],
  driverKind?: SandboxDriverKind,
  cliVersion?: string,
  upgradeCli?: boolean,
  sandboxOpts?: SandboxOptions,
) {
  if (repos.length === 0) throw new Error(`project ${slug} has no repos`);
  const driver = createDriver(cfg, driverKind);
  await driver.ensureImage();

  const proj = store.upsertProject(slug, repos[0], cfg.sandbox.namePrefix);
  const sandbox = await driver.ensureSandbox(proj.sandboxName, slug, sandboxOpts);
  await provisionTooling(sandbox, { cliVersion, upgradeCli, where: proj.sandboxName });
  // dockerd liveness guard: a dead daemon breaks Sail (php/composer/artisan shims) for
  // every turn until revived — catch it here rather than mid-conversation. A plain project
  // (sandbox.dind === false) has no dockerd to guard — the probe would only ever "fail".
  if (sandboxOpts?.dind !== false) await ensureDockerd(sandbox, slug);

  const scopeBefore = scopedRepos(slug, repos);
  await seedGitHubAuth(sandbox, await getGitHubToken(cfg, scopeBefore));
  await seedClaudeAuth(sandbox, cfg.claudeOauthToken);

  for (const repo of repos) await cloneRepo(sandbox, cfg, slug, repo);
  // Writer: scan the fresh checkouts' manifests → `depends_on_repos` fact. Readers: if the
  // token scope changed (first session, or a repo gained/lost a private package), re-mint
  // so this session's token already covers the packages; then mirror it into composer's
  // auth.json in every checkout that has a composer.json.
  const checkouts = repos.map((repo) => ({ repo, dir: repoCheckout(cfg, slug, repo) }));
  await scanDependencyRepos(sandbox, facts, slug, checkouts);
  const scopeAfter = scopedRepos(slug, repos);
  if (scopeAfter.join() !== scopeBefore.join()) {
    await seedGitHubAuth(sandbox, await getGitHubToken(cfg, scopeAfter));
  }
  await seedComposerAuth(sandbox, checkouts.map((c) => c.dir));
  // Agents on the `pr` flow work in per-task worktrees (prompt.ts); reap finished/orphaned
  // ones — a no-op for a `direct` project, which never creates any.
  for (const repo of repos) await reapWorktrees(sandbox, repoCheckout(cfg, slug, repo));
  const cwd = projectCwd(cfg, slug, repos);
  // Seed memory from the host journal only when this sandbox has none yet (a fresh rebuild) —
  // a warm sandbox is the newer source of truth and is left untouched.
  await restoreMemoryIfEmpty(sandbox, cfg, slug, repos);

  proj.clonedAt = proj.clonedAt ?? new Date().toISOString();
  store.setProject(proj);
  return { driver, sandbox, proj, cwd };
}

// Claude stores a session's transcript at ~/.claude/projects/<cwd with '/'→'-'>/<id>.jsonl.
// Resuming an id whose transcript isn't flushed/real fails silently — verify it first
// (file non-empty AND contains at least one real entry), else start fresh.
async function sessionTranscriptValid(
  sandbox: SandboxHandle,
  cwd: string,
  id: string,
): Promise<boolean> {
  const path = `/root/.claude/projects/${cwd.replace(/\//g, '-')}/${id}.jsonl`;
  const r = await sandbox.exec(`test -s ${path} && grep -ql '"uuid"' ${path} && echo ok || echo no`);
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
    // Permalink to the Slack thread, woven into the system prompt so the agent can link a
    // PR back to the discussion. Set only for channel threads (DMs have no shareable link).
    slackUrl?: string;
    // ProjectConfig.gitFlow — worktree + PR (default) or commits on the checkout's branch; it
    // shapes the base prompt (prompt.ts). Read at open: a running conversation keeps its flow.
    gitFlow?: GitFlow;
    mcp?: McpServerSpec[];
    // Conversation id for the MCP gateway audit (x-aven-session via the headers helper).
    avenSession?: string;
    // The project's sandbox provider (ProjectConfig.driver); omitted → deployment default.
    driver?: SandboxDriverKind;
    // A still-running Daytona command from before a bot restart — reattach to it instead
    // of spawning a fresh process (tried once; falls back to --resume if it's gone).
    attach?: { sessionKey: string; cmdId: string };
    // Called whenever a session (re)opens, with its command coords — persist immediately
    // so even a mid-FIRST-turn crash leaves a reattachable record.
    onOpen?: (info: { sessionKey: string; cmdId: string }) => void;
    // The CLI's per-turn quota signal (ratelimit.ts) — one shared subscription, so the
    // engine funnels every session's events into one tracker.
    onRateLimit?: (info: RateLimitInfo) => void;
    // Cost of a turn the CLI ran on its own (a background Task/Agent finishing after its
    // owning turn settled) — see ClaudeSession.onIdleUsage. Set once at open, like
    // onRateLimit, so it covers no-UI asks and dreams too.
    onIdleUsage?: ClaudeSession['onIdleUsage'];
    // Claude Code CLI pin for this sandbox and whether prep may install it now (false while
    // another turn runs on the project) — see provisionTooling / cliversion.ts.
    cliVersion?: string;
    upgradeCli?: boolean;
    // Per-project container options (ProjectConfig.sandbox) — creation-time flags + mounts.
    sandbox?: SandboxOptions;
    // ProjectConfig.scrubSecrets; undefined → on. See claudeSession.ts / scrub.ts.
    scrubSecrets?: boolean;
    // ProjectConfig.sources present → the system prompt explains the `sources` tools; the server
    // itself is one of `hostServers` (served by the bot over the control channel, hostrouter.ts).
    sources?: boolean;
    // The bot-served MCP servers this session registers (host tools, channel-served sources).
    // Empty/absent → nothing is registered and the session is byte-identical to today's.
    hostServers?: HostServerRoute[];
  },
): Promise<ChatSession> {
  const sourcesEnabled = opts.sources === true;
  // The sandbox's own MCP list is exactly the project's: bot-served servers never appear in it.
  const mcp = opts.mcp;
  const prep = await withSandboxLock(opts.slug, () =>
    prepareChat(cfg, store, opts.slug, opts.repos, opts.driver, opts.cliVersion, opts.upgradeCli, opts.sandbox),
  );
  const { driver, proj, cwd } = prep;
  let sandbox = prep.sandbox;
  let sessionId: string | undefined = opts.resumeSessionId;
  let session: ClaudeSession | undefined;
  let droppedResume = false;
  let lastUsage: TurnUsage | undefined;
  let attach = opts.attach; // consumed once: cleared after the first (re)open attempt
  // See ChatSession.setIdleNotify — re-applied to `session` every time one is (re)created,
  // so it survives LRU eviction, the error-retry reopen below, and restart reattach.
  let idleNotify: ((text: string) => void) | undefined;
  const systemPrompt = buildSystemPrompt({
    slug: opts.slug,
    cwd,
    repos: opts.repos,
    projectPrompt: opts.systemPrompt,
    slackUrl: opts.slackUrl,
    packageRepos: reachableDependencyRepos(opts.repos, facts.dependsOnRepos(opts.slug)),
    sourcesEnabled,
    dispatchEnabled: dispatch.enabled,
    gitFlow: opts.gitFlow,
    // Resolved again here (loadProjects already validated it) so the prompt sees the same
    // dind answer as the dockerd guard in prepareChat.
    sandbox: resolveSandboxOptions(opts.sandbox),
  });
  const emitOpen = () => {
    const a = session?.attachInfo();
    if (a) opts.onOpen?.(a);
  };

  // Wake the sandbox (it auto-stops on idle) + re-seed the CC token, the GitHub token, &
  // MCP config, then (re)open the persistent Claude process if we don't have a live one.
  // Re-seeding the GitHub token EVERY turn is load-bearing: it's a ~1h installation token,
  // so a warm sandbox that handled the first message would otherwise hit "Bad credentials"
  // on a later `git push`/`gh pr create` (e.g. topping up commits on an open PR an hour on).
  // Sandbox-scoped lock: don't let siblings re-prepare the box concurrently.
  async function ensureSession(): Promise<ClaudeSession> {
    if (session && !session.isDead()) {
      await withSandboxLock(opts.slug, async () => {
        sandbox = await driver.ensureSandbox(proj.sandboxName, opts.slug, opts.sandbox);
        await seedClaudeAuth(sandbox, cfg.claudeOauthToken);
        await seedGitHubAuth(sandbox, await getGitHubToken(cfg, scopedRepos(opts.slug, opts.repos)));
        await seedComposerAuth(sandbox, opts.repos.map((r) => repoCheckout(cfg, opts.slug, r)));
        await seedMcpConfig(sandbox, mcp);
        await seedGatewayAuth(sandbox, opts.slug, mcp);
      });
      return session;
    }
    return withSandboxLock(opts.slug, async () => {
      if (session && !session.isDead()) return session;
      sandbox = await driver.ensureSandbox(proj.sandboxName, opts.slug, opts.sandbox);
      await seedClaudeAuth(sandbox, cfg.claudeOauthToken);
      await seedGitHubAuth(sandbox, await getGitHubToken(cfg, scopedRepos(opts.slug, opts.repos)));
      await seedComposerAuth(sandbox, opts.repos.map((r) => repoCheckout(cfg, opts.slug, r)));
      const mcpConfigPath = await seedMcpConfig(sandbox, mcp);
      await seedGatewayAuth(sandbox, opts.slug, mcp);
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
            avenSession: opts.avenSession,
            scrubSecrets: opts.scrubSecrets,
            hostServers: opts.hostServers,
            attach: target,
            resumeSessionId: sessionId, // seed claudeSessionId; not used to relaunch
          });
          await reattached.open();
          session = reattached;
          session.onIdleResult = idleNotify;
          session.onRateLimit = opts.onRateLimit;
          session.onIdleUsage = opts.onIdleUsage;
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
      session = new ClaudeSession(sandbox, {
        cwd,
        resumeSessionId: resume,
        systemPrompt,
        mcpConfigPath,
        avenSession: opts.avenSession,
        scrubSecrets: opts.scrubSecrets,
        hostServers: opts.hostServers,
        model: cfg.claudeModel,
      });
      session.onIdleResult = idleNotify;
      session.onRateLimit = opts.onRateLimit;
      session.onIdleUsage = opts.onIdleUsage;
      await session.open();
      emitOpen();
      return session;
    });
  }

  return {
    sessionId: () => sessionId,
    attachInfo: () => session?.attachInfo(),
    close: async () => {
      await session?.close();
    },
    setIdleNotify: (fn) => {
      idleNotify = fn;
      if (session) session.onIdleResult = fn;
    },
    contextLost: () => {
      const v = droppedResume;
      droppedResume = false;
      return v;
    },
    ingest: async (refs: AttachmentRef[], bearer: string, turnId: string) => {
      if (!refs.length) return { preamble: '', skipped: [] };
      const { accept, skipped } = planIngest(refs);
      const kept: { path: string; name: string }[] = [];
      const warnings: string[] = [];
      if (accept.length) {
        // Ensure the sandbox is awake before writing (ask() does the same via ensureSession);
        // then create the per-turn inbox once and upload each downloaded file into it.
        await ensureSession();
        await sandbox.exec(`mkdir -p ${inboxDir(turnId)}`);
        for (let i = 0; i < accept.length; i++) {
          const ref = accept[i];
          try {
            const buf = await downloadAttachment(ref, bearer);
            if (!buf) {
              skipped.push({ name: ref.name, reason: 'download failed' });
              continue;
            }
            // Images: downscale to fit Claude Code's Read cap (2000×2000) BEFORE upload, so the
            // agent's first Read just works instead of hand-rolling a resizer. On decode failure
            // we still ship the original and warn — the sandbox `magick` tool is the fallback.
            let data = buf;
            if (isImage(ref.mime, ref.name)) {
              const norm = await normalizeImage(buf);
              data = norm.buf;
              if (norm.failed) warnings.push(`${ref.name} couldn't be pre-scaled; if Read says it's too big, resize it with \`magick\` first`);
            }
            const path = inboxPath(turnId, i + 1, ref.name);
            await sandbox.uploadFile(data, path);
            kept.push({ path, name: ref.name });
          } catch {
            skipped.push({ name: ref.name, reason: 'download failed' });
          }
        }
      }
      return { preamble: attachmentPreamble(kept, skipped, warnings), skipped };
    },
    ask: async (
      prompt: string,
      onStep?: (step: string) => void,
      signal?: AbortSignal,
      onQuestion?: OnQuestion,
      onLongRunning?: () => void,
    ): Promise<string> => {
      let s = await ensureSession();
      let r = await s.send(prompt, onStep, signal, onQuestion, onLongRunning);
      // Retry ONLY if the process died before the turn produced any output (started ===
      // false) — re-sending a turn that already ran tools could double-apply (duplicate
      // commits/PRs). A turn that began mutating is surfaced as an error instead.
      if (r.status === 'error' && !r.started && !signal?.aborted) {
        session = undefined;
        s = await ensureSession();
        r = await s.send(prompt, onStep, signal, onQuestion, onLongRunning);
      }
      if (s.sessionId()) sessionId = s.sessionId(); // track from init/result (covers forks)
      lastUsage = r.usage; // recorded even for canceled/errored turns — tokens were burned

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
    adoptInflight: async (onStep?: (step: string) => void, onLongRunning?: () => void) => {
      const s = await ensureSession(); // reattach (attach path) — parses the snapshot
      const r = await s.adoptInflight(onStep, undefined, onLongRunning);
      if (s.sessionId()) sessionId = s.sessionId();
      lastUsage = r.usage;
      const ok = r.status === 'ok' && !r.isError;
      return { ok, status: r.status, text: r.resultText.trim() || '(no output)' };
    },
    lastUsage: () => lastUsage,
  };
}
