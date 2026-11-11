// The capabilities table in docs/chat-drivers.md is what the drivers declare — rendered here from the code and
// compared byte for byte, the way the Teams and web Home tests pin the verbs. A new capability or a changed value
// fails this test until the document shows it: UPDATE_SNAPSHOTS=1 rewrites the table in place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { capabilitiesTable, replaceTable, tableIn, type DriverColumn } from './capabilities.js';
import { SLACK_CAPABILITIES } from './slack/driver.js';
import { teamsCapabilities } from './teams/driver.js';
import { WEB_CAPABILITIES } from './web/driver.js';
import { SHADOW_CAPABILITIES } from './shadow/driver.js';

const DOC = new URL('../../docs/chat-drivers.md', import.meta.url);

const COLUMNS: DriverColumn[] = [
  { name: 'Slack', caps: SLACK_CAPABILITIES },
  { name: 'Teams', caps: teamsCapabilities({}), notes: { threadRepliesNeedMention: 'the default (the team consented to RSC); an installation without that consent sets it to yes' } },
  { name: 'Web', caps: WEB_CAPABILITIES },
  { name: 'Shadow (agent-to-agent journal)', caps: SHADOW_CAPABILITIES },
];

test('docs/chat-drivers.md carries the capabilities table the drivers declare', () => {
  const table = capabilitiesTable(COLUMNS);
  let doc = readFileSync(DOC, 'utf8');
  if (process.env.UPDATE_SNAPSHOTS === '1') {
    doc = replaceTable(doc, table);
    writeFileSync(DOC, doc);
  }
  assert.equal(tableIn(doc), table, 'docs/chat-drivers.md is stale — UPDATE_SNAPSHOTS=1 npm test -- src/chat/capabilities.test.ts rewrites the table');
});

test('the table renders one row per capability and one column per driver', () => {
  const t = capabilitiesTable([{ name: 'A', caps: { reactions: true, privateReplies: 'native', threadRepliesNeedMention: false, outboundFiles: true } }]);
  const lines = t.split('\n');
  assert.equal(lines[0], '| Capability | A |');
  assert.equal(lines.length, 2 + 4);
  assert.match(lines[2], /\| yes \|$/);
  assert.match(lines[3], /\| `native` \|$/);
  assert.equal(tableIn(replaceTable('x\n<!-- capabilities:start -->\nold\n<!-- capabilities:end -->\ny', t)), t);
  assert.equal(tableIn('no markers'), undefined);
});
