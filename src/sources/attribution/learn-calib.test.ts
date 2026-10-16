// Rung-instance calibration (learn-calib.ts): Beta(20c, 20(1−c)), one count per answer id, AND within an answer, two levels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Calibration, posterior } from './learn-calib.js';

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test('the prior is the graded conf; one contradiction demotes even a .99 route, confirmations restore it', () => {
  near(posterior(0.97, 0, 0), 0.97);
  near(posterior(0.99, 0, 1), 19.8 / 21);
  assert.ok(posterior(0.99, 0, 1) < 0.95);
  assert.ok(posterior(0.99, 3, 1) >= 0.95);
  near(posterior(0.8, 20, 0), 36 / 40);
});

test('rows of one answer under one instance are one observation, right only if all were; counted once', () => {
  const c = new Calibration();
  c.apply([
    { instance: 'key:AC', answer: 'q1', ok: true, clientOk: true },
    { instance: 'key:AC', answer: 'q1', ok: false, clientOk: true },
    { instance: 'key:AC', answer: 'q2', ok: true, clientOk: true },
    { instance: 'rule:r-acme', answer: 'q1', ok: true, clientOk: true },
  ]);
  assert.deepEqual(c.stat('key:AC'), { right: 1, wrong: 1, clientRight: 2, clientWrong: 0 });
  c.apply([{ instance: 'key:AC', answer: 'q2', ok: false, clientOk: false }]);
  assert.deepEqual(c.stat('key:AC'), { right: 1, wrong: 1, clientRight: 2, clientWrong: 0 }, 'an answer counted once is never counted again');
  near(c.mean('key:AC', 0.98), (19.6 + 1) / 22);
  near(c.clientMean('key:AC', 0.98), (19.6 + 2) / 22);
  assert.equal(c.mean('channel:C0NONE0001', 0.95), 0.95);
});
