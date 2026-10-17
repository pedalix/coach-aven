// Where a probe run gets its CLI and its token (design D2). The CLI version is installed into the
// probe's own cache — never the machine's `claude` — and the token comes from the probe's own
// variable only: an installation's .env is never read, even on a host that has one.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isValidCliVersion } from '../cliversion.js';

export const TOKEN_VAR = 'CLI_PROBE_TOKEN';

/** The probe's cache: CLI installs and fetched SDK declarations. */
export function probeCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLI_PROBE_CACHE || join(homedir(), '.cache', 'coach-aven', 'cli-probe');
}

/** The subscription token for a live run, or an error that names the variable to set. */
export function probeToken(env: NodeJS.ProcessEnv = process.env): string {
  const t = env[TOKEN_VAR]?.trim();
  if (!t) {
    throw new Error(
      `${TOKEN_VAR} is not set — a live probe run takes its subscription token from this variable only ` +
        '(create one with `claude setup-token`); it never reads an installation’s token',
    );
  }
  return t;
}

export type Exec = (file: string, args: readonly string[]) => Promise<void>;
const execNode: Exec = (file, args) =>
  new Promise((resolve, reject) =>
    execFile(file, [...args], { maxBuffer: 16 * 1024 * 1024 }, (err, _out, stderr) =>
      err ? reject(new Error(`${file} ${args.join(' ')} failed: ${String(stderr).slice(-500) || err.message}`)) : resolve(),
    ),
  );

/** The `claude` binary of `version`, installed into the cache on first use. */
export async function ensureCli(version: string, o: { cacheRoot: string; exec?: Exec }): Promise<string> {
  if (!isValidCliVersion(version)) throw new Error(`not a CLI version: ${JSON.stringify(version)} (x.y.z)`);
  const dir = join(o.cacheRoot, 'cli', version);
  const bin = join(dir, 'node_modules', '.bin', 'claude');
  if (existsSync(bin)) return bin;
  mkdirSync(dir, { recursive: true });
  await (o.exec ?? execNode)('npm', [
    'install',
    '--prefix',
    dir,
    '--no-save',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
    `@anthropic-ai/claude-code@${version}`,
  ]);
  if (!existsSync(bin)) throw new Error(`npm installed @anthropic-ai/claude-code@${version} but ${bin} is missing`);
  return bin;
}
