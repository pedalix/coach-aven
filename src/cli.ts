#!/usr/bin/env -S npx tsx
import { Command } from 'commander';
import { installDirLine, loadConfig, retiredEnvWarnings } from './config.js';
import { runChat } from './chat/root.js';
import { log } from './log.js';
import { creditBootLine } from './credit.js';
import { initSentry, captureError, flushSentry } from './sentry.js';
import { registerSourcesCommands } from './sources/cli.js';
import { registerRoutinesCommands } from './routinescli.js';
import { registerHubCommands } from './messaging/cli.js';
import { UsageError } from './sources/errors.js';
import { unknownCommandText } from './chat/drivers.js';
import { runMirror } from './mirrorjob.js';

const program = new Command();
program.name('orch').description('CoachAven — per-project coding-agent sandboxes driven from Slack');
// Positional option parsing lets `orch sources auth <slug> <kind> login --client x` hand the
// trailing flags to the connector untouched instead of commander rejecting them.
program.enablePositionalOptions();

program
  .command('slack')
  .description('Run the Slack bot (Socket Mode): channel→project, thread→Claude session')
  .action(async () => {
    log.info(installDirLine()); // once, before the chat driver starts (installation-directory)
    const cfg = loadConfig();
    initSentry(cfg); // no-op unless SENTRY_DSN is set
    for (const w of retiredEnvWarnings(process.env)) log.warn(w);
    log.info(creditBootLine(cfg.credit));
    await runChat(cfg, 'slack');
  });

program
  .command('teams')
  .description('Run the Microsoft Teams bot (HTTPS endpoint behind your reverse proxy): channel→project, reply chain→Claude session')
  .action(async () => {
    log.info(installDirLine());
    const cfg = loadConfig();
    initSentry(cfg);
    for (const w of retiredEnvWarnings(process.env)) log.warn(w);
    log.info(creditBootLine(cfg.credit));
    await runChat(cfg, 'teams');
  });

program
  .command('web')
  .description('Run the web chat (an HTTP listener behind your reverse proxy, OIDC login): room→project, thread→Claude session')
  .action(async () => {
    log.info(installDirLine());
    const cfg = loadConfig();
    initSentry(cfg);
    for (const w of retiredEnvWarnings(process.env)) log.warn(w);
    log.info(creditBootLine(cfg.credit));
    await runChat(cfg, 'web');
  });

program
  .command('mirror')
  .description('Mirror the repos listed in mirrors.json (installation directory) into the App’s organization — the crontab job (docs/runtime-config.md → Repo mirrors)')
  .action(async () => {
    process.exit(await runMirror());
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
  log.error(err instanceof Error ? err.stack || err.message : String(err));
  captureError(err);
  await flushSentry();
  process.exit(1);
});
