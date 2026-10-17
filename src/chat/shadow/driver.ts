// The shadow conversation's chat driver (OpenSpec `agent-messaging`, design D10): the answering
// side of a task runs a real turn in its project's session, but nothing reaches a channel. This
// ChatDriver posts nothing: every view the turn engine shows is appended to the task's journal —
// `shadow/<origin installation>/<taskId>.jsonl` beside state.json — and post/update return
// synthetic ids. Operators read the journal with `/aven asks <taskId>`; it outlives the task and is
// pruned with the task records (30 days).
//
// It only journals. The completion rule — whether a final answer completes the task — belongs to
// settleShadowTurn (messaging/answer.ts), reached through the turn's options.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatDriver, MsgRef } from '../driver.js';
import type { MessageView } from '../views.js';
import { splitTeam } from '../../teamkeys.js';
import { INSTALLATION_RE } from '../../messaging/protocol.js';
import { isId } from '../../messaging/a2a.js';

/** The parts of a shadow key `[<tenant>:]a2a:<origin>:<taskId>:<slug>`, validated (ids go into paths). */
export function parseShadowKey(key: string): { tenantId?: string; origin: string; taskId: string; slug: string } | undefined {
  const { tenantId, base } = splitTeam(key);
  const p = base.split(':');
  if (p.length !== 4 || p[0] !== 'a2a') return undefined;
  const [, origin, taskId, slug] = p as [string, string, string, string];
  if (!INSTALLATION_RE.test(origin) || !isId(taskId) || !slug) return undefined;
  return { ...(tenantId ? { tenantId } : {}), origin, taskId, slug };
}

/** The shadow key of a task an agent here answers. */
export const shadowKey = (o: { tenantId?: string; origin: string; taskId: string; slug: string }): string =>
  `${o.tenantId ? `${o.tenantId}:` : ''}a2a:${o.origin}:${o.taskId}:${o.slug}`;

export interface JournalEntry {
  at: string;
  op: 'post' | 'update';
  id: string;
  view: MessageView;
}

export interface ShadowDriver extends ChatDriver {
  /** The task's journal, oldest first. */
  read(origin: string, taskId: string): JournalEntry[];
  /** Drop journals older than `maxAgeMs` (housekeeping, with the task records). */
  prune(maxAgeMs: number, now?: number): number;
}

export function shadowDriver(o: { dir: string; now?: () => Date }): ShadowDriver {
  let seq = 0;
  const file = (origin: string, taskId: string): string => join(o.dir, origin, `${taskId}.jsonl`);
  // A shadow conversation's "channel" is its key (the deliverer's reply target names it).
  const where = (conv: string): { origin: string; taskId: string } | undefined => parseShadowKey(conv);
  const append = (conv: string, entry: Omit<JournalEntry, 'at'>): void => {
    const w = where(conv);
    if (!w) return; // not a shadow key: nothing to journal into
    mkdirSync(join(o.dir, w.origin), { recursive: true });
    appendFileSync(file(w.origin, w.taskId), JSON.stringify({ at: (o.now?.() ?? new Date()).toISOString(), ...entry }) + '\n');
  };
  return {
    capabilities: { reactions: false, privateReplies: 'fallback', threadRepliesNeedMention: false },
    async post(to, view) {
      const id = `shadow-${Date.now().toString(36)}-${++seq}`;
      append(to.conv, { op: 'post', id, view });
      return { conv: to.conv, id };
    },
    async update(msg: MsgRef, view) {
      append(msg.conv, { op: 'update', id: msg.id, view });
    },
    async mark() {},
    async permalink() {
      return undefined;
    },
    async reply() {},
    async conversationName() {
      return undefined;
    },
    async openDirect() {
      return undefined;
    },
    async findConversation() {
      return undefined;
    },
    async postPrivate() {},
    async openDialog() {
      return undefined;
    },
    async updateDialog() {},
    async refreshRating() {},
    async publishHome() {},
    read(origin, taskId) {
      const f = file(origin, taskId);
      if (!INSTALLATION_RE.test(origin) || !isId(taskId) || !existsSync(f)) return [];
      return readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as JournalEntry];
          } catch {
            return [];
          }
        });
    },
    prune(maxAgeMs, now = Date.now()) {
      if (!existsSync(o.dir)) return 0;
      let dropped = 0;
      for (const origin of readdirSync(o.dir)) {
        const d = join(o.dir, origin);
        for (const f of readdirSync(d)) {
          if (now - statSync(join(d, f)).mtimeMs > maxAgeMs) {
            rmSync(join(d, f), { force: true });
            dropped++;
          }
        }
      }
      return dropped;
    },
  };
}
