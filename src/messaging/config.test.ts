import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messagingEnv, messagingLimits, validateMessagingConfig } from './config.js';

const W = 'project "caldora" messaging';

test('validateMessagingConfig — the full block, as written in projects.config.json', () => {
  const c = validateMessagingConfig(
    { send: true, accept: ['home/owen-ops', 'nora', '*'], description: 'Orders, payments and partner bookings of caldora', sendPerDay: 50, acceptPerDay: 30, maxRounds: 5, costWarnUsd: 2 },
    W,
  );
  assert.deepEqual(c.accept, ['home/owen-ops', 'nora', '*']);
  assert.deepEqual(messagingLimits(c), { sendPerDay: 50, acceptPerDay: 30, maxRounds: 5, costWarnUsd: 2 });
});

test('validateMessagingConfig — an empty block is valid: nobody may ask, no sending, the defaults', () => {
  const c = validateMessagingConfig({}, W);
  assert.deepEqual(c, {});
  assert.deepEqual(messagingLimits(c), { sendPerDay: 50, acceptPerDay: 30, maxRounds: 5, costWarnUsd: 2 });
});

test('validateMessagingConfig — a typo fails loudly, naming the field', () => {
  assert.throws(() => validateMessagingConfig([], W), /messaging must be an object/);
  assert.throws(() => validateMessagingConfig({ send: 'yes' }, W), /\.send must be true or false/);
  assert.throws(() => validateMessagingConfig({ accept: 'home/owen-ops' }, W), /\.accept must be an array/);
  assert.throws(() => validateMessagingConfig({ accept: ['home/owen-ops', 'Home/Owen', 'bluefin/*', ' nora'] }, W), /"Home\/Owen", "bluefin\/\*", " nora" is not/);
  assert.throws(() => validateMessagingConfig({ description: 'two\nlines' }, W), /one line/);
  assert.throws(() => validateMessagingConfig({ maxRounds: 2.5 }, W), /maxRounds must be an integer/);
  assert.throws(() => validateMessagingConfig({ acceptPerDay: -1 }, W), /acceptPerDay must be an integer/);
  assert.throws(() => validateMessagingConfig({ costWarnUsd: 0 }, W), /costWarnUsd/);
});

test('validateMessagingConfig — a field this release does not know is ignored (the ops repo may be ahead of a tagged bot)', () => {
  assert.deepEqual(validateMessagingConfig({ send: true, mirrorToChannel: true }, W), { send: true });
});

test('messagingEnv — nothing set: installation `local`, no hub', () => {
  assert.deepEqual(messagingEnv({}), { installation: 'local' });
});

test('messagingEnv — the hub needs an explicit installation id and a key file; otherwise it says why and local messaging stays', () => {
  assert.deepEqual(messagingEnv({ INSTALLATION_ID: 'home', HUB_URL: 'wss://hub.example', HUB_KEY_PATH: '/srv/hub.key' }), {
    installation: 'home',
    hub: { url: 'wss://hub.example', keyPath: '/srv/hub.key' },
  });
  assert.match(messagingEnv({ HUB_URL: 'wss://hub.example', HUB_KEY_PATH: '/k' }).hubProblem!, /explicit INSTALLATION_ID/);
  assert.match(messagingEnv({ INSTALLATION_ID: 'local', HUB_URL: 'wss://hub.example', HUB_KEY_PATH: '/k' }).hubProblem!, /explicit INSTALLATION_ID/);
  assert.match(messagingEnv({ INSTALLATION_ID: 'home', HUB_URL: 'wss://hub.example' }).hubProblem!, /HUB_KEY_PATH/);
  assert.match(messagingEnv({ INSTALLATION_ID: 'home', HUB_URL: 'https://hub.example', HUB_KEY_PATH: '/k' }).hubProblem!, /wss:\/\//);
  assert.equal(messagingEnv({ INSTALLATION_ID: 'home', HUB_URL: 'wss://hub.example' }).installation, 'home');
});

test('messagingEnv — an invalid INSTALLATION_ID fails the boot (it goes into every address)', () => {
  assert.throws(() => messagingEnv({ INSTALLATION_ID: 'Home Bot' }), /INSTALLATION_ID must match/);
});
