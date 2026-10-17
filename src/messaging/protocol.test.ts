import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  accepts,
  challengeText,
  domainClaimOk,
  headerAad,
  parseAddress,
  parseClientFrame,
  parseEnvelope,
  parseHubFrame,
  parsePayload,
  parseTarget,
  signingText,
} from './protocol.js';

const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/messaging/envelope.v1.json', import.meta.url), 'utf8')) as { envelope: Record<string, unknown>; payload: Record<string, unknown> };

test('targets — <installation>/<agent>, or a bare agent of the own installation; ids validated', () => {
  assert.deepEqual(parseTarget('bluefin/caldora', 'home'), { installation: 'bluefin', agent: 'caldora' });
  assert.deepEqual(parseTarget(' nora ', 'home'), { installation: 'home', agent: 'nora' });
  for (const bad of ['', 'Bluefin/caldora', 'bluefin/', '/caldora', 'blue fin/x', 'a/b/c', 'x'.repeat(33) + '/a', '../etc/passwd']) assert.equal(parseTarget(bad, 'home'), undefined, bad);
  assert.equal(parseAddress('caldora'), undefined, 'an address always names its installation');
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

test('envelope — prod on the last tag: fields a newer release adds are ignored, today’s envelope still parses', () => {
  const r = parseEnvelope({ ...FIXTURE.envelope, priority: 'high', trace: { a: 1 } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.env, FIXTURE.envelope);
  const p = parsePayload({ ...FIXTURE.payload, attachments: [], hint: 'x' });
  assert.ok(p);
  assert.deepEqual(p, FIXTURE.payload, 'unknown payload fields dropped, known ones kept');
});

test('envelope — unknown version: refused with both versions, never guessed at', () => {
  assert.deepEqual(parseEnvelope({ ...FIXTURE.envelope, v: 2 }), { ok: false, reason: 'unsupported version', theirs: 2, ours: 1 });
  assert.deepEqual(parseEnvelope({ ...FIXTURE.envelope, v: '1' }), { ok: false, reason: 'malformed' });
  for (const bad of [{ id: 'x' }, { from: 'home' }, { method: 'delete' }, { task: 'T'.repeat(24) }, { ct: 7 }]) {
    assert.deepEqual(parseEnvelope({ ...FIXTURE.envelope, ...bad }), { ok: false, reason: 'malformed' }, JSON.stringify(bad));
  }
});

test('payload — domains, marks of domains, depth; anything else refused', () => {
  for (const bad of [{ domain: 'Home' }, { depth: -1 }, { depth: 1.5 }, { marks: { northwind: 'home' } }, { marks: { 'x y': ['home'] } }, { toDomain: 'bluefin~zz' }, { cost: -1 }]) {
    assert.equal(parsePayload({ ...FIXTURE.payload, ...bad }), undefined, JSON.stringify(bad));
  }
  assert.deepEqual(parsePayload({ ...FIXTURE.payload, cost: 0.42 })?.cost, 0.42);
});

test('crypto texts — fixed order; the AAD binds the envelope id, the signature eph and ct too', () => {
  const env = parseEnvelope(FIXTURE.envelope);
  assert.ok(env.ok);
  if (!env.ok) return;
  assert.equal(headerAad(env.env), JSON.stringify([1, env.env.id, 'home/owen-ops', 'bluefin/caldora', 'ask', env.env.task]));
  assert.notEqual(headerAad(env.env), headerAad({ ...env.env, id: '000000000000000000000001' }));
  assert.notEqual(signingText(env.env), signingText({ ...env.env, ct: 'other' }));
  assert.equal(challengeText('hub.example', 'home', 'n0nce'), 'coach-aven-hub/1|hub.example|home|n0nce');
});

test('frames — known kinds parsed, malformed and unknown ones dropped', () => {
  assert.deepEqual(parseClientFrame({ t: 'auth', installation: 'home', sig: 's' }), { t: 'auth', installation: 'home', sig: 's' });
  assert.equal(parseClientFrame({ t: 'auth', installation: 'HOME', sig: 's' }), undefined);
  assert.deepEqual(parseClientFrame({ t: 'ack', seq: 3 }), { t: 'ack', seq: 3 });
  assert.equal(parseClientFrame({ t: 'ack', seq: -1 }), undefined);
  assert.deepEqual(parseHubFrame({ t: 'hello', now: 'n', enrolled: ['home'], online: [], removed: [{ installation: 'old', at: 't' }], extra: 1 }), {
    t: 'hello',
    now: 'n',
    enrolled: ['home'],
    online: [],
    removed: [{ installation: 'old', at: 't' }],
  });
  assert.deepEqual(parseHubFrame({ t: 'expired', id: 'i', task: 'k', to: 'bluefin/caldora' }), { t: 'expired', id: 'i', task: 'k', to: 'bluefin/caldora' });
  assert.deepEqual(parseHubFrame({ t: 'presence', online: ['home'] }), { t: 'presence', online: ['home'] });
  assert.equal(parseHubFrame({ t: 'gossip' }), undefined, 'a frame kind this side does not know is ignored');
  assert.equal(parseHubFrame({ t: 'deliver', seq: 1, env: 'x' }), undefined);
});
