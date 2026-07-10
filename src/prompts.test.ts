import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEffort, reviewPrompt, reportDraftPrompt, reportDeliveryContract } from './prompts.js';

test('parseEffort — accepts low/med/medium/high (case-insensitive), rejects the rest', () => {
  assert.equal(parseEffort('low'), 'low');
  assert.equal(parseEffort('LOW'), 'low');
  assert.equal(parseEffort('med'), 'med');
  assert.equal(parseEffort('medium'), 'med');
  assert.equal(parseEffort('high'), 'high');
  assert.equal(parseEffort('15'), undefined); // a PR number, not an effort
  assert.equal(parseEffort('caldora-admin'), undefined); // a repo name
  assert.equal(parseEffort(undefined), undefined);
});

test('reviewPrompt — effort tunes cap and precision/recall bias; always read-only', () => {
  const low = reviewPrompt('o/r', 1, 'low');
  const med = reviewPrompt('o/r', 1, 'med');
  const high = reviewPrompt('o/r', 1, 'high');

  for (const p of [low, med, high]) {
    assert.match(p, /Read-only PR review/);
    assert.match(p, /do NOT push/i);
    assert.match(p, /concrete failure scenario/i); // the verify discipline
  }
  assert.match(low, /cap 4/);
  assert.match(med, /cap 8/);
  assert.match(high, /cap 10/);
  assert.match(med, /PRECISION/);
  assert.match(high, /RECALL/);
  assert.equal(reviewPrompt('o/r', 1), med); // default effort is med
});

test('report prompt split — delivery rules live ONLY in the contract, not the editable part', () => {
  const draft = reportDraftPrompt('CB-250');
  const contract = reportDeliveryContract('CB-250');

  // The contract must survive the editable instructions being replaced wholesale: it carries
  // the verbatim-posting warning, the don't-post-it-yourself rule, and the size cap.
  assert.match(contract, /CB-250/);
  assert.match(contract, /VERBATIM/);
  assert.match(contract, /Do NOT try to post it yourself/);
  assert.match(contract, /ONLY the comment text/);
  assert.match(contract, /2500 characters/);

  // The editable part is content guidance only — if a delivery rule sneaks back in here,
  // it's dead weight (users delete this text) and drifts from the contract copy.
  assert.match(draft, /SUPPORT TEAM/);
  assert.doesNotMatch(draft, /verbatim/i);
  assert.doesNotMatch(draft, /2500/);
});
