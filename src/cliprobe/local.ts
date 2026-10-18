// The local transport: the CLI as a child process of the probe, in the run's own working directory,
// with the run's own configuration directory and token and none of the parent session's variables
// (clienv.ts), plus the variables the bot sets on every spawn (claudeLaunch().env).
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ClaudeLaunch } from '../claudeSession.js';
import { isolatedClaudeEnv } from '../clienv.js';
import { utf8Chunks } from '../utf8.js';
import { seedPathOk, type ProbeProcess, type ProcessHandlers, type Transport } from './ctx.js';

/** Pure: the child's environment. */
export function localEnv(base: NodeJS.ProcessEnv, run: { configDir: string; token: string }, launch: ClaudeLaunch): NodeJS.ProcessEnv {
  return { ...isolatedClaudeEnv(base, run), ...launch.env };
}

/** Split a byte stream into lines, multibyte-safe across chunks. */
export function lineSplitter(onLine: (line: string) => void): { push(b: Buffer): void; end(): void } {
  const dec = utf8Chunks();
  let buf = '';
  const drain = (): void => {
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      onLine(line);
    }
  };
  return {
    push(b) {
      buf += dec.push(b);
      drain();
    },
    end() {
      buf += dec.flush();
      drain();
      if (buf.trim()) onLine(buf);
      buf = '';
    },
  };
}

export function localTransport(o: {
  bin: string;
  workDir: string;
  configDir: string;
  token: string;
  baseEnv?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}): Transport {
  const children = new Set<ChildProcess>();
  return {
    kind: 'local',
    workDir: o.workDir,
    async seed(files) {
      for (const [rel, text] of Object.entries(files)) {
        if (!seedPathOk(rel)) throw new Error(`a scenario file must stay inside the working directory: ${rel}`);
        const path = join(o.workDir, rel);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text);
      }
    },
    async start(launch: ClaudeLaunch, h: ProcessHandlers): Promise<ProbeProcess> {
      const child = spawn(o.bin, launch.args, {
        cwd: o.workDir,
        env: localEnv(o.baseEnv ?? process.env, o, launch),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      children.add(child);
      const out = lineSplitter((l) => h.onLine(l));
      const err = lineSplitter((l) => {
        if (l.trim()) o.log?.(`stderr: ${l.slice(0, 300)}`);
      });
      child.stdout!.on('data', (b: Buffer) => out.push(b));
      child.stderr!.on('data', (b: Buffer) => err.push(b));
      child.stdin!.on('error', () => {}); // EPIPE once the CLI is gone
      let exited = false;
      const exit = (code: number | null, signal: string | null): void => {
        if (exited) return;
        exited = true;
        out.end();
        err.end();
        children.delete(child);
        h.onExit(code, signal);
      };
      child.on('error', (e) => {
        o.log?.(`spawn error: ${e.message}`);
        exit(null, 'spawn-error');
      });
      child.on('close', (code, signal) => exit(code, signal));
      return {
        write: (line) =>
          new Promise<void>((resolve) => {
            if (!child.stdin!.writable) return resolve();
            child.stdin!.write(line, () => resolve());
          }),
        end: () => child.stdin!.end(),
        kill: (signal) => {
          child.kill(signal ?? 'SIGKILL');
        },
      };
    },
    async dispose() {
      for (const c of children) c.kill('SIGKILL');
    },
  };
}
