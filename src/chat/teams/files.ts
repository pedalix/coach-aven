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

import { createHash } from 'node:crypto';
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

// An emoji or a sticker in the text arrives as one more `image/*` attachment, served from the Teams
// client's static CDN — the person's message, not a file they sent (the canary saw the ✅ of a
// message land in the sandbox as "pasted-image-2.png").
const CLIENT_ASSET_HOSTS = new Set(['statics.teams.cdn.office.net', 'statics.teams.microsoft.com']);
export function isClientAsset(url: string): boolean {
  try {
    return CLIENT_ASSET_HOSTS.has(new URL(url).host);
  } catch {
    return false;
  }
}

export function teamsFiles(attachments: InboundAttachment[] | undefined): TeamsFile[] {
  const out: TeamsFile[] = [];
  let images = 0;
  for (const a of attachments ?? []) {
    const ct = (a.contentType ?? '').toLowerCase();
    const c = (a.content ?? {}) as { downloadUrl?: string; fileType?: string };
    if (ct === DOWNLOAD_INFO && c.downloadUrl) {
      const name = a.name ?? 'file';
      out.push({ kind: 'download', name, url: c.downloadUrl, mime: mimeOf(name, c.fileType) });
    } else if (ct.startsWith('image/') && a.contentUrl && !a.contentUrl.startsWith('data:') && !isClientAsset(a.contentUrl)) {
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

/**
 * The shape of an inbound activity for the journal (TEAMS_TRACE=1, app.ts): type, scope, how long the text
 * is and whether it carries an `<attachment>` tag, the entity types, the `channelData` keys, and per
 * attachment the content type, name, the host of `contentUrl` and a short hash of it, the keys of `content` — and for the
 * `text/html` echo the tags it is made of, as tag names with their attribute NAMES (`attachment[id]`,
 * `img[src]`): a file the client embeds as markup shows up there. Enough to see what Teams sent for a file
 * the driver ignored; never the text itself, never an attribute value, never a URL (download URLs carry
 * a temporary auth token).
 */
export function activityShape(body: unknown): string {
  if (typeof body !== 'object' || body === null) return JSON.stringify(String(body));
  const a = body as { type?: string; name?: string; conversation?: { conversationType?: string }; text?: string; attachments?: InboundAttachment[]; entities?: { type?: string }[]; channelData?: Record<string, unknown> & { team?: Record<string, unknown> } };
  const host = (url: string | undefined): string | undefined => {
    if (!url) return undefined;
    try {
      return new URL(url).host;
    } catch {
      return url.startsWith('data:') ? 'data:' : '(not a url)';
    }
  };
  const attachments = (a.attachments ?? []).map((x) => ({
    contentType: x.contentType,
    name: x.name,
    contentUrl: host(x.contentUrl),
    // The same URL twice shows as the same hash (a client re-sending the previous image) — not the URL.
    ...(x.contentUrl ? { urlHash: createHash('sha1').update(x.contentUrl).digest('hex').slice(0, 8) } : {}),
    content: x.content && typeof x.content === 'object' ? Object.keys(x.content as object) : typeof x.content,
    ...(x.contentType === 'text/html' && typeof x.content === 'string' ? { html: htmlTags(x.content) } : {}),
  }));
  const text = a.text ?? '';
  return JSON.stringify({
    type: a.type,
    ...(a.name ? { name: a.name } : {}),
    scope: a.conversation?.conversationType,
    textLength: text.length,
    attachmentTag: /<attachment\b/i.test(text),
    entities: (a.entities ?? []).map((e) => e.type ?? '?'),
    channelData: a.channelData && typeof a.channelData === 'object' ? Object.keys(a.channelData) : [],
    // The team's keys: whether `aadGroupId` travels with the activity (the read-back needs it).
    team: a.channelData?.team && typeof a.channelData.team === 'object' ? Object.keys(a.channelData.team) : [],
    attachments,
  });
}

// The tags of an HTML body as `name` or `name[attr,attr]`, in order, duplicates dropped: the markup's
// shape without any of its text or attribute values.
export function htmlTags(html: string): string[] {
  const seen = new Set<string>();
  for (const m of html.matchAll(/<([a-zA-Z][\w:-]*)((?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g)) {
    const attrs = [...(m[2] ?? '').matchAll(/([\w:-]+)(?:\s*=|\s|$)/g)].map((x) => x[1]!.toLowerCase());
    seen.add(attrs.length ? `${m[1]!.toLowerCase()}[${attrs.join(',')}]` : m[1]!.toLowerCase());
  }
  return [...seen];
}

export interface FileTokens {
  // The bot's own token (the Connector's): reads pasted images.
  botToken(): Promise<string | undefined>;
  // An application Graph token for the tenant: resolves channel documents; undefined when the
  // tenant has not consented Files.Read.All (the file is then reported as not readable).
  graphToken(): Promise<string | undefined>;
  // The fetch to use (tests inject a fake); global fetch otherwise.
  fetch?: typeof fetch;
  // The team's Microsoft 365 group id for a Teams team id (`19:…@thread.tacv2`), through the Connector's
  // team details — for an activity whose `channelData.team` has no `aadGroupId` (the read-back needs
  // the group id). Cached by app.ts; absent in the pure tests.
  groupIdOf?(teamId: string): Promise<string | undefined>;
}

/**
 * Where Teams does NOT put a channel upload (seen 2026-10-19 on a real tenant, design D7 amended): the
 * activity for a message with a file attached through the paperclip in a channel — a reply or a
 * mention — carries neither the `reference` attachment nor the `<attachment>` tag in its text; the same
 * message read through Graph has both. So a channel message that arrived without files is read back
 * with the app's Graph token (RSC `ChannelMessage.Read.Group`, granted when the app was added to the
 * team) and its `reference` attachments become the channel-document shape `hydrateTeamsFiles` already
 * resolves through `/shares`. A refusal (no RSC consent, a message gone) is one warning and no files.
 *
 * Teams delivers the activity BEFORE the upload is attached to the message in Graph (the canary's first
 * read-back came back empty; the same message had the file a minute later), so an empty answer is read
 * again after a pause, a few times (READ_BACK_DELAYS_MS) — a message that really has no file costs the
 * last delay, a few seconds, once. Every read-back logs its outcome: the journal is the only place that
 * says how often Teams leaves a file out and how late Graph is.
 */
export const READ_BACK_DELAYS_MS = [0, 2000, 5000];
export type Sleep = (ms: number) => Promise<void>;
const sleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export interface ChannelMessageRef {
  groupId: string; // channelData.team.aadGroupId — the team's Microsoft 365 group
  channelId: string; // `19:…@thread.tacv2`
  rootId: string; // the thread's root message
  messageId: string; // the message itself; equal to rootId for a root message
}
export async function channelMessageFiles(ref: ChannelMessageRef, graphToken: string, fetchFn: typeof fetch = fetch, wait: Sleep = sleep, delays: number[] = READ_BACK_DELAYS_MS): Promise<TeamsFile[]> {
  const root = `https://graph.microsoft.com/v1.0/teams/${ref.groupId}/channels/${encodeURIComponent(ref.channelId)}/messages/${ref.rootId}`;
  const url = `${ref.messageId === ref.rootId ? root : `${root}/replies/${ref.messageId}`}?$select=id,attachments`;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt]! > 0) await wait(delays[attempt]!);
    let res: Response;
    try {
      res = await fetchFn(url, { headers: { Authorization: `Bearer ${graphToken}` } });
    } catch (e) {
      log.warn(`teams files: Graph read-back of ${ref.messageId} failed (attempt ${attempt + 1}): ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (res.status === 404) {
      // Not there yet, or gone: the next attempt tells which.
      log.info(`teams files: Graph read-back of ${ref.messageId}: not found yet (attempt ${attempt + 1})`);
      continue;
    }
    if (!res.ok) {
      log.warn(`teams files: Graph refused the channel message ${ref.messageId}: HTTP ${res.status}`);
      return [];
    }
    const m = (await res.json()) as { attachments?: { contentType?: string | null; contentUrl?: string | null; name?: string | null }[] | null };
    const all = m.attachments ?? [];
    const files = teamsFiles(all.map((a) => ({ contentType: a.contentType ?? undefined, contentUrl: a.contentUrl ?? undefined, name: a.name ?? undefined })));
    log.info(`teams files: Graph read-back of ${ref.messageId}: ${all.length} attachment(s), ${files.length} file(s) (attempt ${attempt + 1})`);
    if (files.length) return files;
  }
  return [];
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
