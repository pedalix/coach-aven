// Granola Personal API (Business/Enterprise plans): https://docs.granola.ai/introduction
//   GET /v1/notes?created_after=…&cursor=…   → { notes:[{id,title,created_at,updated_at,owner}], hasMore, cursor }
//   GET /v1/notes/{id}?include=transcript    → full note (summary_markdown, attendees, transcript[])
// Limits: burst 25 requests / 5 s, sustained 5 rps → we pace at 250 ms. Only notes with a
// generated summary + transcript are returned (a note still processing is simply absent and
// shows up on a later run). Token: `{ "token": "grn_…" }` in ~/.config/coach-aven/sources/<slug>/granola.json.
import { createHttp, TrackerHttpError, type Http } from '../trackers/http.js';
import { readTokenFile } from '../trackers/writer.js';
import type { PullContext } from '../types.js';
import { normaliseGranolaNote } from './normalise.js';
import { MeetingWriter, meetingDir, needsFetch, readMeetingCursor, writeMeetingCursor } from './writer.js';

export const GRANOLA_API = 'https://public-api.granola.ai/v1';

export function granolaHttp(token: string, fetchImpl?: typeof fetch): Http {
  return createHttp({ headers: { Authorization: `Bearer ${token}` }, minIntervalMs: 250, baseBackoffMs: 5000, ...(fetchImpl ? { fetchImpl } : {}) });
}

export function readGranolaToken(path: string): string | undefined {
  const t = readTokenFile<{ token?: string }>(path)?.token;
  return t && t.trim() ? t.trim() : undefined;
}

type Rec = Record<string, unknown>;

export interface GranolaPullResult {
  account: string;
  count: number;
  withheld: number;
  reauth: boolean;
  error?: string;
}

export async function pullGranola(ctx: PullContext, tokenPath: string, o: { since?: string; full?: boolean; fetchImpl?: typeof fetch; now?: () => Date } = {}): Promise<GranolaPullResult> {
  const token = readGranolaToken(tokenPath);
  if (!token) return { account: 'granola', count: 0, withheld: 0, reauth: true, error: `no token in ${tokenPath} — run: orch sources auth ${ctx.slug} meetings granola add` };
  const http = granolaHttp(token, o.fetchImpl);
  const now = o.now ?? (() => new Date());
  // One cursor for the token (notes are the token owner's); the account directory is named
  // after the owner e-mail once we have seen one.
  const dir0 = meetingDir(ctx.outDir, 'granola', 'granola');
  const cursor = readMeetingCursor(dir0);
  const writer = new MeetingWriter(ctx, dir0);
  let account = 'granola';
  try {
    let page: string | undefined;
    const createdAfter = o.since ? `${o.since}T00:00:00Z` : undefined;
    do {
      const qs = new URLSearchParams();
      if (createdAfter) qs.set('created_after', createdAfter);
      if (page) qs.set('cursor', page);
      const res = (await http.get(`${GRANOLA_API}/notes${qs.size ? `?${qs}` : ''}`)).json as Rec;
      const notes = (Array.isArray(res?.notes) ? res.notes : Array.isArray(res?.data) ? res.data : []) as Rec[];
      for (const n of notes) {
        const id = String(n.id ?? '');
        if (!id) continue;
        const version = String(n.updated_at ?? n.created_at ?? '');
        if (!needsFetch(cursor, id, version, o.full)) continue;
        let full: Rec;
        try {
          full = (await http.get(`${GRANOLA_API}/notes/${encodeURIComponent(id)}?include=transcript`)).json as Rec;
        } catch (e) {
          // 404 = summary/transcript not generated yet — retry on a later run.
          if (e instanceof TrackerHttpError && e.status === 404) continue;
          throw e;
        }
        const m = normaliseGranolaNote(full);
        if (m.account !== 'granola') account = m.account;
        writer.write(m);
        cursor.seen[id] = version;
      }
      page = (res?.hasMore ?? res?.has_more) ? String(res?.cursor ?? res?.next_cursor ?? '') || undefined : undefined;
    } while (page);
    writeMeetingCursor(dir0, { seen: cursor.seen, lastRunAt: now().toISOString() });
    ctx.log(`granola/${account}: ${writer.count} meetings${writer.withheld ? ` (${writer.withheld} with withheld bodies)` : ''}`);
    return { account, count: writer.count, withheld: writer.withheld, reauth: false };
  } catch (e) {
    // Keep what landed; the cursor only records notes actually written (seen map is per id).
    writeMeetingCursor(dir0, { seen: cursor.seen, lastRunAt: now().toISOString() });
    const reauth = e instanceof TrackerHttpError && e.reauth;
    return { account, count: writer.count, withheld: writer.withheld, reauth, error: e instanceof Error ? e.message : String(e) };
  }
}

/** `check`: one cheap list call. */
export async function checkGranola(tokenPath: string, fetchImpl?: typeof fetch): Promise<{ ok: boolean; line: string }> {
  const token = readGranolaToken(tokenPath);
  if (!token) return { ok: false, line: `granola: no token in ${tokenPath}` };
  try {
    const res = (await granolaHttp(token, fetchImpl).get(`${GRANOLA_API}/notes?page_size=1`)).json as Rec;
    const n = Array.isArray(res?.notes) ? res.notes.length : 0;
    return { ok: true, line: `granola: ok (${n ? 'notes visible' : 'no notes yet'})` };
  } catch (e) {
    return { ok: false, line: `granola: ${e instanceof Error ? e.message : String(e)}` };
  }
}
