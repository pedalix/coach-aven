import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isAbsolute, relative, resolve } from 'node:path';
import sharp from 'sharp';
import { log } from './log.js';

// Attachment ingestion: turn a file that arrived on Slack or a YouTrack ticket into a file
// the in-sandbox Claude Code can actually Read. The heavy lifting downstream is free — Claude
// reads images and PDFs natively — so this module is pure plumbing: decide what's safe to take
// (allowlist + size/count caps + a path-traversal-proof name), download the bytes, and hand
// back a prompt preamble naming the sandbox paths. The sandbox WRITE lives in tasks.ts
// (ChatSession.ingest), which has the sandbox handle; everything here is source-agnostic so
// Slack and YouTrack share one path. Pure functions are unit-tested in attachments.test.ts.

// A source-agnostic reference to one inbound file. Slack (`url_private_download`) and YouTrack
// (`/api/files/...`) both map onto this before ingestion; `url` is always absolute + fetchable
// with the source's bearer token.
export interface AttachmentRef {
  name: string;
  url: string;
  mime: string;
  size: number; // bytes; 0 when the source didn't report it
  // 'none': the URL is pre-authorized (a Teams 1:1 upload, a Graph download URL) and MUST be
  // fetched without the bearer — SharePoint refuses a tempauth URL that also carries one.
  auth?: 'bearer' | 'none';
}

// Caps — deliberately generous but bounded. A per-file byte cap keeps one giant upload from
// blowing the sandbox disk / turn latency; a per-turn count cap bounds the fan-out.
export const MAX_BYTES = 25 * 1024 * 1024; // 25 MB/file
export const MAX_FILES = 10; // files/turn

// MIME allowlist. Claude Code can read images and PDFs directly, and any UTF-8 text. We take
// the common "office"/data documents too (Claude extracts what it can). Everything else —
// audio, video, archives, executables — is refused: it either needs transcription (deferred)
// or is just bytes Claude can't use. Extension is a fallback when the source omits the MIME.
const DOC_EXTS = /\.(pdf|txt|md|markdown|csv|tsv|json|ya?ml|log|docx|xlsx|pptx|rtf)$/i;
export function isSupported(mime: string, name: string): boolean {
  const m = (mime || '').toLowerCase();
  if (m.startsWith('image/')) return true;
  if (m.startsWith('text/')) return true;
  if (m === 'application/pdf') return true;
  if (
    m === 'application/json' ||
    m === 'application/msword' ||
    m.startsWith('application/vnd.openxmlformats-officedocument.')
  )
    return true;
  // No usable MIME → judge by extension (Slack/YouTrack occasionally send octet-stream).
  if (!m || m === 'application/octet-stream') return DOC_EXTS.test(name) || /\.(png|jpe?g|gif|webp|bmp|svg|heic)$/i.test(name);
  return false;
}

// Strip an inbound filename down to a safe *basename*. This is the load-bearing security step:
// `uploadFile` takes a path, so a name like `../../etc/cron.d/x` must never escape the inbox.
// We keep only the final path segment, allow just [A-Za-z0-9._-], collapse runs, and cap the
// length while preserving the extension. Empty/garbage → `file`.
export function sanitizeName(raw: string): string {
  const base = (raw || '').split(/[/\\]/).pop() ?? '';
  let s = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_{2,}/g, '_').replace(/^[._-]+/, '');
  if (!s || s === '.' || s === '..') return 'file';
  if (s.length > 120) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 10 ? s.slice(dot) : '';
    s = s.slice(0, 120 - ext.length) + ext;
  }
  return s;
}

// Per-turn inbox dir + a stable, collision-free path. The `idx` prefix means two files named
// `screenshot.png` in the same turn don't clobber each other.
export function inboxDir(turnId: string): string {
  return `/root/inbox/${turnId}`;
}
export function inboxPath(turnId: string, idx: number, name: string): string {
  return `${inboxDir(turnId)}/${idx}-${sanitizeName(name)}`;
}

// Pure admission control: split refs into what we'll actually download vs. what to skip (and
// why). Enforces the allowlist, the byte cap (when the source reported a size), and the count
// cap. Kept separate from the download so it's trivially testable.
export function planIngest(refs: AttachmentRef[]): {
  accept: AttachmentRef[];
  skipped: { name: string; reason: string }[];
} {
  const accept: AttachmentRef[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const r of refs) {
    if (accept.length >= MAX_FILES) {
      skipped.push({ name: r.name, reason: `over the ${MAX_FILES}-file limit` });
      continue;
    }
    // No URL = the source refused to hand the bytes over (a Slack Connect file whose
    // files.info hydration failed or was denied — see slackfiles.ts). Checked before the
    // type test: a tombstone has no MIME, and 'unsupported type' would mislead.
    if (!r.url) {
      skipped.push({ name: r.name, reason: 'file access not granted' });
      continue;
    }
    if (!isSupported(r.mime, r.name)) {
      skipped.push({ name: r.name, reason: 'unsupported type' });
      continue;
    }
    if (r.size && r.size > MAX_BYTES) {
      skipped.push({ name: r.name, reason: 'too large' });
      continue;
    }
    accept.push(r);
  }
  return { accept, skipped };
}

// The text prepended to the user's prompt so the agent knows the files exist and where to Read
// them. Returns '' when there's nothing to say (no kept files, nothing skipped). Skipped files
// are surfaced so the user isn't left wondering why their .mov was ignored.
export function attachmentPreamble(
  kept: { path: string; name: string }[],
  skipped: { name: string; reason: string }[],
  warnings: string[] = [],
): string {
  const lines: string[] = [];
  if (kept.length) {
    lines.push(
      `The user attached ${kept.length} file(s), saved in this sandbox. Read them with your Read tool if relevant to the request:`,
      ...kept.map((k) => `- ${k.path}  (${k.name})`),
    );
  }
  if (skipped.length) {
    lines.push(`(Skipped: ${skipped.map((s) => `${s.name} — ${s.reason}`).join('; ')}.)`);
  }
  for (const w of warnings) lines.push(`(Note: ${w})`);
  return lines.join('\n');
}

// The user-facing counterpart of the preamble's skip list: a polite Slack (mrkdwn) notice
// posted DETERMINISTICALLY into the thread by the turn engine. The preamble only informs the
// AGENT — whether the model relays a skip is up to it; users get a guaranteed answer, with
// each machine reason expanded to something actionable. '' when nothing was skipped.
export function skippedNotice(skipped: { name: string; reason: string }[]): string {
  if (!skipped.length) return '';
  const friendly: Record<string, string> = {
    'unsupported type': 'an unsupported file type — I can read images, PDFs, and text/data/office documents',
    'too large': `over my ${Math.round(MAX_BYTES / 1024 / 1024)} MB per-file limit`,
    'file access not granted':
      "Slack didn't grant me access to it (this can happen in Slack Connect channels) — re-uploading it or pasting the content works",
    'download failed': 'not downloadable from Slack just now — please try uploading it again',
  };
  return [
    `📎 Sorry — I couldn't read ${skipped.length === 1 ? 'this file' : 'these files'}:`,
    ...skipped.map((s) => `• \`${s.name}\` — ${friendly[s.reason] ?? s.reason}`),
  ].join('\n');
}

// The in-sandbox Claude Code `Read` tool rejects images whose pixel dimensions exceed 2000×2000
// (empirically: "dimensions exceed the 2000x2000px limit"). We normalize the long edge to 1568px
// — the value the Anthropic API downsamples to anyway, so nothing the model would have seen is
// lost, and it stays comfortably under the Read cap while shrinking the sandbox upload.
export const MAX_IMAGE_DIM = 1568;

// Is this attachment a raster image we should try to normalize? (SVG is text Claude reads as-is;
// PDFs/docs are handled by Read directly.) MIME first, extension as the octet-stream fallback.
export function isImage(mime: string, name: string): boolean {
  const m = (mime || '').toLowerCase();
  if (m.startsWith('image/') && m !== 'image/svg+xml') return true;
  if (!m || m === 'application/octet-stream') return /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif)$/i.test(name);
  return false;
}

// Pure: does an image at these dimensions need downscaling to fit the Read cap? Kept separate so
// the threshold logic is unit-tested without decoding a real image.
export function needsResize(width: number, height: number, max: number = MAX_IMAGE_DIM): boolean {
  return width > max || height > max;
}

// Downscale an oversized image so the agent's first Read succeeds. Only shrinks (never enlarges),
// preserves aspect ratio + format, and applies EXIF orientation. Returns the ORIGINAL bytes
// untouched when the image is already within the cap (no needless re-encode / quality loss), and
// on ANY failure returns the original with failed=true so the caller can (a) still deliver the
// file and (b) warn that it may be too large — the sandbox `magick` tool is the recovery path.
export async function normalizeImage(
  buf: Buffer,
  max: number = MAX_IMAGE_DIM,
): Promise<{ buf: Buffer; failed: boolean }> {
  try {
    const img = sharp(buf, { failOn: 'none' });
    const meta = await img.metadata();
    if (!meta.width || !meta.height) return { buf, failed: false }; // can't tell → leave as-is
    if (!needsResize(meta.width, meta.height, max)) return { buf, failed: false };
    const out = await img
      .rotate() // bake in EXIF orientation before we strip it via resize
      .resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true })
      .toBuffer();
    return { buf: out, failed: false };
  } catch {
    return { buf, failed: true };
  }
}

// Fetch one attachment's bytes with the source's bearer token. Returns null on any failure or
// if the payload exceeds MAX_BYTES (checked both via Content-Length and the actual body, since
// the header can lie or be absent) — the caller records it as skipped and carries on, mirroring
// the "degrade quietly" philosophy of listComments.
export function downloadHeaders(ref: AttachmentRef, bearer: string): Record<string, string> {
  return ref.auth === 'none' ? {} : { Authorization: `Bearer ${bearer}` };
}
// Null = skipped as "download failed"; the journal says why (the person only sees the skip). The host,
// never the URL: a download URL carries a temporary token. A Slack 403/redirect here means the bot
// token lacks `files:read` (the manifest has it; an app installed before it was added must be reinstalled).
// Where `file:` references may point: the directories a surface that stores uploads itself registers (the web
// chat's files root). A `file:` URL outside them — or any at all while no surface registered a root — is refused,
// so a reference relayed from a platform payload can never make the bot read its own disk into a sandbox.
const localRoots: string[] = [];
export function allowLocalFiles(root: string): void {
  const r = resolve(root);
  if (!localRoots.includes(r)) localRoots.push(r);
}
function underLocalRoot(path: string): boolean {
  const abs = resolve(path);
  return localRoots.some((root) => {
    const rel = relative(root, abs);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  });
}

export async function downloadAttachment(ref: AttachmentRef, bearer: string): Promise<Buffer | null> {
  // A file the bot already holds (the web chat's uploads, OpenSpec web-chat-driver D7): read it from disk,
  // under the same cap — no HTTP round trip to ourselves — and only from a registered root (allowLocalFiles).
  if (ref.url.startsWith('file:')) {
    try {
      const path = fileURLToPath(ref.url);
      if (!underLocalRoot(path)) {
        log.warn(`attachments: ${ref.name}: a file: reference outside the registered upload roots — refused`);
        return null;
      }
      const st = await stat(path);
      if (st.size > MAX_BYTES) {
        log.warn(`attachments: ${ref.name}: ${st.size} bytes, over the ${MAX_BYTES}-byte cap`);
        return null;
      }
      return await readFile(path);
    } catch (e) {
      log.warn(`attachments: ${ref.name}: cannot read the stored file — ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }
  const host = (() => {
    try {
      return new URL(ref.url).host;
    } catch {
      return '(not a url)';
    }
  })();
  const res = await fetch(ref.url, { headers: downloadHeaders(ref, bearer) });
  if (!res.ok) {
    log.warn(`attachments: ${ref.name}: HTTP ${res.status} from ${host}${res.status === 403 && host.endsWith('slack.com') ? ' — does the bot token have files:read?' : ''}`);
    return null;
  }
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    log.warn(`attachments: ${ref.name}: ${declared} bytes declared, over the ${MAX_BYTES}-byte cap`);
    return null;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) {
    log.warn(`attachments: ${ref.name}: ${buf.byteLength} bytes, over the ${MAX_BYTES}-byte cap`);
    return null;
  }
  return buf;
}
