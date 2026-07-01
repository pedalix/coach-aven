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
  return lines.join('\n');
}

// Fetch one attachment's bytes with the source's bearer token. Returns null on any failure or
// if the payload exceeds MAX_BYTES (checked both via Content-Length and the actual body, since
// the header can lie or be absent) — the caller records it as skipped and carries on, mirroring
// the "degrade quietly" philosophy of listComments.
export async function downloadAttachment(ref: AttachmentRef, bearer: string): Promise<Buffer | null> {
  const res = await fetch(ref.url, { headers: { Authorization: `Bearer ${bearer}` } });
  if (!res.ok) return null;
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_BYTES) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) return null;
  return buf;
}
