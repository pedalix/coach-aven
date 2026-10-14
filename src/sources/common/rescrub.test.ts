import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rescrubDir } from './rescrub.js';
import type { VaultPayload } from './vault.js';

const line = (o: object) => JSON.stringify(o) + '\n';
const payload = (body: string): VaultPayload => ({ version: 1, vault_id: 'x', source: 'msgraph', id: 'x', ref: {}, secrets: [], body }) as unknown as VaultPayload;

test('rescrub: restores bodies the current rules keep, leaves real carriers, is idempotent, dry-run writes nothing', () => {
  const raw = mkdtempSync(join(tmpdir(), 'rescrub-'));
  mkdirSync(join(raw, 'msgraph'));
  const file = join(raw, 'msgraph', 'messages.jsonl');
  const marker = '[BODY WITHHELD: credential carrier — see vault aaaaaaaaaaaa]';
  writeFileSync(
    file,
    line({ source: 'msgraph', id: 'about', subject: 'FOC Cloud: 18 credentials to rotate', text: marker, scrub: { withheld: true, kinds: ['kv'], redactions: 0, vault: 'v-about' } }) +
      line({ source: 'msgraph', id: 'real', subject: 'Your credentials for the portal', text: marker, scrub: { withheld: true, kinds: ['kv'], redactions: 0, vault: 'v-real' } }) +
      line({ source: 'msgraph', id: 'novault', subject: 'x', text: marker, scrub: { withheld: true, kinds: [], redactions: 0 } }) +
      line({ source: 'msgraph', id: 'plain', subject: 'y', text: 'hello', scrub: { withheld: false, kinds: [], redactions: 0 } }),
  );
  const vault: Record<string, VaultPayload> = {
    'v-about': payload('19 credentials in 41 places; a scanner pass (gitleaks) later. token: abcdef123456'),
    'v-real': payload('Login: owen\nPassword: K/9988776655ab'),
  };
  const opts = { decrypt: (id: string) => vault[id] };
  const dry = rescrubDir(raw, opts);
  assert.deepEqual(dry, { files: 1, withheld: 3, restored: 1, stillWithheld: 1, noVault: 1, skipped: 0, reasons: { 'exact:kv+login+subject': 1 } });
  assert.equal(readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 4, 'dry run appends nothing');

  const wet = rescrubDir(raw, { ...opts, write: true });
  assert.equal(wet.restored, 1);
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 5);
  const restored = JSON.parse(lines[4]!);
  assert.equal(restored.id, 'about');
  assert.match(restored.text, /19 credentials in 41 places/);
  assert.match(restored.text, /\[REDACTED:kv:[0-9a-f]{6}\]/, 'the explicit token: value is still redacted inline');
  assert.deepEqual(restored.scrub, { withheld: false, kinds: ['kv'], redactions: 2, vault: 'v-about' }); // "pass (gitleaks" is still an inline hit — that is the point: inline, not withheld

  // Second run: the restored id's last line is un-withheld → not a candidate any more.
  const again = rescrubDir(raw, { ...opts, write: true });
  assert.equal(again.restored, 0);
  assert.equal(again.withheld, 2);
  assert.equal(readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 5);
});
