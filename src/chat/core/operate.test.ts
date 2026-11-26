// The operator's controls without any chat platform (OpenSpec operator-controls): what the Home and the Session
// card carry for whom, and that a press does what the command does — after checking the operator rule again.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../state.js';
import type { Config } from '../../config.js';
import type { TurnEngine } from '../../turn.js';
import type { ChatAction, ChatDriver } from '../driver.js';
import type { HomeView, PrivateView } from '../views.js';
import { createActorGate } from './gates.js';
import { createInteractions } from './interactions.js';
import { createOperate } from './operate.js';

function setup(o: { flag?: boolean; projectConv?: boolean } = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'aven-operate-')), 'state.json'));
  const calls: { op: string; args: unknown[] }[] = [];
  const d = new Proxy({}, { get: (_t, op: string) => async (...args: unknown[]) => (calls.push({ op, args }), undefined) }) as unknown as ChatDriver;
  const cfg = { operatorControls: o.flag !== false, projectsConfigPath: '/nonexistent/projects.config.json' } as unknown as Config;
  const reg = { current: { projects: [{ slug: 'atlas', repos: ['Org/atlas'] }, { slug: 'borealis', repos: ['Org/borealis'] }], workspaces: { H: ['atlas', 'borealis'], C: ['borealis'] } } };
  const engine = { slugForKey: () => 'atlas', hasKey: () => false } as unknown as TurnEngine;
  const ended: string[] = [];
  const pollers = { endGrant: async (g: { slug: string; capability: string }) => (ended.push(`${g.slug}:${g.capability}`), store.deleteGrant(g.slug, g.capability)) };
  const operate = createOperate({ cfg, store, reg: reg as never, pollers: pollers as never, homeTeamId: 'H' });
  const core = createInteractions({
    cfg,
    store,
    reg: reg as never,
    engine,
    homeTeamId: 'H',
    servedTenant: (t) => t === 'H' || t === 'C',
    actor: createActorGate(store, 'H'),
    prefixFor: () => 'aven-',
    operate,
    ...(o.projectConv === false ? {} : { projectConv: async (_d: ChatDriver, p: { slug: string }) => `C_${p.slug}` }),
  });
  const homes = () => calls.filter((c) => c.op === 'publishHome').map((c) => c.args[1] as Extract<HomeView, { kind: 'home' }>);
  const replies = () => calls.filter((c) => c.op === 'reply').map((c) => (c.args[1] as { text: string }).text);
  return { store, core, d, calls, homes, replies, ended };
}

const DANA = { user: 'UDANA', by: 'UDANA', at: '2026-03-02T10:00:00.000Z' };
const press = (id: string, value: string, o: { user?: string; tenant?: string; home?: boolean } = {}): ChatAction => ({
  id,
  value,
  actor: { tenant: o.tenant ?? 'H', user: o.user ?? 'UDANA' },
  ...(o.home ? {} : { where: { conv: 'C_THREAD', thread: '1.0' } }),
  canDialog: true,
  ctx: undefined,
});
const choice = (w: string, v: string, home = false, s = 'atlas') => JSON.stringify({ s, w, v, ...(home ? { h: 1 } : {}) });

test('flag off: the Home and the card carry no operator part, and a control does nothing', async () => {
  const t = setup({ flag: false });
  await t.core.home({ tenant: 'H', user: 'UDANA' }, t.d);
  assert.equal(t.homes()[0].operator, undefined);
  await t.core.actions.op_set(press('op_set', choice('model', 'opus')), t.d);
  await t.core.actions.session_panel(press('session_panel', JSON.stringify({ key: 'thread:1.0', channel: 'C_THREAD', threadTs: '1.0' })), t.d);
  assert.deepEqual(t.store.getProjectSettings('atlas'), {});
  const card = t.calls.find((c) => c.op === 'postPrivate')?.args[2] as Extract<PrivateView, { kind: 'sessionPanel' }>;
  assert.equal(card.info.operator, undefined);
  assert.deepEqual(t.replies(), []);
});

test('the Home shows an operator the section: operators, and each project of the home workspace', async () => {
  const t = setup();
  t.store.setOperators([DANA]);
  t.store.patchProjectSettings('atlas', { model: { value: 'opus', by: 'UDANA', at: DANA.at } });
  t.store.setGrant({ slug: 'atlas', capability: 'workflows', at: new Date().toISOString(), until: new Date(Date.now() + 60_000).toISOString(), by: 'UDANA', channel: 'C_atlas' });
  await t.core.home({ tenant: 'H', user: 'UDANA' }, t.d);
  const op = t.homes()[0].operator;
  assert.ok(op);
  assert.deepEqual(op.operators, ['<@UDANA>']);
  assert.equal(op.everyone, false);
  assert.deepEqual(op.projects.map((p) => p.slug), ['atlas', 'borealis']);
  assert.deepEqual(op.projects[0].model, { value: 'opus', source: 'chat' });
  assert.deepEqual(op.projects[0].grants.map((g) => g.capability), ['workflows']);
  assert.match(op.projects[0].line, /\*atlas\* — model `opus` · effort _CLI default_ · grants: `workflows` until \d\d:\d\d/);
});

test('someone who is not an operator gets the Home and the card as they were', async () => {
  const t = setup();
  t.store.setOperators([DANA]);
  await t.core.home({ tenant: 'H', user: 'UMILO' }, t.d);
  assert.equal(t.homes()[0].operator, undefined);
  assert.equal(t.homes()[0].notice, undefined);
  await t.core.actions.session_panel(press('session_panel', JSON.stringify({ key: 'thread:1.0', channel: 'C_THREAD', threadTs: '1.0' }), { user: 'UMILO' }), t.d);
  await t.core.actions.session_panel(press('session_panel', JSON.stringify({ key: 'thread:1.0', channel: 'C_THREAD', threadTs: '1.0' })), t.d);
  const cards = t.calls.filter((c) => c.op === 'postPrivate').map((c) => (c.args[2] as Extract<PrivateView, { kind: 'sessionPanel' }>).info.operator);
  assert.equal(cards[0], undefined);
  assert.equal(cards[1]?.slug, 'atlas');
});

test('a client workspace never gets the section', async () => {
  const t = setup();
  await t.core.home({ tenant: 'C', user: 'UCLIENT' }, t.d);
  assert.equal(t.homes()[0].operator, undefined);
});

test('a control pressed by someone who is no longer an operator changes nothing and says so', async () => {
  const t = setup();
  t.store.setOperators([DANA]);
  await t.core.actions.op_set(press('op_set', choice('model', 'opus'), { user: 'UMILO' }), t.d);
  await t.core.actions.op_set(press('op_set', choice('grant', 'workflows', true), { user: 'UMILO', home: true }), t.d);
  await t.core.actions.op_reload(press('op_reload', 'home', { user: 'UMILO', home: true }), t.d);
  assert.deepEqual(t.store.getProjectSettings('atlas'), {});
  assert.deepEqual(t.store.listGrants(), []);
  assert.deepEqual(t.replies(), [':lock: This control is operator-only.']);
  assert.deepEqual(t.homes().map((h) => [h.operator, h.notice]), [[undefined, ':lock: This control is operator-only.'], [undefined, ':lock: This control is operator-only.']]);
});

test('model and effort from the card: stored as the command stores them, answered privately', async () => {
  const t = setup();
  await t.core.actions.op_set(press('op_set', choice('model', 'opus')), t.d);
  await t.core.actions.op_set(press('op_set', choice('effort', 'high')), t.d);
  const s = t.store.getProjectSettings('atlas');
  assert.equal(s.model?.value, 'opus');
  assert.equal(s.model?.by, 'UDANA');
  assert.equal(s.effort?.value, 'high');
  assert.match(t.replies()[0], /\*atlas\* — model: `opus`\. Conversations that start from now on/);
  await t.core.actions.op_set(press('op_set', choice('model', 'default')), t.d);
  assert.equal(t.store.getProjectSettings('atlas').model, undefined);
  assert.deepEqual(t.homes(), []);
});

test('a grant from the Home is announced in the project\'s own conversation, and the Home shows the outcome', async () => {
  const t = setup();
  await t.core.actions.op_set(press('op_set', choice('grant', 'workflows', true), { home: true }), t.d);
  const g = t.store.getGrant('atlas', 'workflows');
  assert.equal(g?.channel, 'C_atlas');
  assert.equal(g?.by, 'UDANA');
  assert.equal(Date.parse(g!.until) - Date.parse(g!.at), 30 * 60_000);
  const post = t.calls.find((c) => c.op === 'post');
  assert.deepEqual(post?.args[0], { conv: 'C_atlas' });
  const home = t.homes()[0];
  assert.match(home.operator?.note ?? '', /Granted/);
  assert.deepEqual(home.operator?.projects[0].grants.map((x) => x.capability), ['workflows']);
  // Ending it goes through the pollers' end path, as `/aven grant workflows off` does.
  await t.core.actions.op_set(press('op_set', choice('ungrant', 'workflows', true), { home: true }), t.d);
  assert.deepEqual(t.ended, ['atlas:workflows']);
  assert.match(t.homes()[1].operator?.note ?? '', /Ended \*atlas\*'s `workflows` grant/);
});

test('a grant from the card is announced in the card\'s conversation', async () => {
  const t = setup();
  await t.core.actions.op_set(press('op_set', choice('grant', 'actions')), t.d);
  assert.equal(t.store.getGrant('atlas', 'actions')?.channel, 'C_THREAD');
});

test('a grant from the Home is refused where the project has no conversation to announce it in', async () => {
  const t = setup({ projectConv: false });
  await t.core.actions.op_set(press('op_set', choice('grant', 'workflows', true), { home: true }), t.d);
  assert.deepEqual(t.store.listGrants(), []);
  assert.match(t.homes()[0].operator?.note ?? '', /no conversation/);
});

test('reload from the Home runs the command\'s reload and shows its outcome', async () => {
  const t = setup();
  await t.core.actions.op_reload(press('op_reload', 'home', { home: true }), t.d);
  assert.match(t.homes()[0].operator?.note ?? '', /The previous config stays active/);
});

test('a control naming a project outside the presser\'s workspace, or a value the commands refuse, does nothing', async () => {
  const t = setup();
  await t.core.actions.op_set(press('op_set', choice('model', 'opus', false, 'elsewhere')), t.d);
  await t.core.actions.op_set(press('op_set', choice('model', 'fastest')), t.d);
  await t.core.actions.op_set(press('op_set', choice('grant', 'deploy')), t.d);
  assert.deepEqual(t.store.getProjectSettings('atlas'), {});
  assert.deepEqual(t.store.listGrants(), []);
  assert.match(t.replies()[0], /No project `elsewhere` here/);
  assert.equal(t.replies().length, 1);
});
