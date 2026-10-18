import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keygen, nextKeyFile, publicHalves } from './keygen.js';
import { generateKeyFile, type KeyFile } from './seal.js';

test('keygen — writes the key file 0600 and prints public halves only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-keygen-'));
  try {
    const path = join(dir, 'hub-key.json');
    const out = keygen({ path, installation: 'home', rotate: false });
    const file = JSON.parse(readFileSync(path, 'utf8')) as KeyFile;
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.ok(out.includes(file.signing.public) && out.includes(file.encryption.public));
    assert.ok(!out.includes(file.signing.private) && !out.includes(file.encryption.private), 'no private half printed');
    assert.throws(() => keygen({ path, installation: 'home', rotate: false }), /exists already/);
    writeFileSync(path, readFileSync(path), { mode: 0o644 });
    keygen({ path, installation: 'home', rotate: true });
    assert.equal(statSync(path).mode & 0o777, 0o600, 'a rotation keeps the file private');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keygen — refuses the default installation id, and the names every hub reserves', () => {
  assert.throws(() => keygen({ path: '/nonexistent/k.json', installation: 'local', rotate: false }), /INSTALLATION_ID must be set/);
  assert.throws(() => keygen({ path: '/nonexistent/k.json', installation: 'hub', rotate: false }), /INSTALLATION_ID must be set/);
});

test('publicHalves — a `reserved` entry for the hub’s configuration, and the peers’ entry', () => {
  const file = generateKeyFile();
  const out = publicHalves('bluefin', file);
  const blocks = [...out.matchAll(/^\{[\s\S]*?^\}/gm)].map((m) => JSON.parse(m[0]) as unknown);
  assert.deepEqual(blocks, [
    { bluefin: { sign: [{ key: file.signing.public }] } },
    { bluefin: { keys: [{ sign: file.signing.public, box: file.encryption.public }] } },
  ]);
  assert.match(out, /HUB_CONFIG "reserved"/);
});

test('nextKeyFile — a rotation keeps the previous encryption key 14 days and drops expired ones', () => {
  const now = new Date('2026-10-17T00:00:00Z');
  const old = generateKeyFile();
  const withExpired: KeyFile = { ...old, previous: [{ encryption: generateKeyFile().encryption, notAfter: '2026-10-01T00:00:00Z' }] };
  const next = nextKeyFile(withExpired, { rotate: true, now });
  assert.notEqual(next.signing.public, old.signing.public);
  assert.deepEqual(next.previous, [{ encryption: old.encryption, notAfter: '2026-10-31T00:00:00.000Z' }]);
});
