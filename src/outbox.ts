// The outbox (OpenSpec outbound-files): files the agent saves for the person during a turn reach the
// conversation. The mirror of attachments.ts' inbox — same allowlist, caps and name hygiene — and, like it, pure
// where it counts: the paths, the three sandbox scripts and their parsing, admission, the texts. The one impure
// step, reading the files back, takes the sandbox's `exec` as a function (collectOutbox) so tasks.ts stays a
// one-liner and the whole path is unit-tested without a container. The posting lives in turn.ts.
//
// Why a directory per TURN: conversations of one project share one sandbox and run turns concurrently; a shared
// directory would hand one conversation another's files. Why read at the END of the turn: nothing in the sandbox
// can call the bot (no mounts, no server — doctrine); the turn's end is the moment the bot reads the sandbox anyway.
// Why base64 over exec: the sandbox handle writes bytes (uploadFile) but never reads them, and the 25 MB cap keeps
// a base64 string affordable — a read-back primitive would touch every fake of the handle for the same result.

import { MAX_BYTES, MAX_FILES, isSupported, mimeOf, sanitizeName } from './attachments.js';
import { scrubSummary, scrubText } from './scrub.js';
import { log } from './log.js';

// One file for the person: the bytes, the (sanitized) name people see and the media type its name says.
export interface OutboundFile {
  name: string;
  mime: string;
  data: Buffer;
}

export function outboxDir(turnId: string): string {
  return `/root/outbox/${turnId}`;
}

// Shell-quote one word (the file names are the agent's, not ours).
const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

// The listing: "<bytes>\t<basename>" per regular file DIRECTLY in the directory (no recursion; a dotfile is a
// file). POSIX shell only — the plain sandbox image is Alpine, whose busybox `find` has no `-printf` (the first
// canary turn listed nothing for exactly that reason). A missing directory prints nothing and exits 0: the common
// case is a turn that saved nothing.
export function listScript(dir: string): string {
  return `test -d ${sq(dir)} && cd ${sq(dir)} && for f in * .*; do [ -f "$f" ] && printf '%s\\t%s\\n' "$(wc -c < "$f")" "$f"; done; true`;
}
// The bytes of one file as one base64 line; the directory's removal once the turn has what it wanted.
export function readScript(path: string): string {
  return `base64 -w0 ${sq(path)}`;
}
export function removeScript(dir: string): string {
  return `rm -rf ${sq(dir)}`;
}

export interface OutboxEntry {
  name: string;
  size: number;
}
export function parseListing(stdout: string): OutboxEntry[] {
  const out: OutboxEntry[] = [];
  for (const line of stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 1) continue;
    const size = Number(line.slice(0, tab));
    const name = line.slice(tab + 1);
    if (!Number.isInteger(size) || size < 0 || !name) continue;
    out.push({ name, size });
  }
  return out;
}

// The refusal strings — the inbound ones where they mean the same, so one kind of notice serves both sides.
export const OVER_COUNT = `over the ${MAX_FILES}-file limit`;

export interface PlannedFile {
  name: string; // sanitized: what the person sees
  path: string; // the file in the sandbox, as listed
  mime: string;
  size: number;
}

// Pure admission, in name order so a turn's files post in a stable order: the inbound allowlist (the media type is
// the extension's — the sandbox reports none), the byte cap, the count cap. An empty file is nothing the agent
// meant to send: ignored without a word.
export function planOutbox(dir: string, entries: OutboxEntry[]): { accept: PlannedFile[]; skipped: { name: string; reason: string }[] } {
  const accept: PlannedFile[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of sorted) {
    if (e.size === 0) continue;
    if (accept.length >= MAX_FILES) {
      skipped.push({ name: e.name, reason: OVER_COUNT });
      continue;
    }
    const name = sanitizeName(e.name);
    const mime = mimeOf(name);
    if (!isSupported(mime, name)) {
      skipped.push({ name: e.name, reason: 'unsupported type' });
      continue;
    }
    if (e.size > MAX_BYTES) {
      skipped.push({ name: e.name, reason: 'too large' });
      continue;
    }
    accept.push({ name, path: `${dir}/${e.name}`, mime, size: e.size });
  }
  return { accept, skipped };
}

// Text-typed files pass the secrets scrub an answer passes (the sandbox holds tokens, the agent holds the repo);
// binaries go as written — the same gap every screenshot has.
export function isTextFile(mime: string): boolean {
  return mime.startsWith('text/') || mime === 'application/json' || mime === 'application/yaml';
}

// The sandbox calls, through the handle's exec: list → plan → read each → remove. Never throws: whatever fails
// becomes a `skipped` entry the engine turns into a notice, and the answer — already delivered — stands.
export type Exec = (command: string) => Promise<{ exitCode: number; result: string }>;
export async function collectOutbox(
  exec: Exec,
  turnId: string,
  o: { scrub: boolean },
): Promise<{ files: OutboundFile[]; skipped: { name: string; reason: string }[] }> {
  const dir = outboxDir(turnId);
  const files: OutboundFile[] = [];
  const skipped: { name: string; reason: string }[] = [];
  try {
    const ls = await exec(listScript(dir));
    const entries = ls.exitCode === 0 ? parseListing(ls.result) : [];
    if (ls.exitCode !== 0) skipped.push({ name: 'outbox', reason: 'read failed' });
    const plan = planOutbox(dir, entries);
    skipped.push(...plan.skipped);
    for (const f of plan.accept) {
      const r = await exec(readScript(f.path));
      if (r.exitCode !== 0) {
        skipped.push({ name: f.name, reason: 'read failed' });
        continue;
      }
      let data = Buffer.from(r.result.replace(/\s+/g, ''), 'base64');
      if (o.scrub && isTextFile(f.mime)) {
        const { text, findings } = scrubText(data.toString('utf8'));
        if (findings.length) {
          const { kinds, count } = scrubSummary(findings);
          log.info(`redacted ${count} secret(s) [${kinds.join(',')}] from outbox file ${f.name}`);
          data = Buffer.from(text, 'utf8');
        }
      }
      files.push({ name: f.name, mime: f.mime, data });
    }
    if (entries.length) await exec(removeScript(dir));
  } catch (e) {
    log.warn(`outbox ${turnId}: ${e instanceof Error ? e.message : String(e)}`);
    skipped.push({ name: 'outbox', reason: 'read failed' });
  }
  return { files, skipped };
}

// The line in the turn's message that names the directory — the one thing the session prompt cannot know.
export function outboxPreamble(turnId: string): string {
  return `Outbox for this turn: ${outboxDir(turnId)}/ — a file you save there is posted into this conversation right after your answer.`;
}

// The person's notice for refused files — deterministic, like the inbound skippedNotice; '' when none.
export function outboxSkippedNotice(skipped: { name: string; reason: string }[]): string {
  if (!skipped.length) return '';
  const friendly: Record<string, string> = {
    'unsupported type': 'not a file type I can post — images, PDFs, and text/data/office documents are',
    'too large': `over my ${Math.round(MAX_BYTES / 1024 / 1024)} MB per-file limit`,
    [OVER_COUNT]: `more than ${MAX_FILES} files in one turn — the first ${MAX_FILES} went out`,
    'read failed': 'I could not read it back from the sandbox',
  };
  return [
    `📎 Sorry — I couldn't post ${skipped.length === 1 ? 'this file' : 'these files'}:`,
    ...skipped.map((s) => `• \`${s.name}\` — ${friendly[s.reason] ?? s.reason}`),
  ].join('\n');
}

// The platform refused the upload: the answer stands, the files are named.
export function outboxFailedNotice(names: string[], reason: string): string {
  return `⚠️ Couldn't post ${names.map((n) => `\`${n}\``).join(', ')} — ${reason.slice(0, 300)}`;
}

// A conversation marked as holding another domain's data takes no file uploads (an upload cannot carry the
// marker the project's sources skip): the files are named, the bytes stay in the sandbox.
export function outboxMarkedNotice(names: string[]): string {
  return (
    `📎 I produced ${names.map((n) => `\`${n}\``).join(', ')} but can't attach files in this thread — it carries ` +
    `another domain's data, and file uploads cannot be marked for it. Ask again in a thread without that data.`
  );
}
