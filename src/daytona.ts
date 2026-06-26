import { Daytona, type Sandbox } from '@daytonaio/sdk';
import type { Config } from './config.js';
import { log } from './log.js';

export function makeDaytona(cfg: Config): Daytona {
  return new Daytona({
    apiKey: cfg.daytona.apiKey,
    apiUrl: cfg.daytona.apiUrl,
    organizationId: cfg.daytona.organizationId,
  });
}

// Ensure the project snapshot exists and is active. `image` is a plain registry
// reference (string) → Daytona pulls it; NO build context upload, NO S3.
export async function ensureSnapshot(daytona: Daytona, cfg: Config): Promise<void> {
  try {
    const snap = await daytona.snapshot.get(cfg.snapshot.name);
    if (snap.state === 'active') {
      log.info(`snapshot '${cfg.snapshot.name}' already active`);
      return;
    }
    log.warn(`snapshot '${cfg.snapshot.name}' exists in state '${snap.state}' — leaving as-is`);
    return;
  } catch {
    // not found → create below
  }
  log.step(`creating snapshot '${cfg.snapshot.name}' from ${cfg.snapshot.image}`);
  await daytona.snapshot.create(
    {
      name: cfg.snapshot.name,
      image: cfg.snapshot.image,
      resources: { cpu: cfg.snapshot.cpu, memory: cfg.snapshot.memory, disk: cfg.snapshot.disk },
    },
    { onLogs: (c) => log.raw(c), timeout: 0 },
  );
  log.info(`snapshot '${cfg.snapshot.name}' created`);
}

// Get a warm per-project sandbox by name, creating or starting it as needed.
export async function ensureSandbox(
  daytona: Daytona,
  cfg: Config,
  sandboxName: string,
  projectSlug: string,
): Promise<Sandbox> {
  let sandbox: Sandbox | undefined;
  try {
    sandbox = await daytona.get(sandboxName);
  } catch {
    sandbox = undefined;
  }

  if (!sandbox) {
    log.step(`creating sandbox '${sandboxName}'`);
    sandbox = await daytona.create(
      {
        name: sandboxName,
        snapshot: cfg.snapshot.name,
        // IS_SANDBOX=1 lifts Claude Code's "no --dangerously-skip-permissions as root"
        // guard (the dind sandbox runs as root, which dockerd needs). The CC token is
        // NOT baked here — it's seeded per-run via /root/.cc-token (seedClaudeAuth) so a
        // warm sandbox always uses a fresh token instead of a stale baked one.
        envVars: { IS_SANDBOX: '1' },
        labels: { managedBy: 'bluefin-thin-orchestrator', project: projectSlug },
        autoStopInterval: cfg.sandbox.autoStopMinutes,
        autoDeleteInterval: -1, // never auto-delete a warm project sandbox
      },
      { timeout: 0 },
    );
    log.info(`sandbox '${sandboxName}' started (${sandbox.id})`);
    return sandbox;
  }

  if (sandbox.state !== 'started') {
    log.step(`sandbox '${sandboxName}' is '${sandbox.state}' — starting`);
    await daytona.start(sandbox, 180);
    sandbox = await daytona.get(sandboxName);
  }
  log.info(`sandbox '${sandboxName}' ready (${sandbox.id})`);
  return sandbox;
}

// Snapshot of every sandbox's current state, keyed by name (e.g. `proj-caldora` →
// 'started'). One `list` call; best-effort — used by `/aven status` to show which warm
// sandboxes are up without poking each one. Throws only if the list call itself fails.
export async function listSandboxStates(daytona: Daytona): Promise<Map<string, string>> {
  const states = new Map<string, string>();
  for await (const sb of daytona.list()) {
    if (sb.name) states.set(sb.name, sb.state ?? 'unknown');
  }
  return states;
}

export interface ExecOpts {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number; // seconds; 0 = no timeout
  check?: boolean; // throw on non-zero exit
}

// Thin wrapper over toolbox exec (S3-free). Returns {exitCode, result}.
export async function exec(sandbox: Sandbox, command: string, opts: ExecOpts = {}) {
  const res = await sandbox.process.executeCommand(command, opts.cwd, opts.env, opts.timeout ?? 0);
  if (opts.check && res.exitCode !== 0) {
    throw new Error(
      `command failed (exit ${res.exitCode}): ${command}\n--- output ---\n${res.result}`,
    );
  }
  return res;
}
