import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureCli, probeCredit } from './install.js';

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

test('probeCredit — no variable: names both probe variables and ignores an installation’s credit (api-key-credit D6)', () => {
  for (const env of [{ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test', ANTHROPIC_API_KEY: 'sk-ant-api03-test' }, { CLI_PROBE_TOKEN: '  ', CLI_PROBE_API_KEY: '' }]) {
    assert.throws(() => probeCredit(env), (e: Error) => /^neither CLI_PROBE_TOKEN nor CLI_PROBE_API_KEY is set/.test(e.message) && !e.message.includes('sk-ant-'));
  }
});

test('probeCredit — both: stops and says to keep one, naming no value', () => {
  assert.throws(
    () => probeCredit({ CLI_PROBE_TOKEN: 'sk-ant-oat01-test', CLI_PROBE_API_KEY: 'sk-ant-api03-test' }),
    (e: Error) => /^both CLI_PROBE_TOKEN and CLI_PROBE_API_KEY are set .* keep one$/.test(e.message) && !e.message.includes('sk-ant-'),
  );
});

test('probeCredit — each one alone, trimmed; the installation’s variables are never read', () => {
  assert.deepEqual(probeCredit({ CLI_PROBE_TOKEN: ' sk-ant-oat01-test \n', CLAUDE_CODE_OAUTH_TOKEN: 'installation-token' }), { kind: 'subscription', value: 'sk-ant-oat01-test' });
  assert.deepEqual(probeCredit({ CLI_PROBE_API_KEY: 'sk-ant-api03-test', ANTHROPIC_API_KEY: 'installation-key' }), { kind: 'api-key', value: 'sk-ant-api03-test' });
});
