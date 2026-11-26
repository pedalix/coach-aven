import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyOperatorsCmd,
  isOperatorNow,
  operatorsListText,
  parseOperatorsCmd,
  parseSettingCmd,
  settingInForce,
  settingSetText,
  settingShowText,
  type OperatorEntry,
} from './operators.js';

const NOW = new Date('2026-03-02T10:00:00Z');
const entry = (user: string, by = 'UDANA'): OperatorEntry => ({ user, by, at: NOW.toISOString() });
const teams = (u: string | undefined) => u === 'UCONF';

test('flag off: the earlier rule is the whole rule, the chat list is ignored', () => {
  assert.equal(isOperatorNow({ flag: false, isHome: true, list: [entry('UDANA')] }, 'UMILO'), true); // Slack: everyone at home
  assert.equal(isOperatorNow({ flag: false, isHome: true, configured: teams, list: [entry('UMILO')] }, 'UMILO'), false);
  assert.equal(isOperatorNow({ flag: false, isHome: true, configured: teams, list: [] }, 'UCONF'), true);
  assert.equal(isOperatorNow({ flag: false, isHome: false, list: [] }, 'UDANA'), false);
});

test('flag on: config or chat list names an operator; nobody named on Slack means everyone at home', () => {
  assert.equal(isOperatorNow({ flag: true, isHome: true, list: [] }, 'UMILO'), true);
  assert.equal(isOperatorNow({ flag: true, isHome: true, list: [entry('UDANA')] }, 'UMILO'), false);
  assert.equal(isOperatorNow({ flag: true, isHome: true, list: [entry('UDANA')] }, 'UDANA'), true);
  assert.equal(isOperatorNow({ flag: true, isHome: true, configured: teams, list: [entry('UMILO')] }, 'UMILO'), true);
  assert.equal(isOperatorNow({ flag: true, isHome: true, configured: teams, list: [] }, 'UCONF'), true);
  // A driver that names operators in its config never falls back to everyone.
  assert.equal(isOperatorNow({ flag: true, isHome: true, configured: teams, list: [] }, 'UMILO'), false);
  assert.equal(isOperatorNow({ flag: true, isHome: true, list: [entry('UDANA')] }, undefined), false);
});

test('a person outside the home workspace is never an operator', () => {
  assert.equal(isOperatorNow({ flag: true, isHome: false, list: [entry('UDANA')] }, 'UDANA'), false);
  assert.equal(isOperatorNow({ flag: true, isHome: false, list: [] }, 'UDANA'), false);
});

test('operators grammar', () => {
  assert.deepEqual(parseOperatorsCmd('', '/aven'), { action: 'list' });
  assert.deepEqual(parseOperatorsCmd('add <@UMILO|milo>', '/aven'), { action: 'add', userId: 'UMILO' });
  assert.deepEqual(parseOperatorsCmd('remove <@29:abc>', '/aven'), { action: 'remove', userId: '29:abc' });
  assert.equal(parseOperatorsCmd('add milo', '/aven').action, 'error');
  assert.equal(parseOperatorsCmd('promote <@UMILO>', '/aven').action, 'error');
});

test('the first add on Slack also names the caller and ends the everyone rule', () => {
  const r = applyOperatorsCmd({ list: [], configuredCount: 0 }, { action: 'add', userId: 'UMILO' }, 'UDANA', NOW);
  assert.ok('next' in r);
  assert.deepEqual(r.next.map((e) => e.user), ['UDANA', 'UMILO']);
  assert.ok(r.next.every((e) => e.by === 'UDANA' && e.at === NOW.toISOString()));
  assert.match(r.note, /no longer/);
  assert.equal(isOperatorNow({ flag: true, isHome: true, list: r.next }, 'UTHIRD'), false);
  // Naming yourself first adds one entry, not two.
  const self = applyOperatorsCmd({ list: [], configuredCount: 0 }, { action: 'add', userId: 'UDANA' }, 'UDANA', NOW);
  assert.ok('next' in self && self.next.length === 1);
});

test('a later add, and an add where the config names operators, add one entry', () => {
  const later = applyOperatorsCmd({ list: [entry('UDANA')], configuredCount: 0 }, { action: 'add', userId: 'UMILO' }, 'UDANA', NOW);
  assert.ok('next' in later && later.next.length === 2 && !/no longer/.test(later.note));
  const conf = applyOperatorsCmd({ configured: teams, list: [], configuredCount: 1 }, { action: 'add', userId: 'UMILO' }, 'UCONF', NOW);
  assert.ok('next' in conf);
  assert.deepEqual(conf.next.map((e) => e.user), ['UMILO']);
  assert.ok('error' in applyOperatorsCmd({ list: [entry('UMILO')], configuredCount: 0 }, { action: 'add', userId: 'UMILO' }, 'UDANA', NOW));
});

test('remove: not a config-named person, not the last operator when the config names none', () => {
  const conf = applyOperatorsCmd({ configured: teams, list: [entry('UCONF')], configuredCount: 1 }, { action: 'remove', userId: 'UCONF' }, 'UMILO', NOW);
  assert.ok('error' in conf && /config/.test(conf.error));
  const last = applyOperatorsCmd({ list: [entry('UDANA')], configuredCount: 0 }, { action: 'remove', userId: 'UDANA' }, 'UDANA', NOW);
  assert.ok('error' in last && /last operator/.test(last.error));
  const ok = applyOperatorsCmd({ list: [entry('UDANA'), entry('UMILO')], configuredCount: 0 }, { action: 'remove', userId: 'UMILO' }, 'UDANA', NOW);
  assert.ok('next' in ok);
  assert.deepEqual(ok.next.map((e) => e.user), ['UDANA']);
  // With operators in the config the chat list may empty out.
  const emptied = applyOperatorsCmd({ configured: teams, list: [entry('UMILO')], configuredCount: 1 }, { action: 'remove', userId: 'UMILO' }, 'UCONF', NOW);
  assert.ok('next' in emptied && emptied.next.length === 0);
  assert.ok('error' in applyOperatorsCmd({ list: [entry('UDANA')], configuredCount: 0 }, { action: 'remove', userId: 'UNOBODY' }, 'UDANA', NOW));
});

test('the list names each operator with its source', () => {
  const t = operatorsListText({ configured: teams, list: [entry('UMILO')], configuredNames: ['dana@atlas.example'] }, '/aven');
  assert.match(t, /`dana@atlas\.example` — named in the installation's config/);
  assert.match(t, /<@UMILO> — added in chat by <@UDANA> on 2026-03-02/);
  assert.match(operatorsListText({ list: [], configuredNames: [] }, '/aven'), /everyone in the home workspace/);
});

test('model and effort grammar: show, set, default, refusal with the accepted values', () => {
  assert.deepEqual(parseSettingCmd('model', '', '/aven'), { action: 'show' });
  assert.deepEqual(parseSettingCmd('model', 'Opus', '/aven'), { action: 'set', value: 'opus' });
  assert.deepEqual(parseSettingCmd('model', 'default', '/aven'), { action: 'default' });
  const bad = parseSettingCmd('model', 'fastest', '/aven');
  assert.ok(bad.action === 'error' && /`opus`/.test(bad.message) && /`sonnet`/.test(bad.message));
  assert.deepEqual(parseSettingCmd('effort', 'high', '/aven'), { action: 'set', value: 'high' });
  const extreme = parseSettingCmd('effort', 'extreme', '/aven');
  assert.ok(extreme.action === 'error' && /`low`, `medium`, `high`/.test(extreme.message));
  assert.equal(parseSettingCmd('effort', 'high now', '/aven').action, 'error');
});

test('the value in force and its source', () => {
  const chat = { value: 'opus', by: 'UDANA', at: NOW.toISOString() };
  assert.equal(settingInForce(chat, 'sonnet'), 'opus');
  assert.equal(settingInForce(undefined, 'sonnet'), 'sonnet');
  assert.equal(settingInForce(undefined, undefined), undefined);
  assert.match(settingShowText('model', 'atlas', chat, 'sonnet'), /`opus`, set in chat by <@UDANA> on 2026-03-02/);
  assert.match(settingShowText('model', 'atlas', undefined, 'sonnet'), /`sonnet`, the installation's default/);
  assert.match(settingShowText('effort', 'atlas', undefined, undefined), /own default/);
  assert.match(settingSetText('model', 'atlas', 'opus', undefined), /running conversation keeps/);
  assert.match(settingSetText('model', 'atlas', undefined, 'sonnet'), /installation's default \(`sonnet`\)/);
});
