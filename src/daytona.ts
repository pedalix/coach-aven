import { Daytona, type Sandbox } from '@daytonaio/sdk';
import type { Config } from './config.js';
import type { ExecOpts, ExecResult, SandboxDriver, SandboxHandle } from './driver.js';
import { log } from './log.js';

// The Daytona implementation of SandboxDriver (see driver.ts for the contract). This is
// the ONLY file (plus scripts/peek-sandbox.ts) that may import @daytonaio/sdk — the rest
// of the bot talks to the driver interface.

class DaytonaHandle implements SandboxHandle {
  constructor(
    private readonly sandbox: Sandbox,
    readonly name: string,
    readonly started: boolean,
  ) {}

  // Thin wrapper over toolbox exec (S3-free). Returns {exitCode, result}.
  async exec(command: string, opts: ExecOpts = {}): Promise<ExecResult> {
    const res = await this.sandbox.process.executeCommand(command, opts.cwd, opts.env, opts.timeout ?? 0);
    if (opts.check && res.exitCode !== 0) {
      throw new Error(`command failed (exit ${res.exitCode}): ${command}\n--- output ---\n${res.result}`);
    }
    return res;
  }

  uploadFile(data: Buffer, path: string): Promise<void> {
    return this.sandbox.fs.uploadFile(data, path);
  }

  createSession(sessionKey: string): Promise<void> {
    return this.sandbox.process.createSession(sessionKey);
  }

  async startSessionCommand(sessionKey: string, command: string): Promise<{ cmdId: string }> {
    const started = await this.sandbox.process.executeSessionCommand(sessionKey, { command, runAsync: true }, 0);
    return { cmdId: started.cmdId! };
  }

  async sessionCommandRunning(sessionKey: string, cmdId: string): Promise<boolean> {
    const cmd = await this.sandbox.process.getSessionCommand(sessionKey, cmdId).catch(() => undefined);
    return !!cmd && cmd.exitCode == null;
  }

  async sessionCommandLogs(sessionKey: string, cmdId: string): Promise<string> {
    const snap = await this.sandbox.process.getSessionCommandLogs(sessionKey, cmdId);
    return snap.stdout ?? '';
  }

  async streamSessionCommandLogs(
    sessionKey: string,
    cmdId: string,
    onStdout: (chunk: string) => void,
  ): Promise<void> {
    await this.sandbox.process.getSessionCommandLogs(sessionKey, cmdId, onStdout, () => {});
  }

  sendSessionInput(sessionKey: string, cmdId: string, data: string): Promise<void> {
    return this.sandbox.process.sendSessionCommandInput(sessionKey, cmdId, data);
  }

  deleteSession(sessionKey: string): Promise<void> {
    return this.sandbox.process.deleteSession(sessionKey);
  }
}

export class DaytonaDriver implements SandboxDriver {
  private readonly daytona: Daytona;

  constructor(private readonly cfg: Config) {
    if (!cfg.daytona) {
      throw new Error(
        'DAYTONA_API_URL/_API_KEY/_ORGANIZATION_ID are not set — required for the daytona sandbox driver',
      );
    }
    this.daytona = new Daytona({
      apiKey: cfg.daytona.apiKey,
      apiUrl: cfg.daytona.apiUrl,
      organizationId: cfg.daytona.organizationId,
    });
  }

  // Ensure the project snapshot exists and is active. `image` is a plain registry
  // reference (string) → Daytona pulls it; NO build context upload, NO S3.
  async ensureImage(): Promise<void> {
    const { cfg } = this;
    try {
      const snap = await this.daytona.snapshot.get(cfg.snapshot.name);
      if (snap.state === 'active') {
        log.info(`snapshot '${cfg.snapshot.name}' already active`);
        return;
      }
      // A snapshot unused for a while decays to 'inactive' (self-hosted Daytona GCs the
      // pulled image) and sandbox create() then rejects with "Snapshot … is inactive" —
      // reactivate it here instead of leaving every new project dead in the water.
      // Activation is async (state goes 'pending' while the runner re-pulls), so poll.
      if (snap.state === 'inactive') {
        log.step(`snapshot '${cfg.snapshot.name}' is inactive — reactivating`);
        await this.daytona.snapshot.activate(snap);
        const deadline = Date.now() + 5 * 60_000;
        while (Date.now() < deadline) {
          const s = await this.daytona.snapshot.get(cfg.snapshot.name);
          if (s.state === 'active') {
            log.info(`snapshot '${cfg.snapshot.name}' reactivated`);
            return;
          }
          if (s.state === 'error') break;
          await new Promise((r) => setTimeout(r, 3000));
        }
        throw new Error(`snapshot '${cfg.snapshot.name}' did not become active after reactivation`);
      }
      // 'pending'/'building' etc. — someone else is already working on it.
      log.warn(`snapshot '${cfg.snapshot.name}' exists in state '${snap.state}' — leaving as-is`);
      return;
    } catch {
      // not found → create below
    }
    log.step(`creating snapshot '${cfg.snapshot.name}' from ${cfg.snapshot.image}`);
    await this.daytona.snapshot.create(
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
  async ensureSandbox(name: string, projectSlug: string): Promise<SandboxHandle> {
    const { cfg } = this;
    let sandbox: Sandbox | undefined;
    try {
      sandbox = await this.daytona.get(name);
    } catch {
      sandbox = undefined;
    }

    if (!sandbox) {
      log.step(`creating sandbox '${name}'`);
      sandbox = await this.daytona.create(
        {
          name,
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
      log.info(`sandbox '${name}' started (${sandbox.id})`);
      return new DaytonaHandle(sandbox, name, true);
    }

    if (sandbox.state !== 'started') {
      log.step(`sandbox '${name}' is '${sandbox.state}' — starting`);
      await this.daytona.start(sandbox, 180);
      sandbox = await this.daytona.get(name);
    }
    log.info(`sandbox '${name}' ready (${sandbox.id})`);
    return new DaytonaHandle(sandbox, name, true);
  }

  async getSandbox(name: string): Promise<SandboxHandle | undefined> {
    const sandbox = await this.daytona.get(name).catch(() => undefined);
    return sandbox ? new DaytonaHandle(sandbox, name, sandbox.state === 'started') : undefined;
  }

  // Snapshot of every sandbox's current state, keyed by name (e.g. `proj-caldora` →
  // 'started'). One `list` call; best-effort — used by `/aven status` to show which warm
  // sandboxes are up without poking each one. Throws only if the list call itself fails.
  async listStates(): Promise<Map<string, string>> {
    const states = new Map<string, string>();
    for await (const sb of this.daytona.list()) {
      if (sb.name) states.set(sb.name, sb.state ?? 'unknown');
    }
    return states;
  }
}
