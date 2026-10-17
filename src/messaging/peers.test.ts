import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../state.js';
import { droppedPeers, endTasksWithPeer, loadPeers, parsePeers, peersPath, validKeys } from './peers.js';
import { generateKeyFile } from './seal.js';
import type { InTask, OutTask } from './records.js';

const keyPair = () => {
  const f = generateKeyFile();
  return { sign: f.signing.public, box: f.encryption.public };
};
const k1 = keyPair();
const k2 = keyPair();

test('peersPath — beside the projects configuration', () => {
  assert.equal(peersPath('/srv/coach-aven/projects.config.json'), '/srv/coach-aven/hub.peers.json');
});

test('parsePeers — key lists per peer, as `orch hub keygen` prints them; a rotation keeps the old key until notAfter', () => {
  const peers = parsePeers({ bluefin: { keys: [k1] }, northwind: { keys: [{ ...k1, notAfter: '2026-10-20T00:00:00Z' }, k2] } }, 'hub.peers.json', 'home');
  assert.deepEqual(Object.keys(peers), ['bluefin', 'northwind']);
  assert.deepEqual(validKeys(peers.northwind, new Date('2026-10-17T00:00:00Z')).map((k) => k.box), [k1.box, k2.box]);
  assert.deepEqual(validKeys(peers.northwind, new Date('2026-10-21T00:00:00Z')).map((k) => k.box), [k2.box]);
  assert.deepEqual(validKeys(peers.ghost, new Date()), []);
});

test('parsePeers — a typo fails loudly, naming the peer and field', () => {
  const W = 'hub.peers.json';
  assert.throws(() => parsePeers([], W, 'home'), /must be an object/);
  assert.throws(() => parsePeers({ Bluefin: { keys: [k1] } }, W, 'home'), /"Bluefin" is not an installation id/);
  assert.throws(() => parsePeers({ home: { keys: [k1] } }, W, 'home'), /"home" is this installation/);
  assert.throws(() => parsePeers({ bluefin: { keys: [] } }, W, 'home'), /"bluefin" needs a non-empty "keys" list/);
  assert.throws(() => parsePeers({ bluefin: { keys: [{ sign: k1.sign, box: 'short' }] } }, W, 'home'), /keys\[0\]\.box is not a public key/);
  assert.throws(() => parsePeers({ bluefin: { keys: [{ ...k1, notAfter: 'soon' }] } }, W, 'home'), /notAfter is not a date/);
});

test('loadPeers — no file is no peers; a broken file fails naming the path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aven-peers-'));
  const path = join(dir, 'hub.peers.json');
  assert.deepEqual(loadPeers(path, 'home'), {});
  writeFileSync(path, JSON.stringify({ bluefin: { keys: [k1] } }));
  assert.deepEqual(Object.keys(loadPeers(path, 'home')), ['bluefin']);
  writeFileSync(path, '{ "bluefin": ');
  assert.throws(() => loadPeers(path, 'home'), new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('peer removed by a reload: its open tasks end `failed: peer removed` both ways; others and ended ones stay', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'aven-peers-')), 'state.json'));
  const base = { slug: 'owen-ops', key: 'thread:1.2', reply: { key: 'thread:1.2', driver: 'slack' as const }, question: 'q', depth: 0, rounds: 0, replies: [], seen: [], createdAt: '2026-10-17T08:00:00.000Z', updatedAt: '2026-10-17T08:00:00.000Z' };
  const out = (id: string, target: string, state: OutTask['state'] = 'working'): OutTask => ({ ...base, id: id.repeat(24), target, state });
  store.putOutTask(out('a', 'northwind/ledger'));
  store.putOutTask(out('b', 'northwind/ledger', 'completed'));
  store.putOutTask(out('c', 'bluefin/caldora'));
  const inc: InTask = { id: 'd'.repeat(24), origin: 'northwind', from: 'northwind/ledger', fromDomain: 'northwind', slug: 'caldora', key: `a2a:northwind:${'d'.repeat(24)}:caldora`, question: 'q', state: 'input-required', depth: 0, rounds: 1, seen: [], createdAt: base.createdAt, updatedAt: base.updatedAt };
  store.putInTask(inc);
  assert.deepEqual(droppedPeers({ bluefin: [k1], northwind: [k2] }, { bluefin: [k1] }), ['northwind']);
  const ended = endTasksWithPeer(store, 'northwind', 'peer removed', new Date('2026-10-18T00:00:00.000Z'));
  assert.deepEqual(ended.out.map((t) => t.id), ['a'.repeat(24)]);
  assert.deepEqual(ended.in.map((t) => t.id), ['d'.repeat(24)]);
  assert.equal(store.getOutTask('a'.repeat(24))?.state, 'failed');
  assert.equal(store.getOutTask('a'.repeat(24))?.reason, 'peer removed');
  assert.equal(store.getOutTask('b'.repeat(24))?.state, 'completed', 'an ended task keeps its end');
  assert.equal(store.getOutTask('c'.repeat(24))?.state, 'working', 'another peer’s task is untouched');
  assert.equal(store.getInTask('northwind', 'd'.repeat(24))?.state, 'failed');
});
