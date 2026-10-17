import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureCli, probeToken } from './install.js';

test('ensureCli — version not installed: installs into the probe cache with npm --prefix, then reuses it', async () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), 'cliprobe-install-'));
  try {
    const calls: string[][] = [];
    const exec = async (file: string, args: readonly string[]): Promise<void> => {
      calls.push([file, ...args]);
      const dir = args[args.indexOf('--prefix') + 1]!;
      mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', '.bin', 'claude'), '#!/bin/sh\n');
    };
    const bin = await ensureCli('2.1.282', { cacheRoot, exec });
    assert.equal(bin, join(cacheRoot, 'cli', '2.1.282', 'node_modules', '.bin', 'claude'));
    assert.deepEqual(calls, [
      ['npm', 'install', '--prefix', join(cacheRoot, 'cli', '2.1.282'), '--no-save', '--no-audit', '--no-fund', '--loglevel=error', '@anthropic-ai/claude-code@2.1.282'],
    ]);
    assert.equal(await ensureCli('2.1.282', { cacheRoot, exec }), bin);
    assert.equal(calls.length, 1, 'a cached version is not installed again');
    await assert.rejects(ensureCli('2.1.282; rm -rf /', { cacheRoot, exec }), /not a CLI version/);
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('probeToken — no token: names CLI_PROBE_TOKEN and ignores an installation’s CLAUDE_CODE_OAUTH_TOKEN', () => {
  assert.throws(() => probeToken({ CLAUDE_CODE_OAUTH_TOKEN: 'installation-token' }), /CLI_PROBE_TOKEN is not set/);
  assert.throws(() => probeToken({ CLI_PROBE_TOKEN: '  ' }), /CLI_PROBE_TOKEN/);
  assert.equal(probeToken({ CLI_PROBE_TOKEN: ' probe-token \n', CLAUDE_CODE_OAUTH_TOKEN: 'installation-token' }), 'probe-token');
});
