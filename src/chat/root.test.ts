// The composition root (multi-driver-installation D2, D7): every configured surface is prepared before
// any starts, wired with its name (the default without one), started in order; a surface that cannot
// start closes the ones already open and fails the boot naming it; a surface that cannot be prepared
// fails the boot before anything starts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runChat, type PreparedSurface, type SurfacePlugin } from './root.js';
import type { ChatDriverName } from './drivers.js';
import type { Config } from '../config.js';
import { Store } from '../state.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'aven-root-'));
  const projects = join(dir, 'projects.config.json');
  writeFileSync(projects, JSON.stringify({ projects: [{ slug: 'alpha', repos: ['Org/alpha'], slackChannel: 'C_ALPHA', teamsChannel: '19:ALPHA@thread.tacv2' }] }));
  const cfg = { projectsConfigPath: projects, chatSurfaces: [] as ChatDriverName[], sandbox: { namePrefix: 'proj-', workDir: '/w', autoStopMinutes: 1 }, sandboxDriver: 'ssh-docker', messaging: { installation: 'local' } } as unknown as Config;
  const store = new Store(join(dir, 'state.json'));
  const events: string[] = [];
  const plugin = (name: ChatDriverName, o: { prepareFails?: boolean; startFails?: boolean } = {}): SurfacePlugin => ({
    name,
    async prepare(): Promise<PreparedSurface> {
      if (o.prepareFails) throw new Error(`no settings for ${name}`);
      events.push(`prepare:${name}`);
      return {
        name,
        homeTenantId: () => (name === 'slack' ? 'T0HOME' : '00000000-0000-4000-8000-00000000000a'),
        driverFor: () => ({}) as never,
        hasHome: false, // no recovery, no pollers: the root's sequencing is what this test pins
        async wire(shared) {
          events.push(`wire:${name}:${shared.surface ?? 'default'}:${await shared.channels.channelIdForSlug({ findConversation: async () => undefined }, shared.reg.current.projects[0]!)}`);
          return {
            async start() {
              if (o.startFails) throw new Error(`port taken for ${name}`);
              events.push(`start:${name}`);
            },
            async stop() {
              events.push(`stop:${name}`);
            },
            closing: `the ${name} transport`,
          };
        },
      };
    },
  });
  return { cfg, store, events, plugin };
}

test('one default surface and one additional: both prepared first, wired with their name and their own channel directory, started in order', async () => {
  const { cfg, store, events, plugin } = setup();
  cfg.chatSurfaces = ['teams'];
  await runChat(cfg, 'slack', { store, plugins: { slack: plugin('slack'), teams: plugin('teams') } });
  assert.deepEqual(events, ['prepare:slack', 'prepare:teams', 'wire:slack:default:C_ALPHA', 'wire:teams:teams:19:ALPHA@thread.tacv2', 'start:slack', 'start:teams']);
});

test('the run mode named again in CHAT_SURFACES is the default, not an extra', async () => {
  const { cfg, store, events, plugin } = setup();
  cfg.chatSurfaces = ['slack'];
  await runChat(cfg, 'slack', { store, plugins: { slack: plugin('slack') } });
  assert.deepEqual(events, ['prepare:slack', 'wire:slack:default:C_ALPHA', 'start:slack']);
});

test('an additional surface that cannot start closes the surfaces already open and fails the boot naming it', async () => {
  const { cfg, store, events, plugin } = setup();
  cfg.chatSurfaces = ['teams'];
  await assert.rejects(runChat(cfg, 'slack', { store, plugins: { slack: plugin('slack'), teams: plugin('teams', { startFails: true }) } }), /chat surface teams could not start: port taken for teams/);
  assert.deepEqual(events.slice(-2), ['start:slack', 'stop:slack']);
});

test('a surface that cannot be prepared fails the boot before anything starts', async () => {
  const { cfg, store, events, plugin } = setup();
  cfg.chatSurfaces = ['teams'];
  await assert.rejects(runChat(cfg, 'slack', { store, plugins: { slack: plugin('slack'), teams: plugin('teams', { prepareFails: true }) } }), /chat surface teams \(CHAT_SURFACES\) cannot start: no settings for teams/);
  assert.deepEqual(events, ['prepare:slack']);
});
