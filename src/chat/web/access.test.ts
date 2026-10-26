// Access on the web surface (web-chat-driver 3.5, design D6): one organization per surface is the core's home
// tenant — everyone who logged in may drive (open mode), the operators are the admins — and an actor of any other
// organization never passes the gate, whatever a request claims.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../state.js';
import type { Config } from '../../config.js';
import type { TurnEngine } from '../../turn.js';
import { teamProjects } from '../../projects.js';
import { createInteractions } from '../core/interactions.js';
import type { ChatAction, ChatDriver } from '../driver.js';
import { createActorGate } from '../core/gates.js';
import { effectiveAccess, isAdmin } from '../../access.js';
import { isOperatorOf } from './auth.js';

const ORG = 'corp.example';
const store = () => new Store(join(mkdtempSync(join(tmpdir(), 'aven-web-access-')), 'state.json'));

test('open mode: every person of the organization may drive; the core sees one tenant, and a foreign one owns no project and no action', async () => {
  const s = store();
  const gate = createActorGate(s, ORG);
  assert.equal(gate(ORG, 'sub-ann').ok, true);
  assert.equal(gate(ORG, 'sub-stranger-but-logged-in').ok, true);
  assert.equal(gate(undefined, 'sub-ann').ok, true, 'no tenant = home, as the core treats it');
  // The server stamps every actor with WEB_ORG (server.test.ts pins it); should another organization id ever reach the
  // core, it owns no project (the registry has no workspaces block → only the home tenant sees the fleet) and its
  // actions are not served.
  const reg = { current: { projects: [{ slug: 'alpha', repos: ['Org/alpha'] }] } };
  assert.deepEqual(teamProjects(reg.current as never, 'other.example', ORG), []);
  assert.deepEqual(teamProjects(reg.current as never, ORG, ORG).map((p) => p.slug), ['alpha']);
  const records: unknown[] = [];
  const engine = { recordFeedback: (r: unknown) => (records.push(r), { good: 0, bad: 1 }) } as unknown as TurnEngine;
  const core = createInteractions({ cfg: {} as Config, store: s, reg: reg as never, engine, homeTeamId: ORG, servedTenant: (t) => t === ORG, actor: gate, prefixFor: () => '' });
  const d = { refreshRating: async () => {}, reply: async () => {} } as unknown as ChatDriver;
  const click = (tenant: string): ChatAction => ({ id: 'fb_bad', value: JSON.stringify({ t: 't1-1', s: 'alpha', k: 'web:thread:r1' }), actor: { tenant, user: 'sub-ann' }, where: { conv: 'room:alpha' }, canDialog: false, ctx: { conv: 'room:alpha', user: 'sub-ann' } });
  await core.actions.fb_bad(click('other.example'), d);
  assert.equal(records.length, 0, 'a foreign tenant\'s click is not served');
  await core.actions.fb_bad(click(ORG), d);
  assert.equal(records.length, 1);
});

test('operators are the admins (WEB_OPERATORS by subject or e-mail); a member is not, even in open mode', () => {
  const s = store();
  const access = effectiveAccess(s.getTeamAccess(ORG), true, undefined);
  const operators = ['ops@corp.example', 'sub-root'];
  const isOp = (user: string, email?: string) => isOperatorOf(operators, { user, email });
  assert.equal(isAdmin(access, 'sub-root', isOp('sub-root')), true);
  assert.equal(isAdmin(access, 'sub-ann', isOp('sub-ann', 'ops@corp.example')), true);
  assert.equal(isAdmin(access, 'sub-ann', isOp('sub-ann', 'ann@corp.example')), false);
});
