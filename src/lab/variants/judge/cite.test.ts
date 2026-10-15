import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCite, cuesOf, readCite } from './cite.js';

// A fictional case: a call about the Acme web shop with a Globex person on it.
const fields = {
  title: 'Weekly sync — Acme Shop checkout',
  text: 'Checkout   fails on the Züri promo page\nWe agreed to ship the WEB-12 fix on Friday',
  participants: 'Mara Quill (acme; narrow: acme/web)',
  coactivity: '09:10–10:00 acme-shop → acme/web',
  precedent: '[acme/web] (2026-01-05) Acme Shop launch — the promo banner is live',
};
const ctx = (extra: Partial<Parameters<typeof checkCite>[1]> = {}) => ({ fields, labelTokens: ['acme', 'shop', 'WEB', '#acme-web'], markerNames: ['Mara Quill'], ...extra });

test('grounded: the span sits in the named field and names a registry token of the label', () => {
  const v = checkCite({ field: 'title', span: 'Acme Shop checkout' }, ctx());
  assert.equal(v.grounded, true);
  assert.match(v.why, /^token /);
});

test('case, accents and whitespace do not matter; a key prefix inside a key counts as a word', () => {
  assert.equal(checkCite({ field: 'text', span: 'checkout FAILS on the zuri promo' }, ctx({ labelTokens: ['zuri'] })).grounded, true);
  assert.equal(checkCite({ field: 'text', span: 'ship the web-12 fix' }, ctx()).grounded, true);
});

test('a span the card does not contain is never grounded, whatever it names', () => {
  const v = checkCite({ field: 'text', span: 'Acme Shop is down' }, ctx());
  assert.deepEqual(v, { grounded: false, why: 'not in text' });
  // the right words in the wrong field
  assert.equal(checkCite({ field: 'participants', span: 'Acme Shop checkout' }, ctx()).grounded, false);
});

test('a real quote that supports nothing is a quote, not a reason', () => {
  assert.deepEqual(checkCite({ field: 'text', span: 'on Friday' }, ctx()), { grounded: false, why: 'no support' });
});

test('a marker person of the label grounds it; a precedent token only from the precedent field', () => {
  assert.match(checkCite({ field: 'participants', span: 'Mara Quill' }, ctx({ labelTokens: [] })).why, /^person /);
  const prec = ctx({ labelTokens: [], markerNames: [], precedentTokens: ['banner'] });
  assert.equal(checkCite({ field: 'precedent', span: 'the promo banner is live' }, prec).grounded, true);
  assert.equal(checkCite({ field: 'text', span: 'promo page' }, prec).grounded, false);
});

test('no field: the span may sit anywhere; an unknown field matches nothing; overlong spans are refused', () => {
  assert.equal(checkCite({ field: '', span: 'acme-shop → acme/web' }, ctx()).grounded, true);
  assert.equal(checkCite({ field: 'summary', span: 'Acme Shop checkout' }, ctx()).grounded, false);
  assert.equal(checkCite({ field: 'text', span: 'x'.repeat(200) }, ctx()).why, 'span too long');
  assert.equal(checkCite(null, ctx()).why, 'no cite');
});

test('T4: a cue of the claimed kind grounds it; info and noise have no cue', () => {
  const t4 = { fields: { text: 'Kannst du bitte den Export prüfen? Der Shop ist down' }, labelTokens: [], markerNames: [] };
  assert.equal(checkCite({ field: 'text', span: 'Kannst du bitte den Export prüfen?' }, { ...t4, kind: 'question' }).grounded, true);
  assert.equal(checkCite({ field: 'text', span: 'Kannst du bitte den Export' }, { ...t4, kind: 'request' }).grounded, true);
  assert.equal(checkCite({ field: 'text', span: 'Der Shop ist down' }, { ...t4, kind: 'incident' }).grounded, true);
  assert.equal(checkCite({ field: 'text', span: 'Der Shop ist down' }, { ...t4, kind: 'question' }).grounded, false);
  assert.equal(checkCite({ field: 'text', span: 'Der Shop ist down' }, { ...t4, kind: 'info' }).grounded, false);
});

test('cuesOf: EN/DE/RU/IT lexicon, whole words', () => {
  assert.deepEqual(cuesOf('Could you send it?'), ['Q', 'R']);
  assert.deepEqual(cuesOf('сделаю завтра'), ['C']);
  assert.deepEqual(cuesOf('il server non funziona'), ['I']);
  assert.deepEqual(cuesOf('download finished'), []); // "down" inside a word is not a cue
});

test('readCite accepts {field, span} and a bare string', () => {
  assert.deepEqual(readCite({ field: 'Title', span: ' Acme ' }), { field: 'title', span: 'Acme' });
  assert.deepEqual(readCite('Acme'), { field: '', span: 'Acme' });
  assert.equal(readCite({ field: 'text' }), null);
  assert.equal(readCite(42), null);
});
