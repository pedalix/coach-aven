/**
 * Vault — where scrubbed secrets go so they are not merely cut out but kept, encrypted, on the
 * BOT HOST. One file per carrier message under data/<slug>/vault/<vaultId>.json.age; the
 * recipient (age public key) lives with the project's credentials (tokens.ts vaultPathsFor).
 *
 * Why `age` and not our own crypto: a 30-line home-grown AES wrapper is exactly the kind of thing
 * that looks fine and leaks the key. `age` is boring, audited and has a one-command decrypt
 * (`age -d -i <your key> <file>`). If the binary is missing we REFUSE to write — plaintext
 * secrets on disk would defeat the whole scrubber.
 *
 * Side effect for the operator: every credential that ever arrived by mail or DM ends up findable
 * in one place by vault id, and the agent only ever sees the id.
 *
 * The pure parts (path, payload) are exported for tests; `storeSecrets` is the I/O wrapper.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractSecrets, vaultId, type ExtractedSecret, type ScrubOptions } from '../../scrub.js';

export interface VaultPayload {
  version: 1;
  vault_id: string;
  source: string;
  id: string;
  /** Where the carrier came from — enough to find the original in the source system, no body. */
  ref: { account?: string; container?: string; ts?: string; author?: string; subject?: string; permalink?: string };
  secrets: ExtractedSecret[];
  /** The full original body — the vault is the ONE place it may live, encrypted. */
  body: string;
}

export interface VaultPaths {
  dir: string;
  recipientFile: string;
}

export function vaultFile(dir: string, id: string): string {
  if (!/^[0-9a-f]{12}$/.test(id)) throw new Error(`vault id must be 12 hex chars, got ${JSON.stringify(id)}`);
  return join(dir, `${id}.json.age`);
}

export interface CarrierMessage {
  source: string;
  id: string;
  text: string;
  subject?: string;
  account?: string;
  container?: string;
  ts?: string;
  author?: string;
  permalink?: string;
  [k: string]: unknown;
}

export function buildPayload(msg: CarrierMessage, opts: ScrubOptions = {}): VaultPayload {
  return {
    version: 1,
    vault_id: vaultId(msg.source, msg.id),
    source: msg.source,
    id: msg.id,
    ref: { account: msg.account, container: msg.container, ts: msg.ts, author: msg.author, subject: msg.subject, permalink: msg.permalink },
    secrets: extractSecrets(msg, opts),
    body: msg.text,
  };
}

export class VaultUnavailable extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'VaultUnavailable';
  }
}

/** Probe once per process; the answer does not change mid-run. */
let ageChecked: boolean | undefined;
export function ageAvailable(): boolean {
  if (ageChecked === undefined) ageChecked = spawnSync('age', ['--version'], { stdio: 'ignore' }).status === 0;
  return ageChecked;
}

export function readRecipient(paths: VaultPaths): string {
  if (!existsSync(paths.recipientFile)) {
    throw new VaultUnavailable(`no vault recipient at ${paths.recipientFile} — run: age-keygen -o <somewhere safe>/vault.key && age-keygen -y <that file> > ${paths.recipientFile}`);
  }
  const r = readFileSync(paths.recipientFile, 'utf8').trim();
  if (!/^age1[0-9a-z]{20,}$/.test(r)) throw new VaultUnavailable(`${paths.recipientFile} does not hold an age public key (age1…)`);
  return r;
}

export interface StoreResult {
  vault_id: string;
  file: string;
  secrets: number;
  /** False when the file already existed — a re-pull of the same message does not rewrite the vault. */
  written: boolean;
}

/**
 * Encrypt the payload to the recipient and write it. Idempotent per message id. Throws
 * VaultUnavailable when `age` or the recipient is missing — the caller decides whether that is
 * fatal (bootstrap) or a logged skip (cron puller: the scrubbed record still ships, the secret is
 * simply not preserved).
 */
export function storeSecrets(msg: CarrierMessage, paths: VaultPaths, opts: ScrubOptions = {}): StoreResult {
  if (!ageAvailable()) throw new VaultUnavailable('`age` binary not found — install it (brew install age / apt install age); refusing to write plaintext');
  const recipient = readRecipient(paths);
  const payload = buildPayload(msg, opts);
  const file = vaultFile(paths.dir, payload.vault_id);
  if (existsSync(file)) return { vault_id: payload.vault_id, file, secrets: payload.secrets.length, written: false };
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const res = spawnSync('age', ['-r', recipient, '-o', file], { input: JSON.stringify(payload, null, 2), stdio: ['pipe', 'ignore', 'pipe'] });
  if (res.status !== 0) throw new VaultUnavailable(`age failed: ${res.stderr?.toString() ?? `exit ${res.status}`}`);
  return { vault_id: payload.vault_id, file, secrets: payload.secrets.length, written: true };
}
