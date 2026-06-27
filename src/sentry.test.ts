import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubText, scrubEvent } from './sentry.js';

test('scrubText redacts GitHub/Slack tokens, JWTs, API keys; leaves plain text', () => {
  assert.equal(scrubText(`use ghp_${'A'.repeat(36)} now`), 'use [redacted] now');
  assert.equal(scrubText('bot xoxb-0123456789abcd here'), 'bot [redacted] here');
  assert.equal(scrubText(`key sk-${'b'.repeat(24)}!`), 'key [redacted]!');
  assert.equal(scrubText('jwt eyJABCDEFGHIJ.KLMNOPQRST.UVWXYZ0123 ok'), 'jwt [redacted] ok');
  assert.equal(scrubText('nothing secret here'), 'nothing secret here');
});

test('scrubEvent redacts the message and exception values in place', () => {
  const event = {
    message: `boom ghp_${'C'.repeat(40)}`,
    exception: { values: [{ value: `failed with xoxb-9876543210abcd` }] },
  };
  const out = scrubEvent(event);
  assert.equal(out.message, 'boom [redacted]');
  assert.equal(out.exception.values[0].value, 'failed with [redacted]');
});
