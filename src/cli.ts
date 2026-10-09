#!/usr/bin/env -S npx tsx
import { Command } from 'commander';
import { loadConfig } from './config.js';
import { runSlack } from './slack.js';
import { log } from './log.js';
import { initSentry, captureError, flushSentry } from './sentry.js';
import { registerSourcesCommands } from './sources/cli.js';
import { registerRoutinesCommands } from './routinescli.js';
import { UsageError } from './sources/errors.js';

const program = new Command();
program.name('orch').description('CoachAven — per-project coding-agent sandboxes driven from Slack');
// Positional option parsing lets `orch sources auth <slug> <kind> login --client x` hand the
// trailing flags to the connector untouched instead of commander rejecting them.
program.enablePositionalOptions();

program
  .command('slack')
  .description('Run the Slack bot (Socket Mode): channel→project, thread→Claude session')
  .action(async () => {
    const cfg = loadConfig();
    initSentry(cfg); // no-op unless SENTRY_DSN is set
    await runSlack(cfg);
  });

registerSourcesCommands(program);
registerRoutinesCommands(program);

program.parseAsync(process.argv).catch(async (err) => {
  // A wrong invocation is not an incident: plain message, exit 2, nothing to Sentry.
  if (err instanceof UsageError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  log.error(err instanceof Error ? err.stack || err.message : String(err));
  captureError(err);
  await flushSentry();
  process.exit(1);
});
