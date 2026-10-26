// The composition root (multi-driver-installation D2, PR 1): one default surface; an additional
// surface named in CHAT_SURFACES is refused at boot before any driver module loads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runChat } from './root.js';
import type { Config } from '../config.js';

test('PR 1: an additional surface is refused loudly, naming it and the way out, before anything starts', async () => {
  const cfg = { chatSurfaces: ['teams'], projectsConfigPath: '/nonexistent/projects.config.json' } as unknown as Config;
  await assert.rejects(runChat(cfg, 'slack'), /CHAT_SURFACES=teams: additional chat surfaces are not available yet .*orch teams/);
});

test('the run mode named again in CHAT_SURFACES is not "additional"', async () => {
  // Reaching the registry load proves the surface check passed (the path is deliberately missing).
  const cfg = { chatSurfaces: ['slack'], projectsConfigPath: '/nonexistent/projects.config.json' } as unknown as Config;
  await assert.rejects(runChat(cfg, 'slack'), (e: unknown) => !/CHAT_SURFACES/.test(String(e)));
});
