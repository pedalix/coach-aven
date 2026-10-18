// `/verb` commands through the REAL core router over the Teams driver + recorder (OpenSpec
// teams-chat-driver): what the canary found on the real installation (2026-10-18) — `/home`
// in the 1:1 chat went to the agent as a question because the router had no such verb.
// Teams has no App Home tab, so the verb posts the Home card; Slack leaves the dep unset and
// keeps today's shape (the verb stays a question — pinned here too).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Config } from '../../config.js';
import { Store } from '../../state.js';
import { createChannels } from '../../channels.js';
import type { TurnEngine } from '../../turn.js';
import type { Pollers } from '../../pollers.js';
import { createCommands, type CommandDeps } from '../core/commands.js';
import type { Actor, ChatDriver } from '../driver.js';
import { teamsDriver } from './driver.js';
import { Recorder } from './twin.js';

const TENANT = '00000000-0000-4000-8000-00000000000a';
const CH = '19:ALPHA@thread.tacv2';
const USER = '29:USER1';

function harness(o: { home?: CommandDeps['home'] } = {}) {
  const reg = { current: { projects: [{ slug: 'alpha', repos: ['Org/alpha'], teamsChannel: CH }], workspaces: { [TENANT]: ['alpha'] } } };
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'aven-teams-cmd-')), 'state.json'));
  const log: unknown[] = [];
  const engine = {
    liveTurn: async (_d: ChatDriver, channel: string, _m: unknown, _t: unknown, key: string, project: { slug: string }, question: string) => {
      log.push({ liveTurn: { channel, key, slug: project.slug, question } });
    },
    runAsk: async (key: string, project: { slug: string }, question: string) => (log.push({ runAsk: { key, slug: project.slug, question } }), 'ok'),
    hasKey: () => false,
    projectBusy: () => false,
  } as unknown as TurnEngine;
  const channels = createChannels(reg as never, () => TENANT);
  const cfg = { sandbox: { namePrefix: 'proj-', workDir: '/w', autoStopMinutes: 1 }, projectsConfigPath: '/nonexistent/projects.config.json' } as unknown as Config;
  const commands = createCommands({ cfg, store, reg: reg as never, engine, channels, pollers: {} as Pollers, homeTeamId: TENANT, ...(o.home ? { home: o.home } : {}) });
  const api = new Recorder();
  const driver = teamsDriver(api, { tenantId: TENANT, statusMinMs: 0 });
  const actor: Actor & { user: string } = { tenant: TENANT, user: USER };
  const run = (text: string, conv = 'a:PERSONAL1') => commands.run({ text, conv, actor, ctx: { conv, user: USER, direct: !conv.includes('@thread') } }, driver);
  return { run, api, log, driver, actor };
}

test('teams: /home posts the Home card for the caller, nothing reaches the agent', async () => {
  const homed: unknown[] = [];
  const h = harness({ home: async (who, d) => void homed.push({ who, isDriver: d === h.driver }) });
  await h.run('home');
  assert.deepEqual(homed, [{ who: h.actor, isDriver: true }]);
  assert.deepEqual(h.log, []);
  assert.deepEqual(h.api.calls, []);
});

test('without the home dep (Slack) the verb stays a question to the agent — today\'s shape', async () => {
  const h = harness();
  await h.run('home', CH); // typed in the project channel: a private question, answered in the 1:1
  assert.equal(h.log.length, 1);
  assert.equal((h.log[0] as { liveTurn: { question: string } }).liveTurn.question, 'home');
});
