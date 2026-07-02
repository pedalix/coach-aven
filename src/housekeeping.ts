// Housekeeping: scheduled MECHANICAL hygiene of a project sandbox (see
// docs/housekeeping.md) — the janitor, as opposed to Dreaming (memory consolidation).
// Deterministic shell on the routines scheduler, no LLM. This module is the PURE part:
// building the in-sandbox script and parsing its report — so the guardrails (no volume
// pruning, threshold-gated deletion, marker format) are pinned by tests. The fire logic
// (skip-if-busy, skip-if-asleep) lives in pollers.ts; the dockerd guard is also run at
// every chat prep (project.ts ensureDockerd) so a dead daemon can't linger for days.

// Defaults for the `/aven housekeeping on` routine (in ROUTINE_TZ). 04:30: after the
// 03:00 dream window, still low-traffic.
export const HOUSEKEEPING_DEFAULT_CRON = '30 4 * * *';
export const HOUSEKEEPING_DEFAULT_SPEC = 'daily 4:30';

// Disk-usage % at which docker pruning kicks in. Below it, housekeeping only reports.
export function pruneThreshold(raw: string | undefined = process.env.HOUSEKEEPING_DISK_PCT): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 && n <= 99 ? n : 80;
}

// Check dockerd and restart it if dead. The dind entrypoint starts dockerd exactly once
// and nothing supervises it — a crashed daemon silently breaks Laravel Sail (the
// php/composer/artisan shims) until someone pokes the sandbox. Prints ONE marker line:
//   hk:dockerd=ok | restarted | failed
// busybox-sh compatible (the sandbox is Alpine).
export function dockerdGuardCmd(): string {
  return (
    `if docker info >/dev/null 2>&1; then echo "hk:dockerd=ok"; else ` +
    `(dockerd >>/var/log/dockerd.log 2>&1 &); ` +
    `i=0; while [ $i -lt 20 ]; do sleep 1; docker info >/dev/null 2>&1 && break; i=$((i+1)); done; ` +
    `if docker info >/dev/null 2>&1; then echo "hk:dockerd=restarted"; else echo "hk:dockerd=failed"; fi; ` +
    `fi`
  );
}

// The full janitor script: dockerd guard, disk report, and — only ABOVE the disk
// threshold — a conservative docker prune. Guardrails (docs/housekeeping.md):
//   • NEVER `--volumes` — Sail volumes hold project databases.
//   • Only stopped containers, dangling/old unused images (>7 days), build cache.
//   • Always report reclaimable space (the "what would be pruned" visibility line),
//     prune only past the threshold; log markers either way.
// Output is `hk:` marker lines parsed by parseHousekeepingReport.
export function housekeepingScript(thresholdPct: number): string {
  return [
    dockerdGuardCmd(),
    `usage=$(df -P / | awk 'NR==2 {gsub(/%/,""); print $5}')`,
    `echo "hk:disk=$usage"`,
    // Reclaimable space per docker's own accounting — visibility even when not pruning.
    `docker system df --format '{{.Type}}:{{.Reclaimable}}' 2>/dev/null | tr '\\n' ' ' | sed 's/^/hk:reclaimable=/;s/ $//' && echo ""`,
    `if docker info >/dev/null 2>&1 && [ "$usage" -ge ${thresholdPct} ]; then`,
    `  docker container prune -f >/dev/null 2>&1`,
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
  ].join(' · ');
  return { dockerd, diskPct, diskAfterPct, prune, digest };
}
