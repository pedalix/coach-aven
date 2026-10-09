// Gemini meeting notes ("Take notes for me" in Google Meet). Each call that Gemini noted produces
// a Google Doc "<title> – YYYY/MM/DD HH:MM TZ – Notes by Gemini", shared with the invitees, plus a
// "Notes: …" mail from gemini-notes@google.com. The DOC is the meeting of record (one meeting per
// notes doc): it has the summary, the next steps and — when transcription was on — the transcript
// tab; the mail only repeats the summary. So: Drive search for those docs, export as text/plain,
// normalise. Uses the project's google token (drive.readonly is already granted for the Drive
// puller) — no extra consent.
import { HttpError, ReauthRequired, Tokens, gfetch, gjson, loadStore, withQuery } from '../google/client.js';
import type { PullContext } from '../types.js';
import { normaliseGeminiDoc } from './normalise.js';
import { MeetingWriter, meetingDir, needsFetch, readMeetingCursor, writeMeetingCursor } from './writer.js';

const DRIVE = 'https://www.googleapis.com/drive/v3';
export const GEMINI_DOC_QUERY = "name contains 'Notes by Gemini' and mimeType = 'application/vnd.google-apps.document' and trashed = false";

export function geminiQuery(sinceIso?: string): string {
  return sinceIso ? `${GEMINI_DOC_QUERY} and modifiedTime > '${sinceIso}'` : GEMINI_DOC_QUERY;
}

interface DriveFile {
  id: string;
  name: string;
  modifiedTime?: string;
  webViewLink?: string;
}

export interface GmeetPullResult {
  account: string;
  count: number;
  withheld: number;
  reauth: boolean;
  error?: string;
}

export async function pullGmeet(ctx: PullContext, googleTokenPath: string, account: string, o: { since?: string; full?: boolean; now?: () => Date } = {}): Promise<GmeetPullResult> {
  const store = loadStore(googleTokenPath);
  const acct = account.toLowerCase();
  if (!store.accounts[acct]) return { account: acct, count: 0, withheld: 0, reauth: true, error: `no google credentials for ${acct} — run: orch sources auth ${ctx.slug} google login --account ${acct}` };
  const tokens = new Tokens(store);
  const now = o.now ?? (() => new Date());
  const dir = meetingDir(ctx.outDir, 'gmeet', acct);
  const cursor = readMeetingCursor(dir);
  const writer = new MeetingWriter(ctx, dir);
  try {
    let pageToken: string | undefined;
    const since = o.since ? new Date(`${o.since}T00:00:00Z`).toISOString() : undefined;
    do {
      const url = withQuery(`${DRIVE}/files`, {
        q: geminiQuery(since),
        fields: 'nextPageToken, files(id, name, modifiedTime, webViewLink)',
        pageSize: 100,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        orderBy: 'modifiedTime desc',
        ...(pageToken ? { pageToken } : {}),
      });
      const res = await gjson<{ files?: DriveFile[]; nextPageToken?: string }>(tokens, acct, url);
      for (const f of res.files ?? []) {
        const version = f.modifiedTime ?? '';
        if (!needsFetch(cursor, f.id, version, o.full)) continue;
        const exp = await gfetch(tokens, acct, withQuery(`${DRIVE}/files/${encodeURIComponent(f.id)}/export`, { mimeType: 'text/plain' }));
        const text = await exp.text(); // the one read
        if (!exp.ok) {
          if (exp.status === 403 || exp.status === 404) {
            ctx.log(`  gmeet/${acct}: cannot export ${f.name} (HTTP ${exp.status}) — skipped`);
            cursor.seen[f.id] = version;
            continue;
          }
          throw new HttpError(exp.status, `${DRIVE}/files/${f.id}/export`, text);
        }
        const m = normaliseGeminiDoc({ id: f.id, name: f.name, ...(f.modifiedTime ? { modified: f.modifiedTime } : {}), ...(f.webViewLink ? { link: f.webViewLink } : {}) }, text, acct);
        if (!m) {
          ctx.log(`  gmeet/${acct}: unrecognised notes doc name "${f.name}" — skipped`);
          cursor.seen[f.id] = version;
          continue;
        }
        writer.write(m);
        cursor.seen[f.id] = version;
      }
      pageToken = res.nextPageToken;
    } while (pageToken);
    writeMeetingCursor(dir, { seen: cursor.seen, lastRunAt: now().toISOString() });
    ctx.log(`gmeet/${acct}: ${writer.count} meetings`);
    return { account: acct, count: writer.count, withheld: writer.withheld, reauth: false };
  } catch (e) {
    writeMeetingCursor(dir, { seen: cursor.seen, lastRunAt: now().toISOString() });
    return { account: acct, count: writer.count, withheld: writer.withheld, reauth: e instanceof ReauthRequired, error: e instanceof Error ? e.message : String(e) };
  }
}
