import type { AuthContext, JiraSourcesConfig } from '../types.js';
import { runTrackerAuth } from '../trackers/auth.js';
import { writeTokenFile } from '../trackers/writer.js';
import { jiraCredentials, jiraHttp } from './pull.js';

async function whoami(cfg: JiraSourcesConfig, c: { email: string; token: string }): Promise<string> {
  const r = await jiraHttp(c).get(`https://${cfg.site}/rest/api/3/myself`);
  const me = (r.json ?? {}) as { displayName?: string; accountId?: string };
  return `${cfg.site} as ${me.displayName ?? '?'} (${me.accountId ?? ''})`;
}

export function runJiraAuth(ctx: AuthContext, argv: string[], cfg: JiraSourcesConfig): Promise<number> {
  return runTrackerAuth(ctx, argv, {
    name: 'jira',
    check: () => whoami(cfg, jiraCredentials(cfg, ctx.tokenPath)),
    ...(cfg.fromNetrc
      ? {}
      : {
          add: async (secret: string, flags: Record<string, string>) => {
            const email = flags.email ?? cfg.email;
            if (!email) throw new Error('no credentials: pass --email (or set sources.jira.email)');
            const who = await whoami(cfg, { email, token: secret });
            writeTokenFile(ctx.tokenPath, { email, token: secret });
            return who;
          },
        }),
  });
}
