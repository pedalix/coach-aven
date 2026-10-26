// Uploads on the web surface, pure where it counts (OpenSpec web-chat-driver, design D7): a file a person attaches
// to a post is stored beside the conversation — `<data dir>/web/<slug>/files/<room | pc-<user>>/<id>__<name>` — and
// handed to the turn as a `file:` attachment reference, which attachments.ts reads from disk like any other inbound
// file (allow-list, caps, image downscale, the sandbox inbox). A download needs the session and finds a file only
// in the room's folder or in the viewer's OWN private folder, so one person's private upload never reaches another.
// Names are sanitized the way the sandbox inbox sanitizes them; the id is the lookup key, the name is for people.

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AttachmentRef } from '../../attachments.js';
import { sanitizeName } from '../../attachments.js';
import { newId, parseConv } from './keys.js';

export interface StoredFile {
  id: string;
  name: string; // the sanitized name people see and the sandbox gets
  size: number;
  path: string;
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values',
  json: 'application/json', yaml: 'application/yaml', yml: 'application/yaml', log: 'text/plain', rtf: 'application/rtf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
/** The media type of a stored file, from its extension (what the sandbox pipeline and the download header use). */
export function mimeOf(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return MIME[ext] ?? 'application/octet-stream';
}

/** The folder of a conversation's files, or undefined for a conversation the web does not own. */
export function filesDir(root: string, conv: string): string | undefined {
  const p = parseConv(conv);
  if (!p) return undefined;
  return join(root, p.slug, 'files', p.kind === 'room' ? 'room' : `pc-${p.user}`);
}

const SEP = '__';
const ID_RE = /^f[0-9a-z]+$/;

/** Store an upload; returns what the message records and the turn needs. */
export function storeUpload(root: string, conv: string, rawName: string, data: Buffer): StoredFile {
  const dir = filesDir(root, conv);
  if (!dir) throw new Error(`web files: not a web conversation: ${conv}`);
  mkdirSync(dir, { recursive: true });
  const id = newId('f');
  const name = sanitizeName(rawName);
  const path = join(dir, `${id}${SEP}${name}`);
  writeFileSync(path, data, { flag: 'wx' });
  return { id, name, size: data.byteLength, path };
}

/** A stored file by id, looked up in the room's folder and in the viewer's own private folder only. */
export function findUpload(root: string, slug: string, id: string, viewer: string): StoredFile | undefined {
  if (!ID_RE.test(id)) return undefined;
  for (const folder of ['room', `pc-${viewer}`]) {
    const dir = join(root, slug, 'files', folder);
    if (!existsSync(dir)) continue;
    const hit = readdirSync(dir).find((f) => f.startsWith(`${id}${SEP}`));
    if (!hit) continue;
    const path = join(dir, hit);
    return { id, name: hit.slice(id.length + SEP.length), size: statSync(path).size, path };
  }
  return undefined;
}

/** The attachment reference the turn ingests: a `file:` URL attachments.ts reads from disk, no bearer. */
export function toRef(f: StoredFile): AttachmentRef {
  return { name: f.name, url: pathToFileURL(f.path).href, mime: mimeOf(f.name), size: f.size, auth: 'none' };
}

/** A Content-Disposition for a download: an ASCII fallback plus the UTF-8 form, nothing a header could choke on. */
export function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** A size for people: "12 KB", "3.4 MB". */
export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
