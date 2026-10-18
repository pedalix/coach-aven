import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  accepts,
  challengeText,
  domainClaimOk,
  headerAad,
  isOtherHub,
  joinEnvelope,
  kdfInfo,
  parseAddress,
  parseClientFrame,
  parseHubFrame,
  parsePayload,
  parseSealed,
  parseTarget,
  parseWireEnvelope,
  KEY_RE,
  sealedOf,
  signingText,
  wireHeaderOf,
  type Envelope,
} from './protocol.js';

const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/messaging/envelope.v2.json', import.meta.url), 'utf8')) as {
  envelope: Record<string, unknown>;
  sealed: Record<string, unknown> & { payload: Record<string, unknown> };
};
/** A public key's shape (43 base64url characters, canonical); the value is made up. */
const KEY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopA';

test('targets — <installation>/<agent>, or a bare agent of the own installation; ids validated', () => {
  assert.deepEqual(parseTarget('bluefin/caldora', 'home'), { installation: 'bluefin', agent: 'caldora' });
  assert.deepEqual(parseTarget(' nora ', 'home'), { installation: 'home', agent: 'nora' });
  for (const bad of ['', 'Bluefin/caldora', 'bluefin/', '/caldora', 'blue fin/x', 'a/b/c', 'x'.repeat(33) + '/a', '../etc/passwd', 'bluefin@hub.example.org/caldora']) assert.equal(parseTarget(bad, 'home'), undefined, bad);
  assert.equal(parseAddress('caldora'), undefined, 'an address always names its installation');
});

test('addresses on other hubs — `<name>@<host>` before the first `/` is recognised, to be refused with its own reason', () => {
  assert.equal(isOtherHub('bluefin@hub.example.org/caldora'), true);
  assert.equal(isOtherHub(' bluefin@hub.example.org '), true, 'an installation argument too');
  assert.equal(isOtherHub('bluefin/caldora'), false);
  assert.equal(isOtherHub('caldora'), false);
  assert.equal(isOtherHub('bluefin/caldora@x'), false, 'only the installation part counts');
  assert.equal(isOtherHub(undefined), false);
});

test('accepts — a named agent, a bare own agent, `*` for the own domain only; absent or empty: nobody', () => {
  const own = { ownInstallation: 'bluefin', ownDomain: 'bluefin' };
  const homeOps = { installation: 'home', agent: 'owen-ops' };
  assert.equal(accepts(undefined, homeOps, { ...own, senderDomain: 'home' }), false);
  assert.equal(accepts([], homeOps, { ...own, senderDomain: 'home' }), false);
  assert.equal(accepts(['home/owen-ops'], homeOps, { ...own, senderDomain: 'home' }), true);
  assert.equal(accepts(['owen-ops'], homeOps, { ...own, senderDomain: 'home' }), false, 'a bare name is an agent of the own installation');
  assert.equal(accepts(['nora'], { installation: 'bluefin', agent: 'nora' }, { ...own, senderDomain: 'bluefin' }), true);
  assert.equal(accepts(['*'], homeOps, { ...own, senderDomain: 'home' }), false, '`*` never crosses a domain');
  assert.equal(accepts(['*'], { installation: 'bluefin', agent: 'nora' }, { ...own, senderDomain: 'bluefin~1a2b3c4d' }), false, 'nor a tenant boundary');
  assert.equal(accepts(['*'], { installation: 'bluefin', agent: 'nora' }, { ...own, senderDomain: 'bluefin' }), true);
});

test('domain claims — a sender’s domain must name its authenticated installation', () => {
  assert.equal(domainClaimOk('home', 'home'), true);
  assert.equal(domainClaimOk('home~0a1b2c3d', 'home'), true);
  assert.equal(domainClaimOk('bluefin', 'home'), false);
  assert.equal(domainClaimOk('home~xyz', 'home'), false);
});

test('wire envelope — installations only in clear; fields a newer release adds are ignored, today’s envelope still parses', () => {
  const r = parseWireEnvelope({ ...FIXTURE.envelope, priority: 'high', trace: { a: 1 } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.env, FIXTURE.envelope);
  assert.deepEqual(Object.keys(FIXTURE.envelope).sort(), ['ct', 'eph', 'from', 'id', 'sig', 'to', 'v'], 'no agent, method or task in clear');
});

test('wire envelope — another version is refused with both versions, never guessed at; malformed ones dropped', () => {
  assert.deepEqual(parseWireEnvelope({ ...FIXTURE.envelope, v: 1 }), { ok: false, reason: 'unsupported version', theirs: 1, ours: 2 });
  assert.deepEqual(parseWireEnvelope({ ...FIXTURE.envelope, v: 3 }), { ok: false, reason: 'unsupported version', theirs: 3, ours: 2 });
  assert.deepEqual(parseWireEnvelope({ ...FIXTURE.envelope, v: '2' }), { ok: false, reason: 'malformed' });
  for (const bad of [{ id: 'x' }, { from: 'home/owen-ops' }, { to: 'Bluefin' }, { ct: 7 }, { sig: undefined }, { eph: undefined }]) {
    assert.deepEqual(parseWireEnvelope({ ...FIXTURE.envelope, ...bad }), { ok: false, reason: 'malformed' }, JSON.stringify(bad));
  }
});

test('sealed content — agents, method, task and payload; unknown payload fields ignored, anything else refused', () => {
  const s = parseSealed({ ...FIXTURE.sealed, extra: 1, payload: { ...FIXTURE.sealed.payload, attachments: [], hint: 'x' } });
  assert.deepEqual(s, FIXTURE.sealed, 'unknown fields dropped, known ones kept');
  for (const bad of [{ from: 'home/owen-ops' }, { to: '' }, { method: 'delete' }, { task: 'T'.repeat(24) }, { payload: { ...FIXTURE.sealed.payload, domain: 'Home' } }, { payload: undefined }]) {
    assert.equal(parseSealed({ ...FIXTURE.sealed, ...bad }), undefined, JSON.stringify(bad));
  }
});

test('split and join — a message becomes a clear header and a sealed half, and joins back unchanged', () => {
  const env: Envelope = { v: 2, id: '5f0c1d2e3a4b59687a6b5c4d', from: 'home/owen-ops', to: 'bluefin/caldora', method: 'ask', task: '0f1e2d3c4b5a69788796a5b4' };
  const payload = parsePayload(FIXTURE.sealed.payload)!;
  assert.deepEqual(wireHeaderOf(env), { v: 2, id: env.id, from: 'home', to: 'bluefin' });
  assert.deepEqual(sealedOf(env, payload), FIXTURE.sealed);
  assert.deepEqual(joinEnvelope(wireHeaderOf(env), sealedOf(env, payload)), env);
});

test('payload — domains, marks of domains, depth; anything else refused', () => {
  const base = FIXTURE.sealed.payload;
  for (const bad of [{ domain: 'Home' }, { depth: -1 }, { depth: 1.5 }, { marks: { northwind: 'home' } }, { marks: { 'x y': ['home'] } }, { toDomain: 'bluefin~zz' }, { cost: -1 }]) {
    assert.equal(parsePayload({ ...base, ...bad }), undefined, JSON.stringify(bad));
  }
  assert.deepEqual(parsePayload({ ...base, cost: 0.42 })?.cost, 0.42);
});

test('crypto texts — fixed order; the AAD binds the envelope id, the derivation the keys, the signature eph and ct too', () => {
  const env = parseWireEnvelope(FIXTURE.envelope);
  assert.ok(env.ok);
  if (!env.ok) return;
  assert.equal(headerAad(env.env), JSON.stringify([2, env.env.id, 'home', 'bluefin']));
  assert.notEqual(headerAad(env.env), headerAad({ ...env.env, id: '000000000000000000000001' }));
  assert.notEqual(signingText(env.env), signingText({ ...env.env, ct: 'other' }));
  assert.equal(kdfInfo('ZXBo', 'Ym94'), 'coach-aven-hub/2|ZXBo|Ym94', 'the ephemeral key and the receiver’s encryption key, no names');
  assert.equal(challengeText('hub.example', 'home', KEY, 'n0nce'), `coach-aven-hub/2|hub.example|home|${KEY}|n0nce`);
});

test('keys — only the canonical base64url spelling of 32 bytes: one key cannot pass as several', () => {
  assert.equal(KEY_RE.test(KEY), true);
  const endings = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const accepted = [...endings].filter((c) => KEY_RE.test(KEY.slice(0, 42) + c));
  assert.deepEqual(accepted.join(''), 'AEIMQUYcgkosw048', 'the 43rd character carries 4 bits and 2 zero bits');
  assert.equal(KEY_RE.test(KEY.slice(0, 42) + 'B'), false, 'decodes to the same bytes as …A, so it is refused');
  assert.equal(KEY_RE.test(KEY + 'A'), false);
  assert.equal(parseClientFrame({ t: 'auth', v: 2, name: 'home', key: KEY.slice(0, 42) + 'B', sig: 's' }), undefined);
});

test('frames — `auth` version 2; the version-1 shape is `auth-unsupported`; malformed and unknown frames dropped', () => {
  assert.deepEqual(parseClientFrame({ t: 'auth', v: 2, name: 'home', key: KEY, sig: 's' }), { t: 'auth', v: 2, name: 'home', key: KEY, sig: 's' });
  assert.deepEqual(parseClientFrame({ t: 'auth', installation: 'home', sig: 's' }), { t: 'auth-unsupported', theirs: 1 }, 'version 1 had no `v`');
  assert.deepEqual(parseClientFrame({ t: 'auth', v: 3, name: 'home', key: KEY, sig: 's' }), { t: 'auth-unsupported', theirs: 3 });
  for (const bad of [{ name: 'HOME' }, { name: 'bluefin@hub.example.org' }, { key: 'short' }, { sig: 1 }]) {
    assert.equal(parseClientFrame({ t: 'auth', v: 2, name: 'home', key: KEY, sig: 's', ...bad }), undefined, JSON.stringify(bad));
  }
  assert.deepEqual(parseClientFrame({ t: 'allow', installations: ['northwind', 'bluefin', 'bluefin'] }), { t: 'allow', installations: ['bluefin', 'northwind'] });
  assert.deepEqual(parseClientFrame({ t: 'allow', installations: [] }), { t: 'allow', installations: [] });
  assert.equal(parseClientFrame({ t: 'allow', installations: ['Bluefin'] }), undefined);
  assert.deepEqual(parseClientFrame({ t: 'ack', seq: 3 }), { t: 'ack', seq: 3 });
  assert.equal(parseClientFrame({ t: 'ack', seq: -1 }), undefined);
  assert.deepEqual(parseHubFrame({ t: 'hello', now: 'n', enrolled: ['home'], online: [], removed: [{ installation: 'old', at: 't' }], extra: 1 }), {
    t: 'hello',
    now: 'n',
    online: [],
    removed: [{ installation: 'old', at: 't' }],
  });
  assert.deepEqual(parseHubFrame({ t: 'expired', id: 'i', task: 'k', to: 'bluefin/caldora' }), { t: 'expired', id: 'i' }, 'by envelope id only');
  assert.deepEqual(parseHubFrame({ t: 'presence', online: ['home'] }), { t: 'presence', online: ['home'] });
  assert.equal(parseHubFrame({ t: 'gossip' }), undefined, 'a frame kind this side does not know is ignored');
  assert.equal(parseHubFrame({ t: 'deliver', seq: 1, env: 'x' }), undefined);
});
