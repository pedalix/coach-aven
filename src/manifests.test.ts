import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_BOT_SCOPES } from './config.js';
import { USER_SCOPES } from './sources/slack/auth.js';

// Two Slack app templates: the bot (slack-app-manifest.json, installed in every workspace the
// bot serves) and the personal sources app (slack-sources-manifest.json, a user token for
// `orch sources auth <slug> slack add`). Each must ask for exactly what the code requests.
type Manifest = { features?: unknown; oauth_config: { scopes: { bot?: string[]; user?: string[] } } };
const read = (name: string) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')) as Manifest;

test('the bot manifest: bot scopes = DEFAULT_BOT_SCOPES (the OAuth install request), no user scopes, nothing only an admin may install', () => {
  const { scopes } = read('slack-app-manifest.json').oauth_config;
  assert.deepEqual([...(scopes.bot ?? [])].sort(), [...DEFAULT_BOT_SCOPES].sort());
  assert.equal(scopes.user, undefined, 'a user token is issued to whoever installs: the bot never uses one');
  assert.ok(!DEFAULT_BOT_SCOPES.includes('conversations.connect:manage'), 'admin-only: a member cannot install the app even once it is approved');
});

test('the sources manifest: user scopes = USER_SCOPES (what the puller and `slack exchange` ask for), no bot', () => {
  const m = read('slack-sources-manifest.json');
  assert.deepEqual([...(m.oauth_config.scopes.user ?? [])].sort(), [...USER_SCOPES].sort());
  assert.equal(m.oauth_config.scopes.bot, undefined);
  assert.equal(m.features, undefined);
});
