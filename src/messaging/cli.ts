// `orch hub …` — the installation side of the messaging hub (OpenSpec `agent-messaging`).
import type { Command } from 'commander';
import { UsageError } from '../sources/errors.js';
import { keygen } from './keygen.js';

export function registerHubCommands(program: Command): void {
  const cmd = program.command('hub').description('Agent messaging between installations: keys for the hub');
  cmd
    .command('keygen')
    .description('Write this installation’s hub keys to HUB_KEY_PATH (0600) and print the public halves')
    .option('--rotate', 'replace existing keys; the previous encryption key stays valid for 14 days')
    .action((opts: { rotate?: boolean }) => {
      const path = process.env.HUB_KEY_PATH;
      if (!path) throw new UsageError('HUB_KEY_PATH is not set (where the key file goes)');
      try {
        process.stdout.write(keygen({ path, installation: process.env.INSTALLATION_ID ?? 'local', rotate: Boolean(opts.rotate) }));
      } catch (e) {
        throw new UsageError(e instanceof Error ? e.message : String(e));
      }
    });
}
