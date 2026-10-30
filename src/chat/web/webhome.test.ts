// The web Home's own cheat-sheet (webhome.ts) against the Slack App Home's (homeBullets): every command the Slack
// list teaches is on the web list as `/<verb>`, or named in WEB_LACKS with the reason — a verb added to Slack and
// forgotten here fails. And none of Slack's workspace words leak into a dedicated application.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CMD, homeBullets } from '../slack/blocks.js';
import { WEB_LACKS, webHomeBullets } from './webhome.js';

const verbsIn = (text: string, prefix: string): Set<string> => {
  const re = new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}([a-z]+)\\b`, 'g');
  return new Set([...text.matchAll(re)].map((m) => m[1]));
};

test('every Slack Home verb is on the web Home, or listed as one the web lacks', () => {
  const slack = verbsIn(homeBullets({ messaging: true }).join('\n'), `${CMD} `);
  const web = verbsIn(webHomeBullets({ messaging: true }).join('\n'), '`/');
  const missing = [...slack].filter((v) => !web.has(v) && !(v in WEB_LACKS));
  assert.deepEqual(missing, [], `Slack Home verbs missing from webhome.ts (add them, or to WEB_LACKS with the reason): ${missing.join(', ')}`);
  for (const v of Object.keys(WEB_LACKS)) assert.ok(slack.has(v), `WEB_LACKS names ${v}, which the Slack Home no longer teaches`);
});

test('no Slack workspace words on the web Home: mentions, DMs, pickers, Slack Connect, workspaces', () => {
  const text = webHomeBullets({ messaging: true }).join('\n');
  for (const word of [/@-?mention/i, /\bDM\b/, /picker/i, /Slack/i, /workspace/i, new RegExp(CMD.replace('/', '\\/') + '\\b')]) {
    assert.doesNotMatch(text, word);
  }
});

test('the messaging bullets only with messaging', () => {
  assert.ok(webHomeBullets({ messaging: true }).length > webHomeBullets().length);
  assert.doesNotMatch(webHomeBullets().join('\n'), /\/asks/);
});
