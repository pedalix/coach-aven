// Per-project sandbox options (projects.config.json → `sandbox`), resolved to one shape the
// drivers can act on. Why per project: the fleet image is docker-in-docker and needs sysbox
// or --privileged, but a project that never runs containers of its own (a plain-code repo,
// the ops/overseer tenant on a Mac mini) is better off as an ORDINARY unprivileged
// container on the `plain` image — smaller blast radius, works where sysbox doesn't exist.
// Mounts exist for the same tenant: a host directory of ingested, scrubbed data exposed
// read-only, so the agent can read it but never alter the archive.
//
// Pure: validate + normalise only. Drivers consume ResolvedSandboxOptions; loadProjects runs
// resolveSandboxOptions at boot so a typo fails the boot, not the first turn.
export interface SandboxOptions {
  // false → plain `docker run` (no --privileged, no --runtime). Default true.
  privileged?: boolean;
  // false → the project has no dockerd: skip the dockerd guard at chat prep and in
  // housekeeping, and the exec-probe/recycle dance (a sysbox symptom). Default true.
  // `privileged: false` with `dind: true` is a contradiction — dind needs a runtime.
  dind?: boolean;
  // "<abs host path>:<abs container path>[:ro|:rw]"; mode defaults to ro.
  mounts?: string[];
}

export interface Mount {
  source: string;
  target: string;
  mode: 'ro' | 'rw';
}

export interface ResolvedSandboxOptions {
  privileged: boolean;
  dind: boolean;
  mounts: Mount[];
}

export const DEFAULT_SANDBOX_OPTIONS: ResolvedSandboxOptions = { privileged: true, dind: true, mounts: [] };

// Same charset sshdocker.safeToken accepts — these become `-v` argv segments on the host.
const SAFE_PATH = /^\/[A-Za-z0-9._/-]*$/;

export function parseMount(spec: string): Mount {
  const parts = spec.split(':');
  if (parts.length < 2 || parts.length > 3) throw new Error(`mount "${spec}": expected <host>:<container>[:ro|:rw]`);
  const [source, target, modeRaw] = parts as [string, string, string | undefined];
  for (const p of [source, target]) {
    if (!SAFE_PATH.test(p) || p.includes('..') || p === '/') {
      throw new Error(`mount "${spec}": paths must be absolute, [A-Za-z0-9._/-] only, no "..", not "/"`);
    }
  }
  const mode = modeRaw ?? 'ro';
  if (mode !== 'ro' && mode !== 'rw') throw new Error(`mount "${spec}": mode must be ro or rw`);
  return { source, target, mode };
}

export function resolveSandboxOptions(input?: SandboxOptions): ResolvedSandboxOptions {
  if (!input) return DEFAULT_SANDBOX_OPTIONS;
  const privileged = input.privileged ?? true;
  const dind = input.dind ?? true;
  if (!privileged && dind) {
    throw new Error('sandbox: "privileged": false requires "dind": false — docker-in-docker needs sysbox or --privileged');
  }
  const mounts = (input.mounts ?? []).map(parseMount);
  const targets = new Set<string>();
  for (const m of mounts) {
    if (targets.has(m.target)) throw new Error(`sandbox: duplicate mount target ${m.target}`);
    targets.add(m.target);
  }
  return { privileged, dind, mounts };
}

// True when the project asked for anything other than the fleet default — drivers that
// cannot honour options (Daytona) log once per project instead of silently ignoring them.
export function isDefaultSandbox(o: ResolvedSandboxOptions): boolean {
  return o.privileged && o.dind && o.mounts.length === 0;
}
