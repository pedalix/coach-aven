import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyFile, open, seal, signChallenge, verifyChallenge, type KeyFile, type PeerKey } from './seal.js';
import type { EnvelopeHeader } from './protocol.js';

const header: EnvelopeHeader = { v: 1, id: '5f0c1d2e3a4b59687a6b5c4d', from: 'home/owen-ops', to: 'bluefin/caldora', method: 'ask', task: '0f1e2d3c4b5a69788796a5b4' };
const payload = { domain: 'home', toDomain: 'bluefin', marks: {}, depth: 0, message: { text: 'Which orders failed?' } };
const home = generateKeyFile();
const bluefin = generateKeyFile();
const homeKeys: PeerKey[] = [{ sign: home.signing.public, box: home.encryption.public }];

test('seal / open — round trip; the hub sees only the header', () => {
  const env = seal(header, payload, { signing: home.signing, recipientBox: bluefin.encryption.public });
  assert.ok(!JSON.stringify(env).includes('Which orders failed'), 'the payload is not readable in the envelope');
  const r = open(env, { senderKeys: homeKeys, own: bluefin });
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.payload, payload);
});

test('tampered envelope — an altered ciphertext or sender fails the signature, nothing is decrypted', () => {
  const env = seal(header, payload, { signing: home.signing, recipientBox: bluefin.encryption.public });
  const ct = Buffer.from(env.ct!, 'base64url');
  ct[20] = ct[20]! ^ 1;
  assert.deepEqual(open({ ...env, ct: ct.toString('base64url') }, { senderKeys: homeKeys, own: bluefin }), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(open({ ...env, from: 'home/nora' }, { senderKeys: homeKeys, own: bluefin }), { ok: false, reason: 'bad_signature' });
});

test('wrong sender — signed with another installation’s key: refused', () => {
  const mallory = generateKeyFile();
  const env = seal(header, payload, { signing: mallory.signing, recipientBox: bluefin.encryption.public });
  assert.deepEqual(open(env, { senderKeys: homeKeys, own: bluefin }), { ok: false, reason: 'bad_signature' });
});

test('wrong key — sealed for someone else: does not decrypt', () => {
  const env = seal(header, payload, { signing: home.signing, recipientBox: generateKeyFile().encryption.public });
  assert.deepEqual(open(env, { senderKeys: homeKeys, own: bluefin }), { ok: false, reason: 'decrypt_failed' });
});

test('replayed ciphertext — under a new envelope id it does not open, even re-signed by the sender', () => {
  const env = seal(header, payload, { signing: home.signing, recipientBox: bluefin.encryption.public });
  const moved = { ...env, id: '000000000000000000000001' };
  assert.deepEqual(open(moved, { senderKeys: homeKeys, own: bluefin }), { ok: false, reason: 'bad_signature' });
  // Even a valid signature over the new id cannot open it: the id is in the AAD.
  const { sig: _old, ...unsigned } = moved;
  const resigned = seal({ ...header, id: moved.id }, {}, { signing: home.signing, recipientBox: bluefin.encryption.public });
  const forged = { ...unsigned, sig: resigned.sig };
  assert.equal(open(forged, { senderKeys: homeKeys, own: bluefin }).ok, false);
});

test('rotation grace — the previous encryption key opens until its notAfter; a retired signing key verifies nothing', () => {
  const now = new Date('2026-10-17T12:00:00Z');
  const rotated: KeyFile = { ...generateKeyFile(), previous: [{ encryption: bluefin.encryption, notAfter: '2026-10-31T00:00:00Z' }] };
  const env = seal(header, payload, { signing: home.signing, recipientBox: bluefin.encryption.public });
  assert.equal(open(env, { senderKeys: homeKeys, own: rotated, now }).ok, true, 'within the grace period');
  assert.deepEqual(open(env, { senderKeys: homeKeys, own: rotated, now: new Date('2026-11-01T00:00:00Z') }), { ok: false, reason: 'decrypt_failed' });
  const retired: PeerKey[] = [{ sign: home.signing.public, box: home.encryption.public, notAfter: '2026-10-01T00:00:00Z' }];
  assert.deepEqual(open(env, { senderKeys: retired, own: bluefin, now }), { ok: false, reason: 'bad_signature' });
  const both: PeerKey[] = [{ sign: generateKeyFile().signing.public, box: 'x' }, ...homeKeys];
  assert.equal(open(env, { senderKeys: both, own: bluefin, now }).ok, true, 'keys are tried in order');
});

test('hub challenge — signed with the installation’s key, bound to host, installation and nonce', () => {
  const sig = signChallenge('hub.example', 'home', 'bm9uY2U', home.signing);
  assert.equal(verifyChallenge('hub.example', 'home', 'bm9uY2U', sig, home.signing.public), true);
  assert.equal(verifyChallenge('hub.example', 'home', 'b3RoZXI', sig, home.signing.public), false);
  assert.equal(verifyChallenge('other.example', 'home', 'bm9uY2U', sig, home.signing.public), false);
  assert.equal(verifyChallenge('hub.example', 'bluefin', 'bm9uY2U', sig, home.signing.public), false);
});
