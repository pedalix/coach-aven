import type { SandboxHandle } from './driver.js';
import type { Config } from './config.js';
import type { Credit, CreditKind } from './credit.js';
import type { McpServerSpec } from './projects.js';
import { buildMcpServers, GATEWAY_DIR, GATEWAY_HELPER_PATH, GATEWAY_HELPER_SCRIPT, gatewayTokenPath } from './mcp.js';
import { gatewayTokens, type GatewayTarget } from './gwtoken.js';
import { dockerdGuardCmd } from './housekeeping.js';
import { captureError } from './sentry.js';
import { cliUpgradeCmd, parseCliMarkers, cliUpgradeNotice } from './cliversion.js';
import { alertOps } from './chat/slack/blocks.js';
import { log } from './log.js';
import { withGitRetry, type GitRetryOpts } from './gitretry.js';
import { routineGuard } from './routineguard.js';
import { GIT_EMAIL, GIT_NAME } from './gitidentity.js';

// The sandbox image (snapshot/Dockerfile → SANDBOX_IMAGE, or a project's sandbox.image) bakes in the sandbox tooling
// (git, gh, node, Claude Code, sail shims), so per-boot provisioning is gone. This ensures
// only additions NEWER than the running fleet's image — idempotently, on every chat prep —
// so warm sandboxes pick them up on their next turn with no image rebuild and no lost
// state (repos/worktrees/history/memory). Anything added here should also go into the
// Dockerfile so freshly-baked images stop needing the runtime install.
export async function provisionTooling(
  sandbox: SandboxHandle,
  opts: { cliVersion?: string; upgradeCli?: boolean; where?: string } = {},
) {
  // imagemagick is the recovery tool for oversized images: attachments are pre-scaled by the
  // orchestrator, but if one slips through (e.g. a format sharp couldn't decode), the agent
  // resizes in one `magick` step instead of hand-rolling a resizer.
  await sandbox.exec('command -v magick >/dev/null 2>&1 || apk add --no-cache imagemagick', { timeout: 300 });
  // Claude Code pin (cliversion.ts): converge the warm sandbox's CLI in place — repos,
  // transcripts and memory stay put, unlike an image swap. Skipped while another turn is
  // running on this project (upgradeCli=false): never swap the binary under a live process.
  // Sessions spawned after the install run the new version; ones already open keep their
  // loaded code until they restart. Costs ~1 min, once per sandbox per bump.
  if (opts.cliVersion && opts.upgradeCli) {
    const r = await sandbox.exec(cliUpgradeCmd(opts.cliVersion), { timeout: 600 });
    const notice = cliUpgradeNotice(parseCliMarkers(r.result ?? ''), opts.where ?? 'sandbox');
    if (notice) alertOps(notice.text, notice.level);
    if (notice?.level === 'warning') captureError(new Error(notice.text), { subsystem: 'cli-upgrade' });
  }
}

// Make sure dockerd is alive before a turn runs. No entrypoint starts it (the container
// runs `sleep`): this guard does, as does the first warm-up after each start of a
// docker-in-docker container (sshdocker.ts bootScript), and nothing supervises it
// after that — when it dies, Laravel Sail (the php/composer/artisan shims)
// silently breaks until someone pokes the sandbox (this bit us: the Grafana MCP was
// docker-run based and stayed "not connected" for days). Cheap when healthy (~one
// `docker info`); also part of the nightly housekeeping routine.
export async function ensureDockerd(sandbox: SandboxHandle, slug?: string): Promise<void> {
  const r = await sandbox.exec(dockerdGuardCmd(), { timeout: 60 });
  const state = r.result?.match(/hk:dockerd=(\w+)/)?.[1];
  if (state === 'restarted') log.warn('dockerd was down — restarted it');
  else if (state === 'failed') {
    log.error('dockerd is down and would not restart — Sail commands will fail');
    // A Sentry issue, not just a log line: SENTRY_LOGS is off in prod, and a project whose
    // Sail stack is silently broken until the next session open must not go unnoticed.
    captureError(new Error('dockerd is down and would not restart — Sail commands will fail'), {
      subsystem: 'dockerd-guard',
      ...(slug ? { slug } : {}),
    });
  }
}

// Layout inside the sandbox: <workDir>/<slug>/<repoName> per repo (a project = one
// sandbox holding all its repos side by side).
export function projectDir(cfg: Config, slug: string) {
  return `${cfg.sandbox.workDir}/${slug}`;
}
export function repoName(repo: string): string {
  return repo.split('/')[1] ?? repo;
}
// Multi-repo chat layout: each repo cloned at <workDir>/<slug>/<repoName>, so a
// project (one sandbox) can hold several repos side by side (e.g. cms-general).
export function repoCheckout(cfg: Config, slug: string, repo: string) {
  return `${projectDir(cfg, slug)}/${repoName(repo)}`;
}

// The cwd Claude Code runs in for a project: the single repo's checkout, or the project
// root when there are several (repos side by side). The session transcript AND auto memory
// are both keyed off this path, so readers (e.g. memory.ts) must derive it identically.
export function projectCwd(cfg: Config, slug: string, repos: string[]): string {
  return repos.length === 1 ? repoCheckout(cfg, slug, repos[0]) : projectDir(cfg, slug);
}

// The directories a session loads Claude Code skills from beyond its cwd (OpenSpec agent-skills): a
// multi-repo project's sessions start in the project folder, where no repo's `.claude/skills` is visible,
// so each checkout goes to `--add-dir` — measured on CLI 2.1.292: the repos' skills then appear in `init`.
// Only with REPO_SKILLS=1 (bucket 3, off by default); always empty for a single-repo project (its cwd is the repo).
export function repoSkillDirs(cfg: Config, slug: string, repos: string[]): string[] {
  return repos.length > 1 && cfg.repoSkills === true ? repos.map((r) => repoCheckout(cfg, slug, r)) : [];
}

// Where the skills scanner looks (skills.ts): exactly where the session loads skills from — its cwd, and
// the `--add-dir` checkouts. `origin` names the place in the fact and in warnings.
export function skillOrigins(cfg: Config, slug: string, repos: string[]): { origin: string; dir: string }[] {
  if (repos.length === 1) return [{ origin: repoName(repos[0]!), dir: repoCheckout(cfg, slug, repos[0]!) }];
  return [{ origin: 'project', dir: projectDir(cfg, slug) }, ...repoSkillDirs(cfg, slug, repos).map((dir, i) => ({ origin: repoName(repos[i]!), dir }))];
}

// How the `gh auth login` step of seedGitHubAuth treats a failure: 'strict' = fatal, as it always
// was; 'tolerant' = retried, then a warning. The default follows ROUTINE_GUARD so production keeps
// the historical preflight until the guard is switched on there.
export type GhLoginMode = 'strict' | 'tolerant';

// Write the GitHub installation token into the sandbox WITHOUT it showing up in
// command logs (fs.uploadFile, not echo). A git credential helper + gh read it.
// Call this at the start of every task so the (≈1h) token is always fresh.
export async function seedGitHubAuth(
  sandbox: SandboxHandle,
  token: string,
  ghLogin: GhLoginMode = routineGuard.enabled ? 'tolerant' : 'strict',
  retry: GitRetryOpts = {}, // tests inject the sleep; production uses gitretry's defaults
) {
  await sandbox.uploadFile(Buffer.from(token), '/root/.gh-token');
  await sandbox.exec('chmod 600 /root/.gh-token', { check: true });
  // git: credential helper that emits the token for github.com over https.
  await sandbox.exec(
    `git config --global credential.helper '!f() { echo username=x-access-token; echo "password=$(cat /root/.gh-token)"; }; f'`,
    { check: true },
  );
  // Committer identity = the GitHub App's own bot user (gitidentity.ts). Kept for
  // shells outside the claude process; the process itself also gets GIT_AUTHOR_* env.
  await sandbox.exec(`git config --global user.name "${GIT_NAME}"`, { check: true });
  await sandbox.exec(`git config --global user.email "${GIT_EMAIL}"`, { check: true });
  // gh: authenticate so the agent's `gh pr create` works.
  if (ghLogin === 'strict') {
    await sandbox.exec(`gh auth login --with-token < /root/.gh-token`, { check: true });
    return;
  }
  // Tolerant (ROUTINE_GUARD): the login VALIDATES the token against api.github.com — the only
  // network round-trip in this seeding, and a fatal one: on 2026-10-12 a proxy hiccup there
  // ("error validating token: Get https://api.github.com/: EOF") killed two scheduled runs in
  // the preflight, although git itself needs no network at seed time (the helper above). So:
  // retry the transient shapes (gitretry.ts) and, if it still fails, WARN and go on — the git
  // side works, and a `gh` call that really needs the login fails visibly inside the turn,
  // where the agent can say so, instead of the whole run dying before it started.
  const login = async (): Promise<void> => {
    const r = await sandbox.exec(`gh auth login --with-token < /root/.gh-token`, { check: false, timeout: 60 });
    if (r.exitCode !== 0) throw new Error(`gh auth login failed (exit ${r.exitCode}): ${(r.result ?? '').trim().slice(0, 500)}`);
  };
  try {
    await withGitRetry(login, {
      onRetry: (err, attempt, delayMs) => log.warn(`gh auth login failed transiently (${headLine(err)}) — retry ${attempt} in ${delayMs} ms`),
      ...retry,
    });
  } catch (err) {
    log.warn(`gh auth login failed (${headLine(err)}) — continuing without gh auth; a gh command in this turn will report it`);
  }
}
const headLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 200);

// Write the model credit into the sandbox (via fs, not echoed) — a subscription token or an API key, one
// file either way (api-key-credit D2): a switch of credit overwrites the old value instead of leaving a
// token beside a key. The CLI's command reads it per spawn as `$(cat /root/.cc-token)` (ccCreditEnv), so
// the value never lands in command logs and a warm sandbox always uses the fresh one.
export async function seedClaudeAuth(sandbox: SandboxHandle, credit: Pick<Credit, 'value'>) {
  await sandbox.uploadFile(Buffer.from(credit.value), '/root/.cc-token');
  await sandbox.exec('chmod 600 /root/.cc-token', { check: true });
}

// Prefix that injects the subscription token without leaking it into the command string/logs — today's
// string, byte for byte (claudeSession.test.ts's spawn golden pins it).
export const CC_TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN=$(cat /root/.cc-token)';
// The prefix per credit kind: the same file into the variable the CLI reads for that credit, and no other
// Claude credential — with a key, CLAUDE_CODE_OAUTH_TOKEN is not set at all.
export const ccCreditEnv = (kind: CreditKind): string => (kind === 'api-key' ? 'ANTHROPIC_API_KEY=$(cat /root/.cc-token)' : CC_TOKEN_ENV);

const MCP_CONFIG_PATH = '/root/.mcp-config.json';

// Materialize the project's MCP servers into a --mcp-config file inside the sandbox
// (written via the file API, never echoed). Returns the in-sandbox path, or undefined
// when the project has no MCP servers. Combined with --strict-mcp-config, claude then
// loads ONLY these servers (the repo's own .mcp.json is ignored). Spec-shape handling
// (stdio vs remote http, ${ENV} secret resolution) lives in buildMcpServers (mcp.ts).
export async function seedMcpConfig(
  sandbox: SandboxHandle,
  mcp: McpServerSpec[] | undefined,
): Promise<string | undefined> {
  if (!mcp || mcp.length === 0) return undefined;
  const mcpServers = buildMcpServers(mcp);
  await sandbox.uploadFile(Buffer.from(JSON.stringify({ mcpServers })), MCP_CONFIG_PATH);
  await sandbox.exec(`chmod 600 ${MCP_CONFIG_PATH}`, { check: true });
  return MCP_CONFIG_PATH;
}

// Gateway auth (McpServerSpec.auth === 'gateway-m2m'): write the project bot's current token
// + the headers helper into the sandbox. Called every turn beside seedMcpConfig, so the file
// always holds a token inside its refresh margin (gwtoken.ts: under min(1 h, half its
// lifetime) it is replaced); a long-lived claude that hits 401 re-runs the helper and reads the
// fresh file. The client SECRET never enters the sandbox — only the short-lived token does. The
// registry gets the entry's url and its `oauth` request (always present: the load refuses a
// gateway entry without it).
// A mint failure is reported and the turn goes on without gateway tools rather than failing the
// whole turn.
export async function seedGatewayAuth(
  sandbox: SandboxHandle,
  slug: string,
  mcp: McpServerSpec[] | undefined,
  tokens: { get(slug: string, target: GatewayTarget): Promise<string> } = gatewayTokens,
): Promise<void> {
  const specs = (mcp ?? []).filter((s) => s.auth === 'gateway-m2m' && s.url && s.oauth);
  if (!specs.length) return;
  await sandbox.exec(`mkdir -p ${GATEWAY_DIR} && chmod 700 ${GATEWAY_DIR}`, { check: true });
  await sandbox.uploadFile(Buffer.from(GATEWAY_HELPER_SCRIPT), GATEWAY_HELPER_PATH);
  await sandbox.exec(`chmod 700 ${GATEWAY_HELPER_PATH}`, { check: true });
  for (const s of specs) {
    try {
      const token = await tokens.get(slug, { url: s.url!, oauth: s.oauth! });
      await sandbox.uploadFile(Buffer.from(token), gatewayTokenPath(s.name));
      await sandbox.exec(`chmod 600 ${gatewayTokenPath(s.name)}`, { check: true });
    } catch (e) {
      log.error(`gateway token for ${slug}/${s.name} failed: ${e instanceof Error ? e.message : String(e)}`);
      captureError(e, { subsystem: 'gateway-auth', slug, server: s.name });
    }
  }
}

// Integer hours (busybox `$(( ))` in the sandbox is integer-only — a float would break it).
const REAP_HOURS = Math.floor(Number(process.env.WORKTREE_REAP_HOURS)) || 12;

// Reap finished/orphaned git worktrees in a repo (agents work in per-task worktrees; some
// outlive their session). Removes only worktrees that are SAFE to drop: not the main
// checkout, clean (no uncommitted changes), with nothing unpushed/unmerged
// (`rev-list HEAD --not --remotes` empty → every commit is already on a remote, zero data
// loss), and idle longer than WORKTREE_REAP_HOURS (so an active conversation's worktree is
// left alone). Run at prepareChat (lazy) and by the nightly housekeeping routine
// (proactive); returns how many were reaped for the housekeeping digest.
export async function reapWorktrees(sandbox: SandboxHandle, repoDir: string): Promise<number> {
  const script =
    `cd ${repoDir} 2>/dev/null || exit 0\n` +
    `git worktree prune 2>/dev/null\n` +
    `main=$(git rev-parse --show-toplevel 2>/dev/null)\n` +
    `now=$(date +%s)\n` +
    `git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}' | while read wt; do\n` +
    `  [ "$wt" = "$main" ] && continue\n` +
    `  [ -d "$wt" ] || continue\n` +
    `  [ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ] && continue\n` +
    `  [ -n "$(git -C "$wt" rev-list HEAD --not --remotes 2>/dev/null)" ] && continue\n` +
    `  ct=$(git -C "$wt" log -1 --format=%ct 2>/dev/null || echo $now)\n` +
    `  [ $(( now - ct )) -lt $(( ${REAP_HOURS} * 3600 )) ] && continue\n` +
    `  git worktree remove "$wt" --force 2>/dev/null && echo "reaped $wt"\n` +
    `done`;
  const r = await sandbox.exec(script);
  const reaped = r.result.split('\n').filter((l) => l.startsWith('reaped ')).length;
  if (reaped > 0) log.info(`reaped ${reaped} finished worktree(s) under ${repoDir}`);
  return reaped;
}

// Composer auth for private packages: mirror the GitHub token into <checkout>/auth.json
// (composer's own credential file) for every checkout that has a composer.json. Why a
// file and not the credential helper: composer runs INSIDE Sail / the bootstrap
// throwaway container, where the sandbox's git credential helper doesn't exist — but
// both containers mount the checkout, and composer reads ./auth.json from its working
// dir, so one file covers every composer path with no env plumbing. The token is the
// same per-turn installation token as /root/.gh-token (scoped to the project's repos +
// the dependency repos the deps scanner found, see tasks.ts), so this is re-run every
// turn right after seedGitHubAuth — it's a ~1h token. The shell reads it from
// /root/.gh-token so it never transits a command line. It is written in composer's
// `http-basic` shape, NOT `github-oauth`: the latter makes composer send
// `<token>:x-oauth-basic`, which GitHub rejects for installation (ghs_) tokens, whereas
// `x-access-token:<token>` is accepted by both git-over-https (composer's clone path,
// including `git@github.com:` URLs it rewrites) and the REST API (its zipball path) —
// verified with a real `composer update --dry-run` in the caldora sandbox (docs/project-facts.md).
// Excluded via .git/info/exclude
// (NOT .gitignore — that would be a tracked-file edit) so the agent can't commit it.
// Worktrees don't inherit the file (only the exclude, via the shared git dir): copies the
// agent already made under <checkout>-wt/*/ are refreshed too, so an hour-old worktree
// doesn't fail its next composer run; the base prompt tells the agent to cp it for new ones.
// A checkout without composer.json gets no file (and loses a stale one from the old PAT era).
export function composerAuthScript(checkoutDirs: string[]): string {
  const perCheckout = checkoutDirs.map(
    (d) =>
      `if [ -f ${d}/composer.json ]; then ` +
      `printf '{"http-basic":{"github.com":{"username":"x-access-token","password":"%s"}}}\\n' "$(cat /root/.gh-token)" > ${d}/auth.json && chmod 600 ${d}/auth.json; ` +
      `grep -qx auth.json ${d}/.git/info/exclude 2>/dev/null || echo auth.json >> ${d}/.git/info/exclude; ` +
      `for w in ${d}-wt/*/; do [ -f "$w/auth.json" ] && cp ${d}/auth.json "$w/auth.json"; done; ` +
      `else rm -f ${d}/auth.json; fi`,
  );
  return perCheckout.join('; ') + '; true';
}

export async function seedComposerAuth(sandbox: SandboxHandle, checkoutDirs: string[]) {
  if (checkoutDirs.length === 0) return;
  await sandbox.exec(composerAuthScript(checkoutDirs), { check: true });
}

// Clone (or fetch) a single repo into its own <slug>/<repoName> dir. Used by the chat
// path so a project can hold N repos. Idempotent.
export async function cloneRepo(sandbox: SandboxHandle, cfg: Config, slug: string, repo: string) {
  const dir = repoCheckout(cfg, slug, repo);
  const exists = await sandbox.exec(`test -d ${dir}/.git && echo yes || echo no`);
  if (exists.result.trim() === 'yes') {
    log.step(`repo present — fetching ${repo}`);
    // Heal a token baked into the remote URL by a previous session. If something embedded
    // `https://x-access-token:<token>@github.com/...` into .git/config, git uses THAT token
    // and bypasses the credential helper — and since it's a ~1h installation token, every
    // fetch/push fails once it expires (the helper's fresh token never gets a look-in). Force
    // the canonical tokenless URL so auth always flows through the fresh-token helper. Shared
    // .git config means this also heals every worktree of the repo.
    await sandbox.exec(`git -C ${dir} remote set-url origin https://github.com/${repo}.git`, {
      check: true,
    });
    // The token this fetch uses was minted seconds ago; a not-yet-propagated token makes
    // GitHub answer "Repository not found" (2026-09-30, one lost turn) — retry those (gitretry.ts).
    await withGitRetry(() => sandbox.exec(`git -C ${dir} fetch --all --prune`, { check: true, timeout: 600 }), retryLog(repo));
  } else {
    log.step(`cloning ${repo} → ${dir}`);
    await sandbox.exec(`mkdir -p ${projectDir(cfg, slug)}`, { check: true });
    await withGitRetry(
      () => sandbox.exec(`git clone https://github.com/${repo}.git ${dir}`, { check: true, timeout: 900 }),
      retryLog(repo),
    );
  }
}

const retryLog = (repo: string) => ({
  onRetry: (err: unknown, attempt: number, delayMs: number) =>
    log.warn(`git on ${repo} failed transiently (${firstLine(err)}) — retry ${attempt} in ${delayMs} ms`),
});
const firstLine = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).split('\n').find((l) => /remote:|fatal:|error:/.test(l))?.trim() ?? 'unknown';

