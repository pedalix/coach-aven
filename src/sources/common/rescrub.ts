/**
 * Re-scrub withheld bodies after the classifier changed its mind. The scrubber withholds a WHOLE
 * body when it thinks a message carries credentials, and files the original in the vault
 * (vault.ts). Every tightening of `classifyMessage` (scrub.ts) leaves bodies in the vault that
 * would be inline-redacted today — 2026-10-14: ~230 of them, Owen's own security mail among
 * them. This replays the current rules over them: decrypt the vault entry (needs the operator's
 * age identity — the bot host only holds the public recipient), re-run `scrubMessage` on the
 * original body and, when it is no longer a carrier, APPEND the restored record to the same raw
 * file. Appending is the only safe write: the store consumes raw files by byte offset and upserts
 * by ref (store.ts), so a later line with the same id simply replaces the withheld one at the
 * next build; rewriting in place would shift offsets under a running puller.
 *
 * Idempotent: a message whose LAST raw line is already un-withheld is skipped. Only message-shaped
 * records (`text` holding the withheld marker) are handled — meeting summaries and ticket comments
 * withhold a different field and are reported as skipped.
 */
import { readdirSync, readFileSync, appendFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { classifyMessage, scrubMessage, type ScrubMeta } from '../../scrub.js';
import { vaultFile, type VaultPayload } from './vault.js';

export interface RescrubCounts {
  files: number;
  /** Records whose last raw line is withheld (candidates). */
  withheld: number;
  /** Restored: appended with the body inline-scrubbed. */
  restored: number;
  /** Still a carrier under the current rules — left as is. */
  stillWithheld: number;
  /** No vault entry (vault was unavailable when the body was withheld) — nothing to restore from. */
  noVault: number;
  /** Not a message-shaped record (summary/comment withholding) — out of scope. */
  skipped: number;
  /** `reason → count` for what still withholds, so the next rule change has numbers. */
  reasons: Record<string, number>;
}

export interface RescrubOptions {
  /** Decrypts one vault entry; undefined when the file is missing. Injected so tests need no `age`. */
  decrypt: (vaultId: string) => VaultPayload | undefined;
  /** Append restored lines (default: dry run — counts only). */
  write?: boolean;
  log?: (line: string) => void;
}

export function listJsonl(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

/** `age -d -i <identity> <file>` → payload; undefined when the entry does not exist. */
export function ageDecrypt(vaultDir: string, identity: string): RescrubOptions['decrypt'] {
  return (vaultId) => {
    const file = vaultFile(vaultDir, vaultId);
    const res = spawnSync('age', ['-d', '-i', identity, file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (res.status !== 0) {
      if (/no such file|cannot open|not found/i.test(res.stderr ?? '')) return undefined;
      throw new Error(`age -d ${file}: ${(res.stderr ?? '').trim() || `exit ${res.status}`}`);
    }
    return JSON.parse(res.stdout) as VaultPayload;
  };
}

type RawRecord = { source?: string; id?: string; text?: unknown; scrub?: ScrubMeta } & Record<string, unknown>;

const WITHHELD_MARKER = /^\[BODY WITHHELD:/;

export function rescrubFile(path: string, opts: RescrubOptions, counts: RescrubCounts): void {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  // Last line per id wins (the puller appends edits; a previous rescrub appended restorations).
  const last = new Map<string, number>();
  const recs: Array<RawRecord | null> = lines.map((l, i) => {
    try {
      const r = JSON.parse(l) as RawRecord;
      if (r && typeof r.id === 'string') last.set(`${r.source}:${r.id}`, i);
      return r;
    } catch {
      return null;
    }
  });
  const restored: string[] = [];
  for (const [key, i] of last) {
    const r = recs[i]!;
    if (!r.scrub?.withheld) continue;
    counts.withheld++;
    if (typeof r.text !== 'string' || !WITHHELD_MARKER.test(r.text)) {
      counts.skipped++;
      continue;
    }
    if (!r.scrub.vault) {
      counts.noVault++;
      continue;
    }
    const payload = opts.decrypt(r.scrub.vault);
    if (!payload) {
      counts.noVault++;
      continue;
    }
    const { scrub: _old, ...rest } = r;
    const out = scrubMessage({ ...rest, source: String(r.source), id: String(r.id), text: payload.body } as RawRecord & { source: string; id: string; text: string });
    if (out.scrub.withheld) {
      counts.stillWithheld++;
      const why = classifyReason(payload.body, r.subject);
      counts.reasons[why] = (counts.reasons[why] ?? 0) + 1;
      continue;
    }
    counts.restored++;
    // Keep the vault id on the restored record: the body is inline-scrubbed now, but the entry
    // with the original still exists and a reader may want to know that.
    restored.push(JSON.stringify({ ...out, scrub: { ...out.scrub, vault: r.scrub.vault } }));
    opts.log?.(`restore ${key}: ${String(r.subject ?? '').slice(0, 60)} (${out.scrub.redactions} inline redactions)`);
  }
  if (opts.write && restored.length) appendFileSync(path, restored.join('\n') + '\n');
}

function classifyReason(body: string, subject: unknown): string {
  return classifyMessage({ text: body, ...(typeof subject === 'string' ? { subject } : {}) }).reasons.join('+') || '?';
}

export function rescrubDir(rawDir: string, opts: RescrubOptions): RescrubCounts {
  const counts: RescrubCounts = { files: 0, withheld: 0, restored: 0, stillWithheld: 0, noVault: 0, skipped: 0, reasons: {} };
  for (const f of listJsonl(rawDir)) {
    counts.files++;
    rescrubFile(f, opts, counts);
  }
  return counts;
}
