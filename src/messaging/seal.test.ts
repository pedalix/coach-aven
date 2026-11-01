import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, sign } from 'node:crypto';
import { generateKeyFile, open, seal, signChallenge, verifyChallenge, type KeyFile, type PeerKey } from './seal.js';
import { signingText, type Sealed, type WireEnvelope, type WireHeader } from './protocol.js';

const header: WireHeader = { v: 2, id: '5f0c1d2e3a4b59687a6b5c4d', from: 'home', to: 'bluefin' };
const content: Sealed = {
  from: 'owen-ops',
  to: 'caldora',
  method: 'ask',
  task: '0f1e2d3c4b5a69788796a5b4',
  payload: { domain: 'home', toDomain: 'bluefin', marks: {}, depth: 0, message: { text: 'Which orders failed?' } },
};
const home = generateKeyFile();
const bluefin = generateKeyFile();
const homeKeys: PeerKey[] = [{ sign: home.signing.public, box: home.encryption.public }];
/** A valid signature by `k` over `env` as it now reads: what a sender could forge with its own key. */
const resign = (env: WireEnvelope, k: KeyFile): WireEnvelope => {
  const { sig: _old, ...unsigned } = env;
  const key = createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', x: k.signing.public, d: k.signing.private }, format: 'jwk' });
  return { ...unsigned, sig: sign(null, Buffer.from(signingText(unsigned)), key).toString('base64url') };
};

test('seal / open — round trip; the wire shows the installations and nothing else', () => {
  const env = seal(header, content, { signing: home.signing, recipientBox: bluefin.encryption.public });
  const wire = JSON.stringify(env);
  // The kind as a JSON string: a bare `ask` turns up by chance in base64url ciphertext about once in a few hundred runs.
  for (const hidden of ['Which orders failed', 'owen-ops', 'caldora', '"ask"', content.task]) assert.ok(!wire.includes(hidden), `${hidden} is sealed`);
  assert.deepEqual(Object.keys(env).sort(), ['ct', 'eph', 'from', 'id', 'sig', 'to', 'v']);
  const r = open(env, { senderKeys: homeKeys, own: bluefin });
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.content, content);
});

test('tampered envelope — an altered ciphertext or sender fails the signature, nothing is decrypted', () => {
  const env = seal(header, content, { signing: home.signing, recipientBox: bluefin.encryption.public });
  const ct = Buffer.from(env.ct, 'base64url');
  ct[20] = ct[20]! ^ 1;
  assert.deepEqual(open({ ...env, ct: ct.toString('base64url') }, { senderKeys: homeKeys, own: bluefin }), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(open({ ...env, from: 'northwind' }, { senderKeys: homeKeys, own: bluefin }), { ok: false, reason: 'bad_signature' });
});

test('re-targeted envelope — moved to another installation in clear, it fails the signature; validly re-signed, it does not decrypt (the AAD binds `to`)', () => {
  const env = seal(header, content, { signing: home.signing, recipientBox: bluefin.encryption.public });
  assert.deepEqual(open({ ...env, to: 'northwind' }, { senderKeys: homeKeys, own: bluefin }), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(open(resign({ ...env, to: 'northwind' }, home), { senderKeys: homeKeys, own: bluefin }), { ok: false, reason: 'decrypt_failed' });
});

test('wrong sender — signed with another installation’s key: refused', () => {
  const mallory = generateKeyFile();
  const env = seal(header, content, { signing: mallory.signing, recipientBox: bluefin.encryption.public });
  assert.deepEqual(open(env, { senderKeys: homeKeys, own: bluefin }), { ok: false, reason: 'bad_signature' });
});

test('name taken over — the name `home` released and claimed by another key: its envelopes fail the pin, and it cannot open what was sealed to the earlier key', () => {
  const newOwner = generateKeyFile();
  const forged = seal(header, content, { signing: newOwner.signing, recipientBox: bluefin.encryption.public });
  assert.deepEqual(open(forged, { senderKeys: homeKeys, own: bluefin }), { ok: false, reason: 'bad_signature' }, 'the pin is the earlier key');
  const toEarlier = seal({ ...header, from: 'bluefin', to: 'home' }, content, { signing: bluefin.signing, recipientBox: home.encryption.public });
  const bluefinKeys: PeerKey[] = [{ sign: bluefin.signing.public, box: bluefin.encryption.public }];
  assert.deepEqual(open(toEarlier, { senderKeys: bluefinKeys, own: newOwner }), { ok: false, reason: 'decrypt_failed' });
});

test('wrong key — sealed for someone else: does not decrypt', () => {
  const env = seal(header, content, { signing: home.signing, recipientBox: generateKeyFile().encryption.public });
  assert.deepEqual(open(env, { senderKeys: homeKeys, own: bluefin }), { ok: false, reason: 'decrypt_failed' });
});

test('replayed ciphertext — under a new envelope id it does not open, even re-signed by the sender', () => {
  const env = seal(header, content, { signing: home.signing, recipientBox: bluefin.encryption.public });
  const moved = { ...env, id: '000000000000000000000001' };
  assert.deepEqual(open(moved, { senderKeys: homeKeys, own: bluefin }), { ok: false, reason: 'bad_signature' });
  // Even a valid signature over the new id cannot open it: the id is in the AAD.
  assert.deepEqual(open(resign(moved, home), { senderKeys: homeKeys, own: bluefin }), { ok: false, reason: 'decrypt_failed' });
});

test('rotation grace — the previous encryption key opens until its notAfter; a retired signing key verifies nothing', () => {
  const now = new Date('2026-10-17T12:00:00Z');
  const rotated: KeyFile = { ...generateKeyFile(), previous: [{ encryption: bluefin.encryption, notAfter: '2026-10-31T00:00:00Z' }] };
  const env = seal(header, content, { signing: home.signing, recipientBox: bluefin.encryption.public });
  assert.equal(open(env, { senderKeys: homeKeys, own: rotated, now }).ok, true, 'within the grace period');
  assert.deepEqual(open(env, { senderKeys: homeKeys, own: rotated, now: new Date('2026-11-01T00:00:00Z') }), { ok: false, reason: 'decrypt_failed' });
  const retired: PeerKey[] = [{ sign: home.signing.public, box: home.encryption.public, notAfter: '2026-10-01T00:00:00Z' }];
  assert.deepEqual(open(env, { senderKeys: retired, own: bluefin, now }), { ok: false, reason: 'bad_signature' });
  const both: PeerKey[] = [{ sign: generateKeyFile().signing.public, box: 'x' }, ...homeKeys];
  assert.equal(open(env, { senderKeys: both, own: bluefin, now }).ok, true, 'keys are tried in order');
});

test('hub challenge — signed with the installation’s key, bound to host, name, that key and nonce', () => {
  const sig = signChallenge('hub.example', 'home', 'bm9uY2U', home.signing);
  assert.equal(verifyChallenge('hub.example', 'home', 'bm9uY2U', sig, home.signing.public), true);
  assert.equal(verifyChallenge('hub.example', 'home', 'b3RoZXI', sig, home.signing.public), false);
  assert.equal(verifyChallenge('other.example', 'home', 'bm9uY2U', sig, home.signing.public), false);
  assert.equal(verifyChallenge('hub.example', 'bluefin', 'bm9uY2U', sig, home.signing.public), false);
  assert.equal(verifyChallenge('hub.example', 'home', 'bm9uY2U', sig, bluefin.signing.public), false, 'another key cannot claim the signature');
});
