// Company brain: the host's index of a project's memory records — derived from the mirrored files alone, without
// a model (spec: "The host keeps an index and a lint report"). Pure: files in, index out; the previous index is
// the only memory, and it carries the two dates a file cannot say for itself — when the host first saw a record
// and when its content last changed.

import { createHash } from 'node:crypto';
import { parseRecord, type Kind, type Status } from './record.js';

export const INDEX_FILE = 'MEMORY.md';

export interface IndexedRecord {
  name: string; // the file name
  title?: string;
  kind?: Kind;
  status?: Status;
  ticket?: string;
  hash: string; // sha256 of the file as mirrored
  firstSeen: string; // ISO; the record's own `modified` stamp when that is earlier than the host's first look
  lastChange: string; // ISO; when the host last saw the content differ
  // Personal-data patterns found in the text — counts only: the index must not become a second copy of them.
  personal?: { email?: number; phone?: number };
}

export interface BrainIndex {
  builtAt: string;
  records: IndexedRecord[]; // by name
  linked: string[]; // the files MEMORY.md links to, as written there
}

export const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

// An address, and a phone number in international form (+, then 9–15 digits with the usual separators).
// National formats are left alone on purpose: a memory record is full of order ids, dates and amounts.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const PHONE = /(?<![\w+])\+[1-9](?:[ ().-]{0,2}\d){8,14}(?!\d)/g;

export function personalData(text: string): { email?: number; phone?: number } | undefined {
  const email = text.match(EMAIL)?.length ?? 0;
  const phone = text.match(PHONE)?.length ?? 0;
  if (!email && !phone) return undefined;
  return { ...(email ? { email } : {}), ...(phone ? { phone } : {}) };
}

// The files MEMORY.md points at: markdown links to a local `.md` file.
export function linkedFiles(indexText: string): string[] {
  const out = new Set<string>();
  for (const m of indexText.matchAll(/\]\(\s*(?:\.\/)?([A-Za-z0-9._-]+\.md)\s*\)/g)) out.add(m[1]);
  return [...out].sort();
}

export function buildIndex(files: Record<string, string>, now: Date, prev?: BrainIndex): BrainIndex {
  const before = new Map((prev?.records ?? []).map((r) => [r.name, r]));
  const at = now.toISOString();
  const records: IndexedRecord[] = [];
  for (const name of Object.keys(files).sort()) {
    if (name === INDEX_FILE || !name.endsWith('.md')) continue;
    const text = files[name];
    const p = parseRecord(text);
    const hash = sha256(text);
    const old = before.get(name);
    const stamp = p.modified ? Date.parse(p.modified) : NaN;
    const personal = personalData(text);
    records.push({
      name,
      ...(p.title ? { title: p.title } : {}),
      ...(p.kind ? { kind: p.kind } : {}),
      ...(p.status ? { status: p.status } : {}),
      ...(p.ticket ? { ticket: p.ticket } : {}),
      hash,
      firstSeen: old?.firstSeen ?? (stamp < now.getTime() ? new Date(stamp).toISOString() : at),
      lastChange: old ? (old.hash === hash ? old.lastChange : at) : at,
      ...(personal ? { personal } : {}),
    });
  }
  return { builtAt: at, records, linked: linkedFiles(files[INDEX_FILE] ?? '') };
}
