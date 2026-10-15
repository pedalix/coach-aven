import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOLD_CONF, SIBLING_CONF, STRUCTURAL, trust, type TrustIn } from './trust.js';

const base: TrustIn = { label: 'acme/shop', conf: 0.97, rung: 'key:AC', siblings: ['acme/erp-sync', 'acme/app'], own: [], sib: new Map(), earned: false };

test('the structural rungs are key, rule, channel, exclusive marker and title', () => {
  for (const r of ['key:VN', 'rule:r-ext', 'channel:C0123456', 'excl:ana-berg', 'title:erp']) assert.ok(STRUCTURAL.test(r), r);
  for (const r of ['repo:agency/shop', 'admin', 'sender:bulk', 'host:x.example', 'closed:#alerts', 'abstain']) assert.ok(!STRUCTURAL.test(r), r);
});

test('no siblings: the route is the initiative, nothing changes', () => {
  assert.deepEqual(trust({ ...base, siblings: [] }), { label: 'acme/shop', conf: 0.97, rung: 'key:AC', branch: 'alone', why: '' });
});

test('an own cue and no sibling cue keeps X at the rung confidence (and its rung instance)', () => {
  const t = trust({ ...base, own: ['checkout'] });
  assert.deepEqual([t.label, t.conf, t.rung, t.branch], ['acme/shop', 0.97, 'key:AC', 'own-cue']);
});

test('an earned answer-built key keeps X at the rung confidence, cues or not', () => {
  const t = trust({ ...base, sib: new Map([['acme/erp-sync', ['sync']]]), earned: true });
  assert.deepEqual([t.label, t.conf, t.rung, t.branch], ['acme/shop', 0.97, 'key:AC', 'earned']);
});

test('a sibling-only cue makes the sibling a .60 guess (the most cued sibling, ties in registry order)', () => {
  const t = trust({ ...base, sib: new Map([['acme/erp-sync', ['sync']], ['acme/app', ['ios', 'android']]]) });
  assert.deepEqual([t.label, t.conf, t.rung, t.branch], ['acme/app', SIBLING_CONF, 'sib:key:AC', 'sibling-cue']);
  const tie = trust({ ...base, sib: new Map([['acme/erp-sync', ['sync']], ['acme/app', ['ios']]]) });
  assert.equal(tie.label, 'acme/erp-sync');
});

test('no cue, or cues of both: X held at .85 — a confirm question — and never above a demoted rung', () => {
  const none = trust(base);
  assert.deepEqual([none.label, none.conf, none.rung, none.branch], ['acme/shop', HOLD_CONF, 'held:key:AC', 'held']);
  const both = trust({ ...base, own: ['shop'], sib: new Map([['acme/erp-sync', ['sync']]]) });
  assert.deepEqual([both.label, both.conf, both.branch], ['acme/shop', HOLD_CONF, 'held']);
  const demoted = trust({ ...base, conf: 0.8 });
  assert.equal(demoted.conf, 0.8, 'a calibration-demoted instance is not raised to .85');
  const own = trust({ ...base, conf: 0.92, own: ['checkout'] });
  assert.deepEqual([own.conf, own.branch], [0.92, 'own-cue'], 'an own cue keeps the demoted confidence: still a question');
});
