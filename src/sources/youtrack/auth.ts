import type { AuthContext, YoutrackSourcesConfig } from '../types.js';
import { runTrackerAuth } from '../trackers/auth.js';
import { writeTokenFile } from '../trackers/writer.js';
import { youtrackHttp, youtrackToken } from './pull.js';

async function whoami(cfg: YoutrackSourcesConfig, token: string): Promise<string> {
  const r = await youtrackHttp(token).get(`${cfg.url}/api/users/me?fields=login,fullName`);
  const me = (r.json ?? {}) as { login?: string; fullName?: string };
  return `${new URL(cfg.url).host} as ${me.login ?? '?'} (${me.fullName ?? ''})`;
}

export function runYoutrackAuth(ctx: AuthContext, argv: string[], cfg: YoutrackSourcesConfig): Promise<number> {
  return runTrackerAuth(ctx, argv, {
    name: 'youtrack',
    check: () => whoami(cfg, youtrackToken(cfg, ctx.tokenPath)),
    ...(cfg.tokenEnv
      ? {}
      : {
          add: async (secret: string) => {
            const who = await whoami(cfg, secret);
            writeTokenFile(ctx.tokenPath, { token: secret });
            return who;
          },
        }),
  });
}
