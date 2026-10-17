// Claude Code CLI version pinning — the "which claude is the fleet actually running?"
// question. The sandbox image bakes the CLI in (snapshot/Dockerfile), warm sandboxes keep
// their image forever, npm-global installs never self-update, and we spawn claude with
// DISABLE_AUTOUPDATER=1 — so without this, every sandbox runs whatever npm's latest was on
// the day its image was built, indefinitely (prod sat on 2.1.183 for months).
//
// One pin (CLAUDE_CLI_VERSION, overridable per project via `cliVersion` in
// projects.config.json for a canary) drives three things:
//   • in-place upgrade at chat prep (project.ts provisionTooling) — `npm i -g` inside the
//     warm sandbox keeps repos/transcripts/memory, unlike an image swap;
//   • the same upgrade in the nightly housekeeping pass, so idle projects converge too;
//   • a daily drift check against npm's `stable` dist-tag (pollers.ts) — the alert that
//     stops "77 versions behind" from happening again.
// The Dockerfile takes the same pin as a build arg so fresh sandboxes match the fleet.
// Pure helpers + shell snippets here (tested); the exec/alert plumbing lives in the callers.
//
// The PROBED set (OpenSpec `cli-probe`): CLI versions whose committed probe report
// (src/fixtures/cli/<version>/) has every contract scenario holding — what the bot relies on, measured.
// The images' default pin and .env.example must be in it (src/cliprobe/gate.test.ts), and the image
// build refuses any other (snapshot/build-and-push.sh). An installation pins only a probed version;
// a version leaves the set only when no installation or project still pins it.
//
// WHERE it installs: an override prefix under /root (CLI_PREFIX), not the image's
// /usr/local. Under sysbox (the ssh-docker driver) the image layers belong to an unmapped
// uid — they read as `nobody` and even root can't rename inside /usr/local/lib/node_modules
// (npm dies with EACCES; bit proj-coach-aven on 2026-09-04) — while /root is the
// container's own writable state. So every driver installs into /root/.local and the
// spawn command puts /root/.local/bin first on PATH (CLI_PATH_ENV): present → wins,
// absent → the image's copy. Same rule everywhere, no per-driver special case.

const VERSION_RE = /^\d+\.\d+\.\d+$/;

export const PROBED_CLI_VERSIONS: readonly string[] = ['2.1.282'];

// The per-sandbox install prefix (npm --prefix → <prefix>/bin/claude, <prefix>/lib/node_modules).
export const CLI_PREFIX = '/root/.local';
// Env prefix for any command that must see the override first — claudeSession's spawn line.
export const CLI_PATH_ENV = `PATH=${CLI_PREFIX}/bin:$PATH`;
// npm's cache goes to a throwaway dir: the image's /root/.npm can carry unwritable entries
// (same uid story), and we don't want 100 MB of tarballs kept per sandbox anyway.
const NPM_CACHE = '/tmp/cli-npm-cache';

// A pin is a plain `x.y.z` — nothing else is accepted, because it lands inside a shell
// command verbatim (config-controlled, but "never interpolate unvalidated text" anyway).
export function isValidCliVersion(v: string | undefined): v is string {
  return typeof v === 'string' && VERSION_RE.test(v);
}

// Numeric semver compare: <0 when a < b, 0 equal, >0 when a > b. Non-numeric parts → 0.
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number(n) || 0);
  const pb = b.split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// `claude --version` prints "2.1.183 (Claude Code)"; keep the number. Resolved with the
// override first, exactly as the spawn line does. busybox-sh safe.
const READ_VERSION = `${CLI_PATH_ENV} claude --version 2>/dev/null | awk '{print $1}'`;

// Marker-only probe for housekeeping/status when no pin is set:  cli:version=<v>
export function cliVersionCmd(): string {
  return `echo "cli:version=$(${READ_VERSION})"`;
}

// Idempotent upgrade-to-pin. Markers (parsed by parseCliMarkers):
//   cli:from=<v>                    the version found (always)
//   cli:upgrade=current|installed|failed
//   cli:version=<v>                 the version after the step (always)
// The npm output goes to /tmp/cli-upgrade.log in the sandbox for post-mortems. A pin
// that fails validation yields the probe instead of a broken command — never throws.
export function cliUpgradeCmd(pin: string): string {
  if (!isValidCliVersion(pin)) return cliVersionCmd();
  return (
    `cur=$(${READ_VERSION}); echo "cli:from=$cur"; ` +
    `if [ "$cur" = "${pin}" ]; then echo "cli:upgrade=current"; else ` +
    `if npm_config_cache=${NPM_CACHE} npm install -g --prefix ${CLI_PREFIX} @anthropic-ai/claude-code@${pin} >/tmp/cli-upgrade.log 2>&1; ` +
    `then echo "cli:upgrade=installed"; else echo "cli:upgrade=failed"; fi; rm -rf ${NPM_CACHE}; fi; ` +
    `echo "cli:version=$(${READ_VERSION})"`
  );
}

export interface CliMarkers {
  from?: string;
  version?: string;
  upgrade?: 'current' | 'installed' | 'failed';
}

// Pure: the `cli:` marker lines out of a script's stdout (tolerates surrounding noise —
// the housekeeping script interleaves its own `hk:` markers).
export function parseCliMarkers(out: string): CliMarkers {
  const pick = (k: string): string | undefined => out.match(new RegExp(`^cli:${k}=(.*)$`, 'm'))?.[1]?.trim() || undefined;
  const up = pick('upgrade');
  return {
    from: pick('from'),
    version: pick('version'),
    upgrade: up === 'current' || up === 'installed' || up === 'failed' ? up : undefined,
  };
}

// Pure: the operator message an upgrade step deserves, or undefined when it's routine.
// `installed` is worth one info line (the fleet changed under us, deliberately); `failed`
// is a warning with the log path; `current` is silence.
export function cliUpgradeNotice(m: CliMarkers, where: string): { level: 'info' | 'warning'; text: string } | undefined {
  if (m.upgrade === 'installed') {
    return { level: 'info', text: `Claude Code ${m.from ?? '?'} → ${m.version ?? '?'} in ${where}` };
  }
  if (m.upgrade === 'failed') {
    return {
      level: 'warning',
      text: `Claude Code upgrade FAILED in ${where} (still ${m.version ?? m.from ?? '?'}) — see /tmp/cli-upgrade.log in the sandbox`,
    };
  }
  return undefined;
}

// Pure: is the PIN itself stale? npm's `stable` dist-tag trails `latest` by about a week,
// skipping known-bad builds — the channel a fleet should track. Returns the alert text when
// the pin is behind it (or unset), undefined when we're current or ahead (a deliberate
// `latest` pin, e.g. for a feature stable doesn't carry yet, is not drift).
export function cliPinDrift(pin: string | undefined, stable: string | undefined): string | undefined {
  if (!stable) return undefined;
  if (!isValidCliVersion(pin)) {
    return `CLAUDE_CLI_VERSION is not set — sandboxes stay on whatever their image shipped; npm stable is ${stable}`;
  }
  if (compareVersions(pin, stable) < 0) {
    return `Claude Code pin ${pin} is behind npm stable ${stable} — bump CLAUDE_CLI_VERSION (canary first, see docs/housekeeping.md)`;
  }
  return undefined;
}

// npm's dist-tags for the CLI, via the registry's tiny tags endpoint (no tarball, ~200 B).
// `fetchFn` is injectable for tests; failures → undefined (the caller skips the check).
export async function fetchCliDistTags(fetchFn: typeof fetch = fetch): Promise<{ stable?: string; latest?: string } | undefined> {
  try {
    const res = await fetchFn('https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags', {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return undefined;
    const j = (await res.json()) as Record<string, unknown>;
    const v = (k: string): string | undefined => (isValidCliVersion(j[k] as string) ? (j[k] as string) : undefined);
    return { stable: v('stable'), latest: v('latest') };
  } catch {
    return undefined;
  }
}
