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

// The installation default for a project without a `sandbox` block (OpenSpec sandbox-privilege-opt-in D1):
// `dind` — privileged docker-in-docker, the historical default and today's when SANDBOX_DEFAULT is unset;
// `plain` — an unprivileged container without dockerd. Installation-wide because the image is: the laravel
// image's php/composer/artisan are Sail shims that need dockerd, the plain image has no dockerd to guard.
export type SandboxDefault = 'dind' | 'plain';

/** SANDBOX_DEFAULT read and checked: unset = `dind` (stage 1), anything but dind|plain stops the boot. */
export function sandboxDefaultFrom(env: Record<string, string | undefined> = process.env): { value: SandboxDefault; set: boolean } {
  const raw = (env.SANDBOX_DEFAULT ?? '').trim();
  if (!raw) return { value: 'dind', set: false };
  if (raw !== 'dind' && raw !== 'plain') throw new Error(`SANDBOX_DEFAULT must be 'dind' or 'plain', got: ${raw}`);
  return { value: raw, set: true };
}

export function resolveSandboxOptions(input?: SandboxOptions, installationDefault: SandboxDefault = 'dind'): ResolvedSandboxOptions {
  const base = installationDefault === 'plain' ? { privileged: false, dind: false } : { privileged: true, dind: true };
  if (!input) return installationDefault === 'plain' ? { ...base, mounts: [] } : DEFAULT_SANDBOX_OPTIONS;
  // `dind: true` without `privileged` means privileged: docker-in-docker needs a runtime, whatever the default.
  const privileged = input.privileged ?? (input.dind === true ? true : base.privileged);
  const dind = input.dind ?? base.dind;
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

// The `managedBy` label every sandbox of this deployment carries, and the filter `/aven status`
// lists them by. An installation whose sandboxes already carry another value keeps it with
// SANDBOX_MANAGED_BY. The value must equal the label on the existing containers: the status
// listing filters by it, and the idle stop (OpenSpec sandbox-idle-stop) stops a container only if
// the label matches — a mismatch leaves every container running for good, with one
// `carries managedBy=…` warning per container per bot start.
export const sandboxManagedBy = (): string => process.env.SANDBOX_MANAGED_BY || 'coach-aven';

// Throwaway sandboxes a tool creates for itself and deletes when it is done — today only the CLI
// probe's (`cli-probe-<run>`, src/cliprobe/). Nothing else is ever deleted by code.
export const DISPOSABLE_SANDBOX_PREFIX = 'cli-probe-';

// Code never deletes a project's sandbox (it holds the repos, transcripts and memory of a
// conversation): SandboxDriver.deleteSandbox accepts only a throwaway sandbox's name and refuses
// anything that carries the project prefix. A driver's listing can hold every sandbox of an
// account or a host — another installation's included — so the name is the only safe key.
export function assertDeletable(name: string, namePrefix: string): void {
  const disposable = name.startsWith(DISPOSABLE_SANDBOX_PREFIX) && /^[a-z0-9-]+$/.test(name);
  if (!disposable || (namePrefix !== '' && name.startsWith(namePrefix))) {
    throw new Error(
      `refusing to delete sandbox ${JSON.stringify(name)}: code deletes only throwaway sandboxes (${DISPOSABLE_SANDBOX_PREFIX}…), never a project's`,
    );
  }
}


/**
 * The boot's privilege warnings (OpenSpec sandbox-privilege-opt-in D2), stage 1: lines to log, never an error.
 * `defaulted` are the projects without a `sandbox` block. Pure.
 */
export function privilegeWarnings(inp: {
  projects: { slug: string; sandbox?: SandboxOptions }[];
  defaulted: string[];
  installationDefault: SandboxDefault;
  defaultSet: boolean;
  runtimeSet: boolean;
  local: boolean;
  localConfirmed: boolean;
}): string[] {
  const out: string[] = [];
  if (!inp.defaultSet && inp.defaulted.length) {
    out.push(
      `sandboxes: ${inp.defaulted.join(', ')} ${inp.defaulted.length === 1 ? 'has' : 'have'} no "sandbox" block and run as privileged docker-in-docker by default — ` +
        'set SANDBOX_DEFAULT=dind to keep that, SANDBOX_DEFAULT=plain for unprivileged containers, or give the project a "sandbox" block (docs/sandbox-drivers.md)',
    );
  }
  const privileged = inp.projects.filter((p) => resolveSandboxOptions(p.sandbox, inp.installationDefault).privileged).map((p) => p.slug);
  if (privileged.length && !inp.runtimeSet) {
    out.push(`sandboxes: ${privileged.join(', ')} run privileged and SSHDOCKER_RUNTIME is unset (--privileged) — set SSHDOCKER_RUNTIME=sysbox-runc (preferred, needs sysbox on the host) or SSHDOCKER_RUNTIME=privileged`);
  }
  if (inp.local && privileged.length && !inp.localConfirmed) {
    out.push(
      `sandboxes: ${privileged.join(', ')} run privileged on this machine (SSHDOCKER_HOST=local) — such a container is root-equivalent beside the bot's secrets and Docker socket; ` +
        'make the project unprivileged ("sandbox": { "privileged": false, "dind": false }) or confirm with SANDBOX_LOCAL_PRIVILEGED=1',
    );
  }
  return out;
}
