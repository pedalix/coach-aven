import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buttonSig, signButtons, verifyButton } from './buttons.js';
import { h } from './webformat.js';

const SECRET = 's'.repeat(32);
const btn = (action: string, value: string) => h`<button type="button" class="btn" data-action="${action}" data-value="${value}">Go</button>`.html;

test('signButtons: every button gets the signature of its unescaped action and value; nothing else changes', () => {
  const html = `<p>x</p>${btn('cancel_turn', 't1-2')}${btn('session_restart', 'web:room:alpha:"m1"&<b>')}`;
  const out = signButtons(SECRET, html);
  assert.equal(out.match(/data-sig="/g)?.length, 2);
  assert.ok(out.includes(`data-value="t1-2" data-sig="${buttonSig(SECRET, 'cancel_turn', 't1-2')}"`));
  assert.ok(out.includes(`data-sig="${buttonSig(SECRET, 'session_restart', 'web:room:alpha:"m1"&<b>')}"`), 'computed over what getAttribute returns');
  assert.equal(out.replace(/ data-sig="[^"]*"/g, ''), html);
});

test('verifyButton: the rendered pair passes; another value, another action, another secret or no signature does not', () => {
  const sig = buttonSig(SECRET, 'cancel_turn', 't1-2');
  assert.ok(verifyButton(SECRET, 'cancel_turn', 't1-2', sig));
  assert.ok(!verifyButton(SECRET, 'cancel_turn', 't1-3', sig), 'an enumerated turn id');
  assert.ok(!verifyButton(SECRET, 'session_restart', 't1-2', sig));
  assert.ok(!verifyButton('o'.repeat(32), 'cancel_turn', 't1-2', sig));
  for (const bad of [undefined, '', 7, `${sig}x`, sig.slice(1)]) assert.ok(!verifyButton(SECRET, 'cancel_turn', 't1-2', bad), String(bad));
});
