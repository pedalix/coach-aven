/**
 * The puller-facing entry point: scrub a message record right before it is written, and file the
 * raw secrets of a carrier into the vault. Keeps each puller's write path to one call and keeps
 * the vault policy in one place:
 *   - scrubbing is mandatory and never fails open (a throwing scrubber would be a bug, not a skip);
 *   - the vault is best-effort for an unattended puller: if `age` or the recipient is missing we
 *     log ONCE per run and keep going — the scrubbed record still ships, the secret is simply not
 *     preserved. docs/sources.md tells the operator how to turn the warning off.
 * Runs on the bot host only, like everything under src/sources.
 */
import { scrubMessage, type ScrubMeta, type ScrubbableMessage } from '../../scrub.js';
import { storeSecrets, VaultUnavailable, type CarrierMessage, type VaultPaths } from './vault.js';

export interface SinkOptions {
  log?: (line: string) => void;
  /** Where carrier bodies go. Undefined = withhold without preserving (warned once via `warned`). */
  vault?: VaultPaths;
  /** Per-run memo so the "vault unavailable" line is printed once, not per message. */
  warned?: { vault: boolean };
}

export function scrubForWrite<T extends ScrubbableMessage>(rec: T, opts: SinkOptions = {}): T & { scrub: ScrubMeta } {
  const out = scrubMessage(rec);
  if (out.scrub.withheld) {
    const warn = (msg: string) => {
      if (opts.warned?.vault) return;
      if (opts.warned) opts.warned.vault = true;
      (opts.log ?? console.error)(`vault: ${msg} — carrier bodies are withheld but NOT preserved until this is fixed`);
    };
    if (!opts.vault) warn('no vault configured for this project');
    else {
      try {
        storeSecrets(rec as unknown as CarrierMessage, opts.vault);
      } catch (err) {
        if (err instanceof VaultUnavailable) warn(err.message);
        else throw err;
      }
    }
  }
  return out;
}
