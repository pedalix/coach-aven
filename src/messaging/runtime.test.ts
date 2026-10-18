// The composition roots' half (runtime.ts) as far as the hub needs it: `/aven reload` re-reads
// hub.peers.json, and the hub client sends the new pins as its allow list (OpenSpec `hub-open-network`,
// "Pinned peers are the installation's allow list at the hub").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../state.js';
import type { Config } from '../config.js';
import type { RegistryRef } from '../projects.js';
import type { TurnEngine } from '../turn.js';
import type { HubSocket } from './hubclient.js';
import { messagingRuntime } from './runtime.js';
import { generateKeyFile, type KeyFile } from './seal.js';

const flush = () => new Promise((r) => setImmediate(r));

class FakeConn implements HubSocket {
  sent: Record<string, unknown>[] = [];
  private l: Record<string, ((ev: { data?: unknown; code?: number; reason?: string }) => void)[]> = {};
  addEventListener(type: string, fn: (ev: { data?: unknown; code?: number; reason?: string }) => void): void {
    (this.l[type] ??= []).push(fn);
  }
  send(data: string): void {
    if (data !== 'ping') this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {}
  push(frame: unknown): void {
    for (const fn of this.l.message ?? []) fn({ data: JSON.stringify(frame) });
  }
}

const peerEntry = (k: KeyFile) => ({ keys: [{ sign: k.signing.public, box: k.encryption.public }] });

test('Peer pinned on reload: `/aven reload` re-reads hub.peers.json and the hub client sends the new allow list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aven-runtime-'));
  const keyPath = join(dir, 'hub-key.json');
  writeFileSync(keyPath, JSON.stringify(generateKeyFile()));
  const projectsConfigPath = join(dir, 'projects.config.json');
  writeFileSync(join(dir, 'hub.peers.json'), JSON.stringify({ northwind: peerEntry(generateKeyFile()) }));
  const conns: FakeConn[] = [];
  const cfg = { projectsConfigPath, messaging: { installation: 'bluefin', hub: { url: 'wss://hub.example', keyPath } } } as unknown as Config;
  const rt = messagingRuntime({
    cfg,
    store: new Store(join(dir, 'state.json')),
    reg: { current: { projects: [] } } as unknown as RegistryRef,
    home: () => undefined,
    platform: 'slack',
    shadowDir: join(dir, 'shadow'),
    socket: (url) => {
      assert.equal(url, 'wss://hub.example/connect?as=bluefin');
      const c = new FakeConn();
      conns.push(c);
      setImmediate(() => c.push({ t: 'challenge', nonce: 'n', now: new Date().toISOString() }));
      return c;
    },
  });
  try {
    rt.start({ engine: {} as unknown as TurnEngine, driverFor: () => undefined as never });
    await flush();
    const c = conns[0]!;
    assert.equal(c.sent[0]?.t, 'auth');
    c.push({ t: 'hello', now: new Date().toISOString(), online: [], removed: [] });
    await flush();
    assert.deepEqual(c.sent.filter((f) => f.t === 'allow'), [{ t: 'allow', installations: ['northwind'] }]);
    writeFileSync(join(dir, 'hub.peers.json'), JSON.stringify({ northwind: peerEntry(generateKeyFile()), home: peerEntry(generateKeyFile()) }));
    rt.reload();
    assert.deepEqual(c.sent.filter((f) => f.t === 'allow').at(-1), { t: 'allow', installations: ['home', 'northwind'] });
    rt.reload(); // nothing changed: nothing sent
    assert.equal(c.sent.filter((f) => f.t === 'allow').length, 2);
  } finally {
    rt.stop();
  }
});
