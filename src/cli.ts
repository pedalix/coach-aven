#!/usr/bin/env -S npx tsx
import { createInterface } from 'node:readline';
import { Command } from 'commander';
import { loadConfig } from './config.js';
import { Store } from './state.js';
import { makeDaytona, ensureSnapshot, ensureSandbox } from './daytona.js';
import { runTask, openChat, attachTask } from './tasks.js';
import { runSlack } from './slack.js';
import { log } from './log.js';

const program = new Command();
program.name('orch').description('Thin orchestrator for per-project Daytona coding-agent sandboxes');

program
  .command('snapshot:ensure')
  .description('Create/activate the project snapshot from SNAPSHOT_IMAGE')
  .action(async () => {
    const cfg = loadConfig();
    await ensureSnapshot(makeDaytona(cfg), cfg);
  });

program
  .command('project:prepare')
  .argument('<slug>', 'short project id, e.g. holidayshop')
  .argument('<repo>', 'GitHub repo, e.g. BluefinOrg/holidayshop-dorfberg')
  .description('Ensure the warm sandbox exists and the repo is cloned')
  .action(async (slug: string, repo: string) => {
    const cfg = loadConfig();
    const store = new Store();
    const daytona = makeDaytona(cfg);
    await ensureSnapshot(daytona, cfg);
    const proj = store.upsertProject(slug, repo);
    await ensureSandbox(daytona, cfg, proj.sandboxName, slug);
    log.info(`prepared (run task:run to clone + work)`);
  });

program
  .command('task:run')
  .argument('<slug>', 'project id')
  .argument('<repo>', 'GitHub repo, e.g. BluefinOrg/holidayshop-dorfberg')
  .requiredOption('-p, --prompt <text>', 'the task for the agent')
  .option('--draft', 'open the PR as a draft', false)
  .description('Run a task end-to-end: worktree → agent → push → PR')
  .action(async (slug: string, repo: string, opts: { prompt: string; draft: boolean }) => {
    const cfg = loadConfig();
    const store = new Store();
    const task = await runTask(cfg, store, {
      slug,
      repo,
      prompt: opts.prompt,
      draftPr: opts.draft,
    });
    log.info(`task ${task.id}: ${task.status}${task.prUrl ? ` ${task.prUrl}` : ''}`);
    process.exit(task.status === 'done' ? 0 : 1);
  });

program
  .command('chat')
  .argument('<slug>', 'project id')
  .argument('<repo>', 'GitHub repo, e.g. BluefinOrg/holidayshop-dorfberg')
  .option('-p, --prompt <text>', 'one-shot question (omit to start an interactive REPL)')
  .description('Read-only: ask the agent about the cloned repo (no PR). Remembers context.')
  .action(async (slug: string, repo: string, opts: { prompt?: string }) => {
    const cfg = loadConfig();
    const store = new Store();
    const chat = await openChat(cfg, store, { slug, repos: [repo] });

    // One-shot mode.
    if (opts.prompt) {
      process.stdout.write(`\n${await chat.ask(opts.prompt)}\n`);
      return;
    }

    // Interactive REPL — type a question, get an answer, follow-ups keep context.
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let closed = false;
    rl.on('close', () => {
      closed = true;
    });
    const prompt = () => {
      if (!closed) rl.prompt();
    };
    log.info('Interactive chat — ask about the codebase. Conversation is remembered.');
    log.info('Type a question + Enter. Ctrl-D (or "exit") to quit.\n');
    rl.setPrompt('ask> ');
    prompt();
    for await (const line of rl) {
      const q = line.trim();
      if (q === 'exit' || q === 'quit') break;
      if (!q) {
        prompt();
        continue;
      }
      try {
        process.stdout.write('\n');
        process.stdout.write(`${await chat.ask(q)}\n\n`);
      } catch (e) {
        log.error(e instanceof Error ? e.message : String(e));
      }
      prompt();
    }
    if (!closed) rl.close();
  });

program
  .command('task:attach')
  .argument('<slug>', 'project id')
  .argument('<taskId>', 'task id')
  .description('Interactive session: type messages to a live agent (Ctrl-D to detach)')
  .action(async (slug: string, taskId: string) => {
    const cfg = loadConfig();
    const store = new Store();
    const session = await attachTask(cfg, store, slug, taskId, (text) =>
      process.stdout.write(text),
    );
    const rl = createInterface({ input: process.stdin });
    log.info('attached. Type a message + Enter to send to the agent. Ctrl-D to detach.');
    for await (const line of rl) {
      await session.send(line);
    }
    await session.close();
  });

program
  .command('slack')
  .description('Run the Slack bot (Socket Mode): channel→project, thread→Claude session')
  .action(async () => {
    const cfg = loadConfig();
    await runSlack(cfg);
  });

program
  .command('project:list')
  .description('List known projects + tasks')
  .action(async () => {
    const store = new Store();
    for (const p of store.listProjects()) {
      const tasks = Object.values(p.tasks);
      log.info(`${p.slug}  (${p.repo})  sandbox=${p.sandboxName}  tasks=${tasks.length}`);
      for (const t of tasks) {
        log.info(`   - ${t.id}  ${t.status}  ${t.branch}${t.prUrl ? `  ${t.prUrl}` : ''}`);
      }
    }
  });

program.parseAsync(process.argv).catch((err) => {
  log.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
