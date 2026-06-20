#!/usr/bin/env -S npx tsx
import { Command } from 'commander';
import { loadConfig } from './config.js';
import { runSlack } from './slack.js';
import { log } from './log.js';

const program = new Command();
program.name('orch').description('Per-project Daytona coding-agent sandboxes — Slack bot');

program
  .command('slack')
  .description('Run the Slack bot (Socket Mode): channel→project, thread→Claude session')
  .action(async () => {
    await runSlack(loadConfig());
  });

program.parseAsync(process.argv).catch((err) => {
  log.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
