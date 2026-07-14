// Slack file objects → AttachmentRefs, including the Slack Connect hydration dance.
//
// In a workspace-local channel a message event carries full file objects (name, mimetype,
// url_private_download). In a Slack Connect (ext-shared) channel it carries TOMBSTONES
// instead — `{ id, file_access: 'check_file_info', filetype }`, no name/mime/url (observed
// live on prod, 2026-07-14) — and the app must call `files.info` with its own bot token,
// which both runs Slack's cross-org access check and returns the real download URL.
//
// This module is deliberately Slack-API-free (CLAUDE.md rule): shape normalization and the
// hydration algorithm are pure, with the `files.info` call injected — see slackfiles.test.ts.
// A tombstone that can't be hydrated keeps `url: ''`; planIngest (attachments.ts) turns that
// into a visible "skipped" note instead of the silent drop that used to swallow these files.

import type { AttachmentRef } from './attachments.js';

// One normalized inbound file. `url` is '' for a tombstone awaiting (or refused) hydration;
// `id` is what files.info needs.
export interface SlackFile extends AttachmentRef {
  id?: string;
}

// Fetch one file's full record by id (events.ts binds this to the envelope workspace's
// `client.files.info`). Resolve null on any failure — the caller degrades, never throws.
export type FileInfoFn = (id: string) => Promise<unknown | null>;

// Normalize one raw Slack file object. Returns null for true junk (nothing to fetch, nothing
// to name): external/link "files" with neither a URL nor an id. We prefer
// `url_private_download` (raw bytes) over `url_private`. A tombstone's name falls back to
// `<id>.<filetype>` so a later skip note still identifies the file.
export function toSlackFile(f: unknown): SlackFile | null {
  const o = (f ?? {}) as {
    id?: string;
    url_private_download?: string;
    url_private?: string;
    name?: string;
    title?: string;
    mimetype?: string;
    size?: number;
    filetype?: string;
  };
  const url = o.url_private_download || o.url_private || '';
  if (!url && !o.id) return null;
  const fallback = o.id ? (o.filetype ? `${o.id}.${o.filetype}` : o.id) : 'file';
  return {
    id: o.id,
    name: o.name || o.title || fallback,
    url,
    mime: o.mimetype ?? '',
    size: o.size ?? 0,
  };
}

// The sync half: raw `files` array off a message event → normalized SlackFiles, tombstones
// included. Cheap on purpose — presence (`.length`) gates the handlers' engage/nag decisions,
// so this runs on every file-bearing message while hydration waits until we've decided to act.
export function extractSlackFiles(files: unknown[]): SlackFile[] {
  const out: SlackFile[] = [];
  for (const f of files) {
    const s = toSlackFile(f);
    if (s) out.push(s);
  }
  return out;
}

// The async half, called only once a handler has claimed the event: resolve tombstones via
// files.info. Files that already carry a URL pass through untouched (zero API calls — the
// common same-workspace case). A tombstone whose lookup fails or comes back still URL-less
// (e.g. the other org's admin denied file access) is KEPT with `url: ''` so the user learns
// it was skipped rather than wondering why their upload vanished.
export async function hydrateSlackFiles(files: SlackFile[], info: FileInfoFn): Promise<AttachmentRef[]> {
  return Promise.all(
    files.map(async (f): Promise<AttachmentRef> => {
      if (f.url || !f.id) return f;
      const raw = await info(f.id).catch(() => null);
      const h = raw ? toSlackFile(raw) : null;
      return h?.url ? h : f;
    }),
  );
}
