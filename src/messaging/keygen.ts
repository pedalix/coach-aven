// `orch hub keygen` (OpenSpec `agent-messaging`, design D6; `hub-open-network`, N1): an installation's key
// file at HUB_KEY_PATH, mode 0600, and the public halves to hand out — both keys to the peers'
// hub.peers.json, and the signing key to a hub operator who reserves the name (an open hub needs nothing:
// the name is claimed by this key when the bot first connects). A rotation keeps the previous encryption key for a grace period (14 days), so
// envelopes sealed to it before the peers updated still open.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { INSTALLATION_RE } from './protocol.js';
import { fingerprint, generateKeyFile, type KeyFile } from './seal.js';

export const ROTATION_GRACE_DAYS = 14;

/** Pure: the next key file — a new one, or a rotation of `existing` (previous keys past their grace dropped). */
export function nextKeyFile(existing: KeyFile | undefined, o: { rotate: boolean; now: Date }): KeyFile {
  if (existing && !o.rotate) throw new Error('a key file exists already — keep it, or rotate with --rotate');
  const fresh = generateKeyFile();
  if (!existing) return fresh;
  const notAfter = new Date(o.now.getTime() + ROTATION_GRACE_DAYS * 86_400_000).toISOString();
  const still = (existing.previous ?? []).filter((p) => Date.parse(p.notAfter) > o.now.getTime());
  return { ...fresh, previous: [{ encryption: existing.encryption, notAfter }, ...still] };
}

/** Pure: what to hand out — public halves only, as the hub configuration and hub.peers.json want them. */
export function publicHalves(installation: string, file: KeyFile): string {
  const reserved = { [installation]: { sign: [{ key: file.signing.public }] } };
  const peers = { [installation]: { keys: [{ sign: file.signing.public, box: file.encryption.public }] } };
  return [
    `signing key ${fingerprint(file.signing.public)}, encryption key ${fingerprint(file.encryption.public)}`,
    '',
    'For a hub operator who reserves this name (an entry of HUB_CONFIG "reserved"; on an open hub the name is claimed when the bot first connects):',
    JSON.stringify(reserved, null, 2),
    '',
    'For the peers (their hub.peers.json):',
    JSON.stringify(peers, null, 2),
    '',
  ].join('\n');
}

/** Write the key file (0600) and return the public halves to print. */
export function keygen(o: { path: string; installation: string; rotate: boolean; now?: Date }): string {
  if (!INSTALLATION_RE.test(o.installation) || o.installation === 'local' || o.installation === 'hub') {
    throw new Error('INSTALLATION_ID must be set to this installation’s name ([a-z0-9-]{1,32}, not "local" or "hub", which every hub reserves) before keys are made');
  }
  const existing = existsSync(o.path) ? (JSON.parse(readFileSync(o.path, 'utf8')) as KeyFile) : undefined;
  const file = nextKeyFile(existing, { rotate: o.rotate, now: o.now ?? new Date() });
  writeFileSync(o.path, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  chmodSync(o.path, 0o600); // an existing file keeps its old mode on write
  return publicHalves(o.installation, file);
}
