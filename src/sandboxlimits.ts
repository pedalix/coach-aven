// Memory and CPU limits of a project container (OpenSpec sandbox-limits): the installation's two settings,
// parsed once at boot, and the shell the ssh-docker driver adds for them — flags at creation, and an in-place
// `docker update` for a container whose limits differ (containers are never recreated: their state is in the
// writable layer). Pure; the numbers are computed here so the script only compares integers.

export interface SandboxLimits {
  memoryBytes?: number;
  nanoCpus?: number;
}

const UNIT: Record<string, number> = { '': 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
// Docker refuses a memory limit under 6 MB; refusing it here names the setting instead of failing every warm-up.
const MIN_MEMORY = 6 * 1024 ** 2;

/** A docker size — digits (a fraction allowed) and an optional b/k/m/g — in bytes. */
export function parseMemoryLimit(raw: string): number {
  const m = /^(\d+(?:\.\d+)?)([bkmg]?)$/i.exec(raw.trim());
  const bytes = m ? Math.floor(Number(m[1]) * UNIT[m[2]!.toLowerCase()]!) : NaN;
  if (!Number.isSafeInteger(bytes) || bytes < MIN_MEMORY) {
    throw new Error(`SANDBOX_LIMIT_MEMORY must be a size such as 6g or 512m (at least 6m), got: ${raw}`);
  }
  return bytes;
}

/** A positive number of CPUs (fractions allowed), in docker's nano-CPUs. */
export function parseCpuLimit(raw: string): number {
  const n = /^\d+(?:\.\d+)?$/.test(raw.trim()) ? Math.round(Number(raw) * 1e9) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`SANDBOX_LIMIT_CPUS must be a positive number such as 4 or 0.5, got: ${raw}`);
  return n;
}

/** The two settings; `undefined` when neither is set (the driver then adds nothing to its script). */
export function sandboxLimitsFromEnv(env: Record<string, string | undefined> = process.env): SandboxLimits | undefined {
  const memory = env.SANDBOX_LIMIT_MEMORY?.trim();
  const cpus = env.SANDBOX_LIMIT_CPUS?.trim();
  if (!memory && !cpus) return undefined;
  return { ...(memory ? { memoryBytes: parseMemoryLimit(memory) } : {}), ...(cpus ? { nanoCpus: parseCpuLimit(cpus) } : {}) };
}

// `--memory-swap` equal to `--memory`: no swap beyond the limit (docker's default allows as much again).
function limitFlags(l: SandboxLimits): string {
  return [
    ...(l.memoryBytes !== undefined ? [`--memory ${l.memoryBytes} --memory-swap ${l.memoryBytes}`] : []),
    ...(l.nanoCpus !== undefined ? [`--cpus ${l.nanoCpus / 1e9}`] : []),
  ].join(' ');
}

/** Flags for `docker run`; '' when nothing is set. */
export const limitRunFlags = (l: SandboxLimits | undefined): string => (l ? limitFlags(l) : '');

// Lines for the ensure script, after it has a container: read the limits the settings name, update only when
// they differ. A refused update (a running container already above the new memory limit) must not fail the
// warm-up: it prints `limits=failed …` on stderr — the outcome stays the last stdout line — and the next
// warm-up tries again. `quotedName` is the already shell-quoted container name.
export function limitConvergeLines(quotedName: string, l: SandboxLimits | undefined): string[] {
  if (!l || (l.memoryBytes === undefined && l.nanoCpus === undefined)) return [];
  const fields = [
    ...(l.memoryBytes !== undefined ? [['{{.HostConfig.Memory}}', String(l.memoryBytes)]] : []),
    ...(l.nanoCpus !== undefined ? [['{{.HostConfig.NanoCpus}}', String(l.nanoCpus)]] : []),
  ];
  const format = fields.map((f) => f[0]).join(' ');
  const want = fields.map((f) => f[1]).join(' ');
  return [
    `if [ "$(docker inspect -f '${format}' ${quotedName} 2>/dev/null)" != '${want}' ]; then`,
    `  if err=$(docker update ${limitFlags(l)} ${quotedName} 2>&1 >/dev/null); then echo "limits=set" >&2`,
    `  else echo "limits=failed $(printf '%s' "$err" | head -n 1)" >&2; fi`,
    `fi`,
  ];
}
