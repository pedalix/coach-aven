// Each side keeps its own clock on tasks (OpenSpec `agent-messaging`, design D8, D10): a task with no
// message for the hub's expiry plus one day ends `failed: expired` here, whatever happened to its
// envelopes — lost before the hub (a recreated hub, the backlog cap), or a shadow conversation that never
// answered. So neither side keeps a record or a session forever. Both transports: a task inside one
// installation expires the same way. The pass returns what it ended; telling the conversation and closing
// a shadow session is the caller's (the deliverer's) part.
import type { Store } from '../state.js';
import type { InTask, OutTask } from './records.js';

const DAY_MS = 86_400_000;
/** The hub's envelope expiry (hub/wrangler.example.toml HUB_EXPIRY_DAYS, default 7). */
export const HUB_EXPIRY_MS = 7 * DAY_MS;
/** A task idle this long ends `failed: expired` on this side. */
export const TASK_EXPIRY_MS = HUB_EXPIRY_MS + DAY_MS;

export function expireIdleTasks(store: Store, now = new Date(), idleMs = TASK_EXPIRY_MS): { out: OutTask[]; in: InTask[] } {
  const at = now.toISOString();
  const idle = store.idleOpenTasks(idleMs, now.getTime());
  return {
    out: idle.out.map((t) => store.patchOutTask(t.id, { state: 'failed', reason: 'expired', updatedAt: at })!),
    in: idle.in.map((t) => store.patchInTask(t.origin, t.id, { state: 'failed', reason: 'expired', updatedAt: at })!),
  };
}
