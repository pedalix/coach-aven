// Housekeeping: scheduled MECHANICAL hygiene of a project sandbox (see
// docs/housekeeping.md) — the janitor, as opposed to the nightly memory tidy (src/brain/tidy.ts).
// Deterministic shell, no LLM, for every project with no switch (OpenSpec nightly-housekeeping): the night
// pass in pollers.ts runs it before the memory tidy. This module is the PURE part:
// building the in-sandbox script and parsing its report — so the guardrails (no volume
// pruning, threshold-gated deletion, marker format) are pinned by tests. The fire logic
// (skip-if-busy; an asleep sandbox is woken where the bot owns the idle stop and it is on, and
// skipped otherwise — idlestop.ts housekeepingSandboxStep) lives in pollers.ts; the dockerd guard
// is also run at every chat prep (project.ts ensureDockerd) so a dead daemon can't linger for days.
import { cliUpgradeCmd, cliVersionCmd, parseCliMarkers, type CliMarkers } from './cliversion.js';

// A project has a pass tonight only when it had a turn since its last one (OpenSpec nightly-housekeeping D2):
// a project nobody touched gathered nothing, and its stopped sandbox is not started to find that out. Both are
// ISO times; no turn on record → no pass.
export function passDue(o: { lastPassAt?: string; lastTurnAt?: string }): boolean {
  if (!o.lastTurnAt) return false;
  return !o.lastPassAt || Date.parse(o.lastTurnAt) > Date.parse(o.lastPassAt);
}

// The newest usage record per project — every turn of every kind is one (metering.ts), except the nightly
// tidy's own (key `cron:tidy:<slug>`): it touches memory only and ends AFTER the night's pass, so counting it
// made the janitor run a second time a minute later.
export function lastTurnBySlug(records: readonly { slug: string; at: string; key?: string }[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of records) {
    if (r.key?.includes('cron:tidy:')) continue;
    if (!out.has(r.slug) || r.at > out.get(r.slug)!) out.set(r.slug, r.at);
  }
  return out;
}

// The night's round over the projects, ONE at a time: every sandbox shares one host's CPU, memory and (under
// sysbox) one container runtime, and on the first night after a deploy every project with a turn on record is
// due at once. Returns a starter that does nothing (false) while the previous round is still going — the
// minute tick calls it again, and a project that was busy gets its pass in a later round of the same hour.
export function serialRounds<T>(pass: (item: T) => Promise<unknown>, fail: (e: unknown) => void): (items: readonly T[]) => boolean {
  let running = false;
  return (items) => {
    if (running) return false;
    running = true;
    void (async () => {
      for (const item of items) await pass(item).catch(fail);
    })().finally(() => {
      running = false;
    });
    return true;
  };
}

/** What `/aven housekeeping` (bare) says: the last pass, or that none has run yet. */
export function lastPassText(slug: string, last: { at: string; summary: string } | undefined, cmd: string): string {
  const how = `It runs by itself at night for a project that had a turn since its last pass; \`${cmd} housekeeping now\` runs one.`;
  if (!last) return `:broom: *Housekeeping — ${slug}*: no pass yet. ${how}`;
  return `:broom: *Housekeeping — ${slug}*\nLast pass: ${last.at.slice(0, 16).replace('T', ' ')} UTC — _${last.summary}_\n${how}`;
}

// Disk-usage % at which docker pruning kicks in. Below it, housekeeping only reports.
export function pruneThreshold(raw: string | undefined = process.env.HOUSEKEEPING_DISK_PCT): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 && n <= 99 ? n : 80;
}

// Check dockerd and (re)start it if dead. No entrypoint starts dockerd — the container
// runs `sleep` — so this guard does: at chat prep and, on a docker-in-docker project, at
// the first warm-up after each start of the container (sshdocker.ts bootScript). Nothing
// supervises it after that — a crashed daemon silently breaks Laravel Sail (the
// php/composer/artisan shims) until someone pokes the sandbox. Prints ONE marker line:
//   hk:dockerd=ok | restarted | failed
// busybox-sh compatible (the sandbox is Alpine).
//
// Stale-pid cleanup before starting: pid files survive an unclean sandbox stop, and after
// the restart the recorded pid can belong to an unrelated process. dockerd then believes
// "containerd is still running", health-checks a dead socket for 15s and exits — so the
// restart branch below would always fail (bit proj-art on 2026-07-21). Drop each pid file
// unless its pid really is a dockerd/containerd process.
//
// cgroup nesting before the start (the step of the image's own `dind` wrapper, which no
// entrypoint runs here): on a cgroup-v2 host a `--privileged` container's processes sit in
// its root cgroup, and a cgroup with processes cannot hand controllers to children — so an
// inner container that asks for a limit (`docker run -m`, a compose `mem_limit`) fails with
// `cannot enter cgroupv2 "/sys/fs/cgroup/docker" with domain controllers`. Move the
// processes into `init` and enable the controllers for the subtree. Skipped on cgroup v1
// and where the subtree already has every controller (sysbox delegates them itself).
// Best effort: in a container whose dockerd once started without the step the stale child
// cgroups refuse the write, and it heals at the container's next start.
const CGROUP_NESTING =
  `if [ -f /sys/fs/cgroup/cgroup.controllers ] && [ "$(cat /sys/fs/cgroup/cgroup.controllers)" != "$(cat /sys/fs/cgroup/cgroup.subtree_control)" ]; then ` +
  `mkdir -p /sys/fs/cgroup/init; ` +
  `xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || :; ` +
  `sed -e 's/ / +/g' -e 's/^/+/' < /sys/fs/cgroup/cgroup.controllers > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || :; ` +
  `fi`;

export function dockerdGuardCmd(): string {
  return (
    `if docker info >/dev/null 2>&1; then echo "hk:dockerd=ok"; else ` +
    `for f in /var/run/docker.pid /var/run/docker/containerd/containerd.pid; do ` +
    `p=$(cat "$f" 2>/dev/null); if [ -n "$p" ]; then ` +
    `case "$(cat /proc/$p/comm 2>/dev/null)" in dockerd|containerd) ;; *) rm -f "$f";; esac; ` +
    `fi; done; ` +
    `${CGROUP_NESTING}; ` +
    `(dockerd >>/var/log/dockerd.log 2>&1 &); ` +
    `i=0; while [ $i -lt 20 ]; do sleep 1; docker info >/dev/null 2>&1 && break; i=$((i+1)); done; ` +
    `if docker info >/dev/null 2>&1; then echo "hk:dockerd=restarted"; else echo "hk:dockerd=failed"; fi; ` +
    `fi`
  );
}

// The full janitor script: dockerd guard, disk report, and — only ABOVE the disk
// threshold — a conservative docker prune. Guardrails (docs/housekeeping.md):
//   • NEVER `--volumes` — Sail volumes hold project databases.
//   • Only stopped containers, dangling/old unused images (>7 days), build cache — and never
//     a container Docker Compose manages: with the idle stop (OpenSpec sandbox-idle-stop) a
//     stopped Sail stack is an idle project's normal state, and removing its containers would
//     also free their images for the image prune; the next `sail up -d` would rebuild.
//   • Always report reclaimable space (the "what would be pruned" visibility line),
//     prune only past the threshold; log markers either way.
// Output is `hk:` marker lines parsed by parseHousekeepingReport. With a CLI pin the pass
// also converges the sandbox's Claude Code in place (cliversion.ts) — the nightly catch-up
// for projects idle since the pin moved; without one it just reports the version.
// `dind` false (a plain, docker-less project — sandboxopts.ts): no dockerd guard and no
// prune, there is nothing to guard or prune; the disk line still reports.
export function housekeepingScript(thresholdPct: number, cliPin: string | undefined, dind: boolean): string {
  return [
    cliPin ? cliUpgradeCmd(cliPin) : cliVersionCmd(),
    ...(dind ? [dockerdGuardCmd()] : []),
    `usage=$(df -P / | awk 'NR==2 {gsub(/%/,""); print $5}')`,
    `echo "hk:disk=$usage"`,
    // Reclaimable space per docker's own accounting — visibility even when not pruning.
    `docker system df --format '{{.Type}}:{{.Reclaimable}}' 2>/dev/null | tr '\\n' ' ' | sed 's/^/hk:reclaimable=/;s/ $//' && echo ""`,
    `if docker info >/dev/null 2>&1 && [ "$usage" -ge ${thresholdPct} ]; then`,
    `  docker container prune -f --filter "label!=com.docker.compose.project" >/dev/null 2>&1`,
    `  docker image prune -af --filter "until=168h" >/dev/null 2>&1`,
    `  docker builder prune -f >/dev/null 2>&1`,
    `  after=$(df -P / | awk 'NR==2 {gsub(/%/,""); print $5}')`,
    `  echo "hk:prune=done"`,
    `  echo "hk:diskafter=$after"`,
    `else`,
    `  echo "hk:prune=skipped"`,
    `fi`,
  ].join('\n');
}

export interface HousekeepingReport {
  dockerd: 'ok' | 'restarted' | 'failed' | 'unknown';
  diskPct?: number;
  diskAfterPct?: number;
  prune: 'done' | 'skipped' | 'unknown';
  cli: CliMarkers; // Claude Code version / upgrade outcome (cliversion.ts)
  digest: string; // one line for the routine's lastSummary + the ops log
}

// Parse the script's `hk:` markers into a report + a compact human digest.
// `reapedWorktrees` comes from the separate reapWorktrees pass (it has its own logging).
export function parseHousekeepingReport(out: string, reapedWorktrees: number): HousekeepingReport {
  const pick = (k: string): string | undefined => out.match(new RegExp(`^hk:${k}=(.*)$`, 'm'))?.[1]?.trim();
  const num = (v: string | undefined): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const dockerdRaw = pick('dockerd');
  const dockerd =
    dockerdRaw === 'ok' || dockerdRaw === 'restarted' || dockerdRaw === 'failed' ? dockerdRaw : 'unknown';
  const pruneRaw = pick('prune');
  const prune = pruneRaw === 'done' || pruneRaw === 'skipped' ? pruneRaw : 'unknown';
  const diskPct = num(pick('disk'));
  const diskAfterPct = num(pick('diskafter'));
  const cli = parseCliMarkers(out);

  const disk =
    diskPct === undefined
      ? 'disk ?'
      : prune === 'done' && diskAfterPct !== undefined
        ? `disk ${diskPct}%→${diskAfterPct}%`
        : `disk ${diskPct}%`;
  const digest = [
    `dockerd ${dockerd}`,
    disk,
    prune === 'done' ? 'pruned' : 'no prune',
    `${reapedWorktrees} worktree${reapedWorktrees === 1 ? '' : 's'} reaped`,
    ...(cli.version
      ? [`cli ${cli.version}${cli.upgrade === 'installed' ? ` (from ${cli.from ?? '?'})` : cli.upgrade === 'failed' ? ' (upgrade FAILED)' : ''}`]
      : []),
  ].join(' · ');
  return { dockerd, diskPct, diskAfterPct, prune, cli, digest };
}
