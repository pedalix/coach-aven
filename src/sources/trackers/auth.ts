// `orch sources auth <slug> <youtrack|jira|asana|wrike> <check|add …>` — the tracker family needs
// no OAuth dance: each takes a long-lived personal token (YouTrack permanent token, Atlassian API
// token, Asana PAT, Wrike permanent token). `add` stores it (mode 600) after verifying it against
// the tracker's "who am I" endpoint; `check` re-verifies headless (the poller's daily credential
// check runs exactly this). The secret is read from an env var (`--token-env NAME`) or one line of
// stdin — never from argv, which would land in shell history and `ps`. A tracker whose token lives
// in an env var the config names (YouTrack `tokenEnv`, Wrike) has `check` only.
import { createInterface } from 'node:readline';
import { UsageError } from '../errors.js';
import type { AuthContext } from '../types.js';
import { TrackerHttpError } from './http.js';

export interface TrackerAuthSpec {
  name: string;
  /** Verify the configured credentials; returns "who am I" text for the log. Throws on failure. */
  check: () => Promise<string>;
  /** Store a newly supplied secret (+ flags such as --email); must verify before persisting. */
  add?: (secret: string, flags: Record<string, string>) => Promise<string>;
}

export function parseFlags(argv: string[]): { pos: string[]; flags: Record<string, string> } {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[++i]! : 'true';
      flags[k] = v;
    } else pos.push(a);
  }
  return { pos, flags };
}

export async function readSecret(flags: Record<string, string>): Promise<string> {
  if (flags['token-env']) {
    const v = process.env[flags['token-env']];
    if (!v) throw new UsageError(`env var ${flags['token-env']} is empty`);
    return v.trim();
  }
  process.stderr.write('paste token, then Enter: ');
  const rl = createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    rl.close();
    if (line.trim()) return line.trim();
  }
  throw new UsageError('no token on stdin');
}

export async function runTrackerAuth(ctx: AuthContext, argv: string[], spec: TrackerAuthSpec): Promise<number> {
  const { pos, flags } = parseFlags(argv);
  const action = pos[0] ?? 'check';
  try {
    if (action === 'check') {
      ctx.log(`${spec.name}: ok — ${await spec.check()}`);
      return 0;
    }
    if (action === 'add') {
      if (!spec.add) throw new UsageError(`${spec.name}: credentials come from configuration (tokenEnv / netrc); nothing to add`);
      ctx.log(`${spec.name}: stored — ${await spec.add(await readSecret(flags), flags)}`);
      return 0;
    }
    throw new UsageError(`${spec.name}: unknown action "${action}" (check | add [--token-env NAME] …)`);
  } catch (e) {
    if (e instanceof UsageError) throw e;
    const reauth = e instanceof TrackerHttpError ? e.reauth : /no (token|credentials)/i.test(String(e));
    ctx.log(`${spec.name}: FAILED — ${e instanceof Error ? e.message : String(e)}`);
    return reauth ? 3 : 1;
  }
}
