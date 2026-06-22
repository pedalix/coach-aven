import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// MVP state store: a single JSON file mapping projects → their warm sandbox, plus
// chat-thread → Claude-session bindings. Swap for SQLite later if concurrency demands
// it. Writes are atomic-ish (write whole file each mutation; single-process for now).

export interface ProjectRecord {
  slug: string;
  repo: string; // primary repo, "Org/name"
  sandboxName: string;
  clonedAt?: string;
}

// A chat thread (e.g. a Slack thread) bound to a project's Claude session. Lets a
// restarted bot resume the same conversation via `--resume <sessionId>`.
export interface ChatRecord {
  threadTs: string;
  slug: string;
  sessionId?: string; // Claude conversation id (for --resume)
  // The Daytona session-command driving this thread's persistent claude process. Lets a
  // restarted bot REATTACH to it (it keeps running in the sandbox) instead of spawning a
  // duplicate — see ClaudeSession.attach.
  sessionKey?: string;
  cmdId?: string;
  // A turn whose Slack status message was still "Working…" when the bot last wrote state.
  // On startup the bot reattaches and finalizes this message with the recovered result —
  // see resumeInflightTurns. Cleared when the turn completes.
  inflight?: { channel: string; statusTs: string; msgThreadTs?: string; startedAt: string };
  updatedAt: string;
}

interface StateShape {
  projects: Record<string, ProjectRecord>;
  chats?: Record<string, ChatRecord>;
}

const STATE_PATH = new URL('../state.json', import.meta.url).pathname;

export class Store {
  private data: StateShape;

  constructor() {
    this.data = existsSync(STATE_PATH)
      ? (JSON.parse(readFileSync(STATE_PATH, 'utf8')) as StateShape)
      : { projects: {} };
  }

  private save() {
    writeFileSync(STATE_PATH, JSON.stringify(this.data, null, 2) + '\n');
  }

  getProject(slug: string): ProjectRecord | undefined {
    return this.data.projects[slug];
  }

  upsertProject(slug: string, repo: string): ProjectRecord {
    const existing = this.data.projects[slug];
    if (existing) {
      existing.repo = repo;
      this.save();
      return existing;
    }
    const rec: ProjectRecord = {
      slug,
      repo,
      sandboxName: `proj-${slug}`,
    };
    this.data.projects[slug] = rec;
    this.save();
    return rec;
  }

  setProject(rec: ProjectRecord) {
    this.data.projects[rec.slug] = rec;
    this.save();
  }

  getChat(threadTs: string): ChatRecord | undefined {
    return this.data.chats?.[threadTs];
  }

  allChats(): ChatRecord[] {
    return Object.values(this.data.chats ?? {});
  }

  setChat(rec: ChatRecord) {
    (this.data.chats ??= {})[rec.threadTs] = rec;
    this.save();
  }

  // Merge a partial update into a chat record (creating it if absent) without clobbering
  // fields written by a different code path. A key set to `undefined` is deleted. Several
  // concerns touch one record concurrently — sessionId (persist), sessionKey/cmdId (open),
  // inflight (turn start/end) — so they must merge, not overwrite.
  patchChat(threadTs: string, slug: string, patch: Partial<ChatRecord>) {
    const chats = (this.data.chats ??= {});
    const cur = chats[threadTs] ?? { threadTs, slug, updatedAt: '' };
    const next = { ...cur, ...patch, threadTs, slug, updatedAt: new Date().toISOString() };
    for (const k of Object.keys(patch) as (keyof ChatRecord)[]) {
      if (patch[k] === undefined) delete next[k];
    }
    chats[threadTs] = next;
    this.save();
  }
}
