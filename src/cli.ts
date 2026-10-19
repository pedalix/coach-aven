#!/usr/bin/env -S npx tsx
import { Command } from 'commander';
import { loadConfig, retiredEnvWarnings } from './config.js';
import { runSlack } from './chat/slack/app.js';
import { runTeams } from './chat/teams/app.js';
import { log } from './log.js';
import { initSentry, captureError, flushSentry } from './sentry.js';
import { registerSourcesCommands } from './sources/cli.js';
import { registerRoutinesCommands } from './routinescli.js';
import { registerHubCommands } from './messaging/cli.js';
import { ConfigError, UsageError } from './sources/errors.js';
import { unknownCommandText } from './chat/drivers.js';

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
    for (const w of retiredEnvWarnings(process.env)) log.warn(w);
    await runSlack(cfg);
  });

program
  .command('teams')
  .description('Run the Microsoft Teams bot (HTTPS endpoint behind your reverse proxy): channel→project, reply chain→Claude session')
  .action(async () => {
    const cfg = loadConfig();
    initSentry(cfg);
    for (const w of retiredEnvWarnings(process.env)) log.warn(w);
    await runTeams(cfg);
  });

registerSourcesCommands(program);
registerRoutinesCommands(program);
registerHubCommands(program);

// An unknown command (e.g. a chat driver this build doesn't have) lists the run modes.
program.on('command:*', (operands: string[]) => {
  process.stderr.write(`${unknownCommandText(operands[0] ?? '')}\n`);
  process.exit(1);
});

program.parseAsync(process.argv).catch(async (err) => {
  // A wrong invocation is not an incident: plain message, exit 2, nothing to Sentry.
  if (err instanceof UsageError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  // A configuration the bot refuses to run on (a setting that would move a project to another sandbox,
  // OpenSpec retire-daytona-driver D3/D4): one line, no stack, so it stays among the last journal lines
  // the deploy's health check prints; exit 1, and nothing to Sentry — it is the operator's fix, not an
  // incident, and the unit's restarts would repeat it every few seconds.
  if (err instanceof ConfigError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
  log.error(err instanceof Error ? err.stack || err.message : String(err));
  captureError(err);
  await flushSentry();
  process.exit(1);
});
