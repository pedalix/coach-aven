import type { AsanaSourcesConfig, AuthContext } from '../types.js';
import { runTrackerAuth } from '../trackers/auth.js';
import { writeTokenFile } from '../trackers/writer.js';
import { asanaHttp, asanaToken } from './pull.js';

async function whoami(token: string): Promise<string> {
  const r = await asanaHttp(token).get('https://app.asana.com/api/1.0/users/me?opt_fields=name,email,workspaces.name');
  const me = (((r.json ?? {}) as { data?: { name?: string; email?: string; workspaces?: { gid: string; name: string }[] } }).data ?? {});
  return `${me.name ?? '?'} <${me.email ?? ''}>, workspaces: ${(me.workspaces ?? []).map((w) => `${w.name} (${w.gid})`).join(', ')}`;
}

export function runAsanaAuth(ctx: AuthContext, argv: string[], _cfg: AsanaSourcesConfig): Promise<number> {
  return runTrackerAuth(ctx, argv, {
    name: 'asana',
    check: () => whoami(asanaToken(ctx.tokenPath)),
    add: async (secret: string) => {
      const who = await whoami(secret);
      writeTokenFile(ctx.tokenPath, { token: secret });
      return who;
    },
  });
}
