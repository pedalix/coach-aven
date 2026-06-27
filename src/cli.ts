#!/usr/bin/env -S npx tsx
import { Command } from 'commander';
import { loadConfig } from './config.js';
import { runSlack } from './slack.js';
import { log } from './log.js';
import { initSentry, captureError, flushSentry } from './sentry.js';

const program = new Command();
program.name('orch').description('Per-project Daytona coding-agent sandboxes — Slack bot');

program
  .command('slack')
  .description('Run the Slack bot (Socket Mode): channel→project, thread→Claude session')
  .action(async () => {
    const cfg = loadConfig();
    initSentry(cfg); // no-op unless SENTRY_DSN is set
    await runSlack(cfg);
  });

program.parseAsync(process.argv).catch(async (err) => {
  log.error(err instanceof Error ? err.stack || err.message : String(err));
  captureError(err);
  await flushSentry();
  process.exit(1);
});
