// Inbound files on Teams (design D7): three shapes, three ways to the bytes, one AttachmentRef
// each for the shared ingest pipeline (attachments.ts):
// - a 1:1 upload: `application/vnd.microsoft.teams.file.download.info` with a pre-authorized
//   `content.downloadUrl` (fetched WITHOUT the bearer — SharePoint refuses a tempauth URL that
//   also carries one); needs `supportsFiles` in the manifest;
// - a pasted image, any scope: `image/*` whose `contentUrl` is readable with the bot token;
// - a document in a channel or group chat: `reference` with the SharePoint `contentUrl` — the
//   bytes come through Graph (`/shares/{url}/driveItem`, application permission Files.Read.All
//   consented in the tenant) as a pre-authorized download URL.
// `teamsFiles` is the sync, presence-only classification (every activity passes through it);
// `hydrateTeamsFiles` runs only once the core decided to act on the message.

import type { AttachmentRef } from '../../attachments.js';
import { log } from '../../log.js';

export interface InboundAttachment {
  contentType?: string;
  contentUrl?: string;
  name?: string;
  content?: unknown;
}

export type TeamsFile =
  | { kind: 'download'; name: string; url: string; mime: string }
  | { kind: 'image'; name: string; url: string; mime: string }
  | { kind: 'reference'; name: string; url: string; mime: string };

const DOWNLOAD_INFO = 'application/vnd.microsoft.teams.file.download.info';

// MIME from Teams' `fileType` (an extension) or a name; '' lets the allowlist fall back to the
// extension itself.
const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const mimeOf = (name: string, fileType?: string): string => MIME[(fileType ?? name.split('.').pop() ?? '').toLowerCase()] ?? '';

export function teamsFiles(attachments: InboundAttachment[] | undefined): TeamsFile[] {
  const out: TeamsFile[] = [];
  let images = 0;
  for (const a of attachments ?? []) {
    const ct = (a.contentType ?? '').toLowerCase();
    const c = (a.content ?? {}) as { downloadUrl?: string; fileType?: string };
    if (ct === DOWNLOAD_INFO && c.downloadUrl) {
      const name = a.name ?? 'file';
      out.push({ kind: 'download', name, url: c.downloadUrl, mime: mimeOf(name, c.fileType) });
    } else if (ct.startsWith('image/') && a.contentUrl && !a.contentUrl.startsWith('data:')) {
      // Teams names pasted images `image/*`; the bytes say what they are, the pipeline wants a
      // concrete type to accept them — PNG is what the paste path produces.
      const mime = ct === 'image/*' ? 'image/png' : ct;
      const ext = mime.split('/')[1] ?? 'png';
      out.push({ kind: 'image', name: a.name ?? `pasted-image-${++images}.${ext}`, url: a.contentUrl, mime });
    } else if (ct === 'reference' && a.contentUrl) {
      const name = a.name ?? decodeURIComponent(a.contentUrl.split('/').pop() ?? 'file');
      out.push({ kind: 'reference', name, url: a.contentUrl, mime: mimeOf(name, c.fileType) });
    }
    // text/html (the message body echo), cards and the rest are not files.
  }
  return out;
}

export interface FileTokens {
  // The bot's own token (the Connector's): reads pasted images.
  botToken(): Promise<string | undefined>;
  // An application Graph token for the tenant: resolves channel documents; undefined when the
  // tenant has not consented Files.Read.All (the file is then reported as not readable).
  graphToken(): Promise<string | undefined>;
}

// Graph: a sharing URL → the drive item (name, size, pre-authorized download URL). The share
// id is `u!` + base64url(url) without padding (Graph's "encoded sharing URL").
export const shareId = (url: string): string => `u!${Buffer.from(url, 'utf8').toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-')}`;

export async function resolveShare(url: string, graphToken: string, fetchFn: typeof fetch = fetch): Promise<{ name?: string; size?: number; mime?: string; downloadUrl?: string } | undefined> {
  const res = await fetchFn(`https://graph.microsoft.com/v1.0/shares/${shareId(url)}/driveItem`, { headers: { Authorization: `Bearer ${graphToken}` } });
  if (!res.ok) {
    log.warn(`teams files: Graph refused ${url.slice(0, 80)}…: HTTP ${res.status}`);
    return undefined;
  }
  const item = (await res.json()) as { name?: string; size?: number; file?: { mimeType?: string }; '@microsoft.graph.downloadUrl'?: string };
  return { name: item.name, size: item.size, mime: item.file?.mimeType, downloadUrl: item['@microsoft.graph.downloadUrl'] };
}

// The refs for the ingest pipeline; the bearer that goes with them is the bot token (the only
// URL kind that needs one). A file whose bytes cannot be reached keeps an empty url, which the
// pipeline reports as "file access not granted" — the person sees why, the turn goes on.
export async function hydrateTeamsFiles(files: TeamsFile[], tokens: FileTokens, fetchFn: typeof fetch = fetch): Promise<{ refs: AttachmentRef[]; bearer: string }> {
  const refs: AttachmentRef[] = [];
  const bearer = (await tokens.botToken().catch(() => undefined)) ?? '';
  let graph: string | undefined | null = null; // null: not asked yet
  for (const f of files) {
    if (f.kind === 'download') refs.push({ name: f.name, url: f.url, mime: f.mime, size: 0, auth: 'none' });
    else if (f.kind === 'image') refs.push({ name: f.name, url: bearer ? f.url : '', mime: f.mime, size: 0 });
    else {
      if (graph === null) graph = await tokens.graphToken().catch(() => undefined);
      const item = graph ? await resolveShare(f.url, graph, fetchFn).catch(() => undefined) : undefined;
      refs.push({ name: item?.name ?? f.name, url: item?.downloadUrl ?? '', mime: item?.mime ?? f.mime, size: item?.size ?? 0, auth: 'none' });
    }
  }
  return { refs, bearer };
}
