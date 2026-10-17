import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseSdkRelease, ensureDeclarations, fetchPackument, publishedAt, releaseAt } from './sdk.js';

// A fictional registry document: releases name the CLI they match; one is a prerelease, one names none.
const doc = {
  versions: {
    '0.3.258': { claudeCodeVersion: '2.1.258' },
    '0.3.260': { claudeCodeVersion: '2.1.260' },
    '0.3.261': {},
    '0.3.282-beta.1': { claudeCodeVersion: '2.1.282' },
    '0.3.282': { claudeCodeVersion: '2.1.282' },
    '0.3.290': { claudeCodeVersion: '2.1.290' },
  },
};

test('chooseSdkRelease — the release that names the CLI version', () => {
  assert.deepEqual(chooseSdkRelease('2.1.282', doc), { release: '0.3.282', claudeCodeVersion: '2.1.282', exact: true });
});

test('chooseSdkRelease — no release names the version: the nearest lower one, said so; none at or below fails', () => {
  assert.deepEqual(chooseSdkRelease('2.1.285', doc), { release: '0.3.282', claudeCodeVersion: '2.1.282', exact: false });
  assert.deepEqual(chooseSdkRelease('2.1.259', doc), { release: '0.3.258', claudeCodeVersion: '2.1.258', exact: false });
  assert.throws(() => chooseSdkRelease('2.1.100', doc), /no @anthropic-ai\/claude-agent-sdk release names Claude Code 2\.1\.100 or an older version/);
});

test('fetchPackument — asks for the FULL document (the abbreviated one lacks claudeCodeVersion)', async () => {
  let seen: { url: string; accept?: string } | undefined;
  const fake = (async (url: string, init?: RequestInit) => {
    seen = { url, accept: (init?.headers as Record<string, string>)?.accept };
    return new Response(JSON.stringify(doc), { status: 200 });
  }) as unknown as typeof fetch;
  assert.deepEqual(await fetchPackument('@anthropic-ai/claude-agent-sdk', fake), doc);
  assert.deepEqual(seen, { url: 'https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk', accept: 'application/json' });
});

test('ensureDeclarations — npm pack of both packages into the cache as a node_modules tree, reused next time', async () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), 'cliprobe-sdk-'));
  try {
    const calls: string[] = [];
    const run = async (file: string, args: readonly string[]): Promise<string> => {
      calls.push(`${file} ${args[0]} ${args[1]}`);
      if (file === 'npm') {
        const dest = args[args.indexOf('--pack-destination') + 1]!;
        const name = String(args[1]).replace(/@[^@]*$/, '').replace(/^@/, '').replace('/', '-');
        writeFileSync(join(dest, `${name}.tgz`), '');
        return JSON.stringify([{ filename: `${name}.tgz` }]);
      }
      const dest = args[args.indexOf('-C') + 1]!;
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, dest.endsWith('claude-agent-sdk') ? 'sdk.d.ts' : 'package.json'), '');
      return '';
    };
    const r = await ensureDeclarations({ release: '0.3.282', apiSdk: '0.96.0', cacheRoot, run });
    assert.equal(r.sdkDts, join(cacheRoot, 'sdk', '0.3.282+0.96.0', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.d.ts'));
    assert.ok(existsSync(r.sdkDts));
    assert.deepEqual(calls, [
      'npm pack @anthropic-ai/claude-agent-sdk@0.3.282',
      'tar -xzf ' + calls[1]!.split(' ')[2],
      'npm pack @anthropic-ai/sdk@0.96.0',
      'tar -xzf ' + calls[3]!.split(' ')[2],
    ]);
    await ensureDeclarations({ release: '0.3.282', apiSdk: '0.96.0', cacheRoot, run });
    assert.equal(calls.length, 4, 'cached declarations are not fetched again');
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('releaseAt — the API types as they stood when the agent SDK release was published, not the newest', () => {
  const agent = { versions: doc.versions, time: { '0.3.282': '2026-09-24T15:53:58.907Z' } };
  const api = {
    versions: { '0.127.0': {}, '0.128.0': {}, '0.129.0-beta.1': {}, '0.135.0': {} },
    time: { '0.127.0': '2026-09-15T10:00:00.000Z', '0.128.0': '2026-09-22T16:38:57.478Z', '0.129.0-beta.1': '2026-09-23T00:00:00.000Z', '0.135.0': '2026-10-15T00:00:00.000Z' },
  };
  assert.equal(releaseAt(api, publishedAt(agent, '0.3.282')), '0.128.0');
  assert.throws(() => releaseAt(api, '2026-01-01T00:00:00.000Z'), /no release published at or before/);
  assert.throws(() => publishedAt(agent, '0.3.999'), /no publish time/);
});

