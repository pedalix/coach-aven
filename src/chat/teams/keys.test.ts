import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deepLink, splitConversation, targetId, threadOf } from './keys.js';
import { isThreadKey, slugOfBase, splitTeam } from '../../teamkeys.js';

const CH = '19:CHANNEL1@thread.tacv2';

test('a channel reply chain splits into the channel and the root; a 1:1 id stays whole', () => {
  assert.deepEqual(splitConversation(`${CH};messageid=100`), { conv: CH, root: '100' });
  assert.deepEqual(splitConversation(CH), { conv: CH });
  assert.deepEqual(splitConversation('a:PERSONAL1'), { conv: 'a:PERSONAL1' });
});

test('the send target rebuilds the chain only for a thread', () => {
  assert.equal(targetId(CH, '100'), `${CH};messageid=100`);
  assert.equal(targetId(CH), CH);
  assert.equal(targetId('a:PERSONAL1'), 'a:PERSONAL1');
});

test('a message that starts its chain has no thread; a reply names the root', () => {
  assert.equal(threadOf(`${CH};messageid=100`, '100'), undefined);
  assert.equal(threadOf(`${CH};messageid=100`, '101'), '100');
  assert.equal(threadOf('a:PERSONAL1', '5'), undefined);
});

test('the key shapes the core builds from Teams ids still parse', () => {
  assert.equal(isThreadKey('thread:1792148920804'), true);
  assert.equal(slugOfBase(`dm:a:PERSONAL1:alpha`), 'alpha');
  assert.deepEqual(splitTeam(`dm:a:PERSONAL1:alpha`), { base: `dm:a:PERSONAL1:alpha` });
});

test('deep links exist for channel messages only', () => {
  assert.equal(deepLink(CH, '100', 't1'), `https://teams.microsoft.com/l/message/${encodeURIComponent(CH)}/100?tenantId=t1`);
  assert.equal(deepLink('a:PERSONAL1', '100', 't1'), undefined);
});
