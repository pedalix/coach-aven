// The Teams Home card's own cheat-sheet (teamshome.ts) against the Slack App Home's (homeBullets): Teams offers every
// verb Slack teaches (the parity matrix in docs/teams.md), so each one is on the Teams list as `/<verb>` — a verb added
// to Slack and forgotten here fails — and none of Slack's own words (DMs, Slack Connect, workspaces, `/aven`) leak in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CMD, homeBullets } from '../slack/blocks.js';
import { teamsHomeBullets } from './teamshome.js';

const verbsIn = (text: string, prefix: string): Set<string> => {
  const re = new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}([a-z]+)\\b`, 'g');
  return new Set([...text.matchAll(re)].map((m) => m[1]));
};

test('every Slack Home verb is on the Teams Home', () => {
  const slack = verbsIn(homeBullets({ messaging: true }).join('\n'), `${CMD} `);
  const teams = verbsIn(teamsHomeBullets({ messaging: true }).join('\n'), '`/');
  const missing = [...slack].filter((v) => !teams.has(v));
  assert.deepEqual(missing, [], `Slack Home verbs missing from teamshome.ts: ${missing.join(', ')}`);
});

test('no Slack words on the Teams Home: DMs, Slack Connect, workspaces, the Slack command', () => {
  const text = teamsHomeBullets({ messaging: true }).join('\n');
  for (const word of [/\bDMs?\b/, /Slack/i, /workspace/i, new RegExp(CMD.replace('/', '\\/') + '\\b')]) assert.doesNotMatch(text, word);
});

test('the messaging bullets only with messaging', () => {
  assert.ok(teamsHomeBullets({ messaging: true }).length > teamsHomeBullets().length);
  assert.doesNotMatch(teamsHomeBullets().join('\n'), /\/asks/);
});
