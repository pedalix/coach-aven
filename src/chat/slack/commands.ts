// The `/aven` slash command on Slack: ack within Slack's 3 s, normalize the payload into a
// ChatCommand, and hand it to the platform-neutral command core (src/chat/core/commands.ts)
// with this workspace's driver.

import type bolt from '@slack/bolt';
import { tenantOf } from '../../teamkeys.js';
import { createCommands, type CommandDeps } from '../core/commands.js';
import { slackDriver, type SlackActionCtx } from './driver.js';
import { CMD } from './blocks.js';

export function registerCommands(app: bolt.App, deps: CommandDeps): void {
  const core = createCommands(deps);
  app.command(CMD, async ({ command, ack, respond, client }) => {
    await ack(); // Slack needs an ack within 3s; the real work runs after.
    const cmd = command as { enterprise_id?: string; is_enterprise_install?: string | boolean };
    const tenant = tenantOf({
      teamId: command.team_id,
      enterpriseId: cmd.enterprise_id,
      // The slash payload serializes this as the string "true"/"false".
      isEnterpriseInstall: cmd.is_enterprise_install === true || cmd.is_enterprise_install === 'true',
    });
    const ctx: SlackActionCtx = { respond: respond as SlackActionCtx['respond'] };
    await core.run(
      { text: command.text ?? '', conv: command.channel_id, actor: { tenant, user: command.user_id }, ctx },
      slackDriver(client),
    );
  });
}
