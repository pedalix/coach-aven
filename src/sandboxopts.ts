// Per-project sandbox options (projects.config.json → `sandbox`), resolved to one shape the
// drivers can act on. A project is an ORDINARY unprivileged container unless it asks for
// docker-in-docker (`"dind": true`, Laravel Sail): privilege is written where it applies,
// never inherited from a default (OpenSpec sandbox-privilege-opt-in).
// Mounts exist for the same tenant: a host directory of ingested, scrubbed data exposed
// read-only, so the agent can read it but never alter the archive.
//
// Pure: validate + normalise only. Drivers consume ResolvedSandboxOptions; loadProjects runs
// resolveSandboxOptions at boot so a typo fails the boot, not the first turn.
export interface SandboxOptions {
  // true → `--privileged` or `--runtime sysbox-runc` (SANDBOX_DIND_RUNTIME). Default: what `dind` says.
  privileged?: boolean;
  // true → the project runs its own dockerd (Sail): the dockerd guard at chat prep and in
  // housekeeping, the exec-probe/recycle dance (a sysbox symptom), the prompt's Sail paragraph.
  // Default false. `privileged: false` with `dind: true` is a contradiction — dind needs a runtime.
  dind?: boolean;
  // "<abs host path>:<abs container path>[:ro|:rw]"; mode defaults to ro.
  mounts?: string[];
  // The image this project's container is created from; unset → the installation's SANDBOX_IMAGE.
  // Independent of the mode on purpose (sandbox-privilege-opt-in D1): the laravel image wants
  // `dind: true` (its php/composer/artisan are Sail shims), the plain image has no dockerd.
  image?: string;
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
  image?: string; // absent → the installation's image
}

export const DEFAULT_SANDBOX_OPTIONS: ResolvedSandboxOptions = { privileged: false, dind: false, mounts: [] };

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

// An image reference as docker takes it (registry/name:tag or @digest); it becomes a quoted argv
// segment on the sandbox host, so the charset is kept to what references use.
const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;

export function resolveSandboxOptions(input?: SandboxOptions): ResolvedSandboxOptions {
  if (!input) return DEFAULT_SANDBOX_OPTIONS;
  // `dind: true` without `privileged` means privileged: docker-in-docker needs a runtime, so the
  // one-line opt-in `{ "dind": true }` says everything.
  const dind = input.dind ?? false;
  const privileged = input.privileged ?? dind;
  if (!privileged && dind) {
    throw new Error('sandbox: "privileged": false requires "dind": false — docker-in-docker needs sysbox or --privileged');
  }
  const mounts = (input.mounts ?? []).map(parseMount);
  const targets = new Set<string>();
  for (const m of mounts) {
    if (targets.has(m.target)) throw new Error(`sandbox: duplicate mount target ${m.target}`);
    targets.add(m.target);
  }
  if (input.image !== undefined && (typeof input.image !== 'string' || !IMAGE_REF.test(input.image))) {
    throw new Error(`sandbox: "image" must be an image reference (registry/name:tag), got: ${JSON.stringify(input.image)}`);
  }
  return { privileged, dind, mounts, ...(input.image ? { image: input.image } : {}) };
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
 * The privilege warning (sandbox-privilege-opt-in D3), logged at boot and at /aven reload; never an
 * error: a privileged project on the bot's own machine without the operator's confirmation. Pure.
 */
export function privilegeWarnings(inp: { projects: { slug: string; sandbox?: SandboxOptions }[]; local: boolean; localConfirmed: boolean }): string[] {
  const out: string[] = [];
  const privileged = inp.projects.filter((p) => resolveSandboxOptions(p.sandbox).privileged).map((p) => p.slug);
  if (inp.local && privileged.length && !inp.localConfirmed) {
    out.push(
      `sandboxes: ${privileged.join(', ')} run privileged on this machine (SANDBOX_HOST=local) — such a container is root-equivalent beside the bot's secrets and Docker socket; ` +
        'make the project plain ("sandbox": { "privileged": false, "dind": false }) or confirm with SANDBOX_LOCAL_PRIVILEGED=1',
    );
  }
  return out;
}
