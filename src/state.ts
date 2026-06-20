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
  sessionId?: string; // Claude conversation id
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

  setChat(rec: ChatRecord) {
    (this.data.chats ??= {})[rec.threadTs] = rec;
    this.save();
  }
}
