// The sandbox transport (design D3): the CLI runs in a throwaway sandbox the probe creates through the
// bot's own SandboxDriver, and the probe talks to it through the same session calls ClaudeSession uses
// (startSessionCommand / sendSessionInput / streamSessionCommandLogs) — so the stdin path is the bot's:
// the ssh-docker session FIFO. The sandbox is the probe's alone: its name carries the throwaway prefix
// (sandboxopts.ts), leftovers are chosen by that name — a driver's listing can hold every sandbox of an
// account or a host — and it is deleted when the run ends, failed runs included.
import type { ClaudeLaunch } from '../claudeSession.js';
import { cliUpgradeCmd, parseCliMarkers } from '../cliversion.js';
import type { Config } from '../config.js';
import type { SandboxDriver, SandboxHandle } from '../driver.js';
import { SshDockerDriver } from '../sshdocker.js';
import { seedClaudeAuth } from '../project.js';
import { DISPOSABLE_SANDBOX_PREFIX } from '../sandboxopts.js';
import { seedPathOk, type ProbeProcess, type ProcessHandlers, type Transport } from './ctx.js';

/** The CLI's working directory inside the probe's sandbox (empty, like a fresh project checkout). */
export const SANDBOX_WORK_DIR = '/root/probe-work';
/** The `managedBy` label the probe's ssh-docker containers carry (SANDBOX_MANAGED_BY in the probe's process), so no bot lists them. */
export const PROBE_MANAGED_BY = 'cli-probe';

/** Split a stream of decoded text into lines. */
export function textLineSplitter(onLine: (line: string) => void): { push(s: string): void; end(): void } {
  let buf = '';
  return {
    push(s) {
      buf += s;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        onLine(line);
      }
    },
    end() {
      if (buf.trim()) onLine(buf);
      buf = '';
    },
  };
}

export interface SandboxTransportOptions {
  driver: SandboxDriver;
  /** → the sandbox name `cli-probe-<runId>`. */
  runId: string;
  /** The CLI version to install in the sandbox with the bot's own upgrade step. */
  version: string;
  token: string;
  log?: (line: string) => void;
}

export async function sandboxTransport(o: SandboxTransportOptions): Promise<Transport> {
  const name = `${DISPOSABLE_SANDBOX_PREFIX}${o.runId}`;
  for (const leftover of (await o.driver.listStates()).keys()) {
    if (leftover.startsWith(DISPOSABLE_SANDBOX_PREFIX) && leftover !== name) {
      o.log?.(`deleting leftover sandbox ${leftover}`);
      await o.driver.deleteSandbox(leftover);
    }
  }
  const handle: SandboxHandle = await o.driver.ensureSandbox(name, 'cli-probe', { privileged: false, dind: false });
  try {
    await seedClaudeAuth(handle, o.token); // the token file project prep writes; the command reads it (CC_TOKEN_ENV)
    const r = await handle.exec(cliUpgradeCmd(o.version), { timeout: 600 });
    const markers = parseCliMarkers(r.result ?? '');
    if (markers.version !== o.version) {
      throw new Error(`the sandbox runs Claude Code ${markers.version ?? '?'} after the upgrade step, not ${o.version} (${markers.upgrade ?? 'no marker'})`);
    }
    await handle.exec(`mkdir -p ${SANDBOX_WORK_DIR}`, { check: true });
  } catch (e) {
    await o.driver.deleteSandbox(name).catch(() => {});
    throw e;
  }
  let n = 0;
  return {
    kind: 'sandbox',
    workDir: SANDBOX_WORK_DIR,
    async seed(files) {
      // Each file through base64, so no content needs shell quoting.
      for (const [rel, text] of Object.entries(files)) {
        if (!seedPathOk(rel)) throw new Error(`a scenario file must stay inside the working directory: ${rel}`);
        const path = `${SANDBOX_WORK_DIR}/${rel}`;
        const dir = path.slice(0, path.lastIndexOf('/'));
        await handle.exec(`mkdir -p '${dir}' && printf '%s' '${Buffer.from(text).toString('base64')}' | base64 -d > '${path}'`, { check: true });
      }
    },
    async start(launch: ClaudeLaunch, h: ProcessHandlers): Promise<ProbeProcess> {
      const key = `probe-${++n}`;
      await handle.createSession(key);
      // The bot's own command line: CLI_PATH_ENV first, so the CLI the upgrade step installed is the one that runs.
      const { cmdId } = await handle.startSessionCommand(key, launch.command(SANDBOX_WORK_DIR));
      const lines = textLineSplitter((l) => h.onLine(l));
      let killedWith: string | null = null;
      let exited = false;
      const exit = (): void => {
        if (exited) return;
        exited = true;
        lines.end();
        h.onExit(null, killedWith);
      };
      void handle.streamSessionCommandLogs(key, cmdId, (c) => lines.push(c)).then(exit, exit);
      // A sandbox session's process ends when the session is deleted (the driver kills it); the
      // stream then settles and reports the exit. The signal recorded is the one asked for.
      const stop = (signal: string): void => {
        killedWith ??= signal;
        void handle.deleteSession(key).catch(() => {});
      };
      return {
        write: (line) => handle.sendSessionInput(key, cmdId, line),
        end: () => stop('SIGTERM'),
        kill: (signal) => stop(signal ?? 'SIGKILL'),
      };
    },
    async dispose() {
      await o.driver.deleteSandbox(name);
    },
  };
}

/**
 * The bot's driver, from the probe's OWN environment only (never an installation's configuration
 * files): SANDBOX_DRIVER, which must say `ssh-docker` — still required here, so a probe run never
 * guesses where its sandbox goes, and anything else (a leftover `daytona`) is refused before any sandbox
 * exists — then SSHDOCKER_HOST / SSHDOCKER_RUNTIME, SNAPSHOT_IMAGE, and SANDBOX_NAME_PREFIX for the
 * delete guard.
 */
export function driverFromEnv(env: NodeJS.ProcessEnv): { driver: SandboxDriver; label: string } {
  const kind = env.SANDBOX_DRIVER;
  if (kind !== 'ssh-docker') throw new Error('--transport sandbox needs SANDBOX_DRIVER=ssh-docker in the probe’s environment');
  if (!env.SNAPSHOT_IMAGE) throw new Error('--transport sandbox needs SNAPSHOT_IMAGE (the plain sandbox image) in the probe’s environment');
  // Only the fields SshDockerDriver reads. autoStopMinutes is a Config field the probe never acts on:
  // it starts no idle sweep, and its sandbox is deleted when the run ends.
  const cfg = {
    sandboxDriver: kind,
    sshDocker: env.SSHDOCKER_HOST ? { host: env.SSHDOCKER_HOST, runtime: env.SSHDOCKER_RUNTIME === 'sysbox-runc' ? 'sysbox-runc' : 'privileged' } : undefined,
    snapshot: { image: env.SNAPSHOT_IMAGE },
    sandbox: { autoStopMinutes: 30, workDir: '/root/work', namePrefix: env.SANDBOX_NAME_PREFIX || 'proj-' },
  } as unknown as Config;
  return { driver: new SshDockerDriver(cfg), label: 'sandbox (ssh-docker)' };
}

