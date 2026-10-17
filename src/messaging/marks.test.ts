import { test } from 'node:test';
import assert from 'node:assert/strict';
import { domainOf, heldWhy, markArrival, markSent, mayGo } from './marks.js';

// Domains of the examples: two installations, and a client tenant on bluefin.
const HOME = 'home';
const BLUEFIN = 'bluefin';
const NORTHWIND = 'northwind';

test('domainOf — the home tenant is the installation; another tenant gets a tag that never shows its id', () => {
  assert.equal(domainOf('bluefin', undefined), 'bluefin');
  const client = domainOf('bluefin', 'T0CLIENT01');
  assert.match(client, /^bluefin~[0-9a-f]{8}$/);
  assert.equal(client.includes('T0CLIENT01'), false);
  assert.notEqual(domainOf('bluefin', 'T0CLIENT02'), client, 'two tenants, two domains');
});

test('forwarding waits for a person: a thread with bluefin’s answer may not send to northwind; it may send to bluefin and to its own domain', () => {
  const marks = markArrival({}, { own: HOME, from: BLUEFIN, carried: {} });
  assert.deepEqual(marks, { bluefin: ['bluefin'] });
  assert.deepEqual(mayGo(marks, { own: HOME, to: NORTHWIND }), { go: false, blocking: ['bluefin'] });
  assert.deepEqual(mayGo(marks, { own: HOME, to: BLUEFIN }), { go: true }, 'the source has its own data');
  assert.deepEqual(mayGo(marks, { own: HOME, to: HOME }), { go: true }, 'the own domain: the message carries the marks');
  assert.deepEqual(mayGo({}, { own: HOME, to: NORTHWIND }), { go: true }, 'an unmarked thread is unaffected');
});

test('second message to the same domain: after a person released one to northwind, the next goes out without a Send', () => {
  const marks = markSent(markArrival({}, { own: HOME, from: BLUEFIN, carried: {} }), NORTHWIND);
  assert.deepEqual(marks, { bluefin: ['bluefin', 'northwind'] });
  assert.deepEqual(mayGo(marks, { own: HOME, to: NORTHWIND }), { go: true });
});

test('a released message can be answered: northwind’s conversation got home’s marks with home and itself as holders, so its answer to home passes', () => {
  const carried = markSent(markArrival({}, { own: HOME, from: BLUEFIN, carried: {} }), NORTHWIND); // what home’s message carried
  const northwindConv = markArrival({}, { own: NORTHWIND, from: HOME, carried });
  assert.deepEqual(northwindConv, { home: ['home'], bluefin: ['bluefin', 'home', 'northwind'] });
  assert.deepEqual(mayGo(northwindConv, { own: NORTHWIND, to: HOME }), { go: true });
  assert.deepEqual(mayGo(northwindConv, { own: NORTHWIND, to: BLUEFIN }), { go: false, blocking: ['home'] }, 'but not to bluefin: home’s data is not bluefin’s');
});

test('two clients in one installation: an answer from one client tenant on bluefin holds a message to another client tenant there', () => {
  const clientA = domainOf(BLUEFIN, 'T0CLIENTA1');
  const clientB = domainOf(BLUEFIN, 'T0CLIENTB1');
  const marks = markArrival({}, { own: HOME, from: clientA, carried: {} });
  assert.equal(mayGo(marks, { own: HOME, to: clientB }).go, false);
});

test('no laundering through a local agent: a hop inside the own domain carries the mark, and the hop’s send to northwind is refused', () => {
  const owenOps = markArrival({}, { own: HOME, from: BLUEFIN, carried: {} });
  const localShadow = markArrival({}, { own: HOME, from: HOME, carried: owenOps }); // owen-ops asks an agent of its own domain
  assert.deepEqual(localShadow, { bluefin: ['bluefin', 'home'] }, 'the own domain adds only what the message carries');
  assert.equal(mayGo(localShadow, { own: HOME, to: NORTHWIND }).go, false);
});

test('a target whose domain is not known yet has nothing: held in a marked thread, free in an unmarked one', () => {
  const marks = markArrival({}, { own: HOME, from: BLUEFIN, carried: {} });
  assert.deepEqual(mayGo(marks, { own: HOME, to: undefined }), { go: false, blocking: ['bluefin'] });
  assert.deepEqual(mayGo({}, { own: HOME, to: undefined }), { go: true });
});

test('heldWhy — the reason in words', () => {
  assert.equal(heldWhy(['bluefin'], 'northwind'), 'this conversation holds data from bluefin, and northwind does not have it');
  assert.equal(heldWhy(['bluefin', 'northwind'], undefined), 'this conversation holds data from bluefin, northwind, and the target is an agent whose domain is not known yet');
});
