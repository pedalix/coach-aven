// Where a probe run gets its CLI and its credit (design D2; OpenSpec api-key-credit D6). The CLI version is
// installed into the probe's own cache — never the machine's `claude` — and the credit comes from the
// probe's own variables only — a subscription token or an API key, exactly one: an installation's .env is
// never read, even on a host that has one.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isValidCliVersion } from '../cliversion.js';
import type { CreditKind } from '../credit.js';

export const TOKEN_VAR = 'CLI_PROBE_TOKEN';
export const API_KEY_VAR = 'CLI_PROBE_API_KEY';

/** The probe's cache: CLI installs and fetched SDK declarations. */
export function probeCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLI_PROBE_CACHE || join(homedir(), '.cache', 'coach-aven', 'cli-probe');
}

/**
 * The credit for a live run — CLI_PROBE_TOKEN (a subscription token) or CLI_PROBE_API_KEY (an API key),
 * exactly one — or an error that names both variables (never a value). Trimmed; blank counts as unset.
 */
export function probeCredit(env: NodeJS.ProcessEnv = process.env): { kind: CreditKind; value: string } {
  const token = env[TOKEN_VAR]?.trim();
  const key = env[API_KEY_VAR]?.trim();
  if (token && key) throw new Error(`both ${TOKEN_VAR} and ${API_KEY_VAR} are set — a probe run takes exactly one credit: keep one`);
  if (key) return { kind: 'api-key', value: key };
  if (token) return { kind: 'subscription', value: token };
  throw new Error(
    `neither ${TOKEN_VAR} nor ${API_KEY_VAR} is set — a live probe run takes its credit from these variables only ` +
      '(a subscription token from `claude setup-token`, or an API key from the Anthropic console); it never reads an installation’s credit',
  );
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
