// `orch routines list [slug]` / `orch routines run <id>` — operate scheduled routines from the
// bot host without Slack. `run` cannot fire in this process (it needs the live Slack client and
// the turn engine), so it drops a request into the control channel the running bot watches
// (control.ts) and waits for the bot to take it.

import type { Command } from 'commander';
import { Store } from './state.js';
import { controlDir, waitConsumed, writeRunRequest } from './control.js';
import { UsageError } from './sources/errors.js';

export function registerRoutinesCommands(program: Command): void {
  const cmd = program.command('routines').description('List scheduled routines or ask the running bot to fire one now');
  cmd
    .command('list [slug]')
    .description('Routines from state.json (id, kind, schedule, channel, on/off)')
    .action((slug?: string) => {
      const rs = new Store().listRoutines(slug ? { slug } : undefined);
      if (!rs.length) {
        process.stdout.write('no routines\n');
        return;
      }
      for (const r of rs) {
        const kind = r.kind ?? 'report';
        process.stdout.write(`${r.id}\t${r.slug}\t${kind}\t${r.enabled ? 'on ' : 'off'}\t${r.spec} (${r.tz})\t${r.channel}\t${r.prompt.slice(0, 60).replace(/\s+/g, ' ')}\n`);
      }
    });
  cmd
    .command('run <id>')
    .description('Fire a routine now through the running bot (same path as /aven routines run)')
    .option('--timeout <seconds>', 'how long to wait for the bot to take the request', '10')
    .action(async (id: string, opts: { timeout: string }) => {
      const r = new Store().getRoutine(id);
      if (!r) throw new UsageError(`no routine ${JSON.stringify(id)} in state.json (see: orch routines list)`);
      const path = writeRunRequest(controlDir(), id);
      const ok = await waitConsumed(path, Math.max(1, Number(opts.timeout) || 10) * 1000);
      if (!ok) throw new UsageError(`bot not running (request left at ${path}; it fires when the bot starts)`);
      process.stdout.write(`${id}: handed to the bot (${r.kind ?? 'report'} for ${r.slug}) — see the bot log / the channel\n`);
    });
}
