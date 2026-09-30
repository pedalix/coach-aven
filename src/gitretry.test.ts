import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTransientGitFailure, withGitRetry } from './gitretry.js';

const execError = (output: string) => new Error(`command failed (exit 128): git fetch --all --prune\n--- output ---\n${output}`);

test('a fresh-token 404 and connection-level git failures count as transient', () => {
  for (const out of [
    "remote: Repository not found.\nfatal: repository 'https://github.com/Org/repo.git/' not found",
    "fatal: unable to access 'https://github.com/Org/repo.git/': Could not resolve host: github.com",
    "fatal: unable to access 'https://github.com/Org/repo.git/': The requested URL returned error: 502",
    'error: RPC failed; curl 56 GnuTLS recv error (-54): Error in the pull function.\nfatal: early EOF',
    'fatal: the remote end hung up unexpectedly',
    "fatal: unable to access '…': Failed to connect to github.com port 443: Connection timed out",
  ]) {
    assert.equal(isTransientGitFailure(execError(out)), true, out);
  }
});

test('real answers are not retried: auth refusal, merge state, unknown ref, non-git errors', () => {
  for (const out of [
    'remote: Invalid username or password.\nfatal: Authentication failed',
    'error: Your local changes to the following files would be overwritten by merge',
    "fatal: couldn't find remote ref refs/heads/nope",
    'The requested URL returned error: 403',
  ]) {
    assert.equal(isTransientGitFailure(execError(out)), false, out);
  }
  assert.equal(isTransientGitFailure(new Error('ENOSPC: no space left on device')), false);
  assert.equal(isTransientGitFailure(undefined), false);
});

test('withGitRetry retries transient failures with the given delays, then gives up with the last error', async () => {
  const slept: number[] = [];
  const retried: number[] = [];
  let calls = 0;
  const out = await withGitRetry(
    async () => {
      calls++;
      if (calls < 3) throw execError('remote: Repository not found.');
      return 'ok';
    },
    { delaysMs: [2, 5], sleep: async (ms) => void slept.push(ms), onRetry: (_e, a) => retried.push(a) },
  );
  assert.equal(out, 'ok');
  assert.deepEqual(slept, [2, 5]);
  assert.deepEqual(retried, [1, 2]);

  calls = 0;
  await assert.rejects(
    withGitRetry(
      async () => {
        calls++;
        throw execError('remote: Repository not found.');
      },
      { delaysMs: [1], sleep: async () => {} },
    ),
    /Repository not found/,
  );
  assert.equal(calls, 2);
});

test('withGitRetry passes a non-transient error through on the first attempt', async () => {
  let calls = 0;
  await assert.rejects(
    withGitRetry(
      async () => {
        calls++;
        throw execError('fatal: Authentication failed');
      },
      { delaysMs: [1, 1], sleep: async () => {} },
    ),
    /Authentication failed/,
  );
  assert.equal(calls, 1);
});
