import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { splitTeam } from './teamkeys.js';
import { log } from './log.js';

// Crash-safe journal of QUEUED turns: accepted (status message posted) but not yet
// started. These were the one place a user's message could vanish silently across a
// restart — the started turn is recovered via the chat record's `inflight` marker, but a
// turn still waiting in the per-key queue lived only in memory, leaving its "⏳ In queue…"
// message frozen forever. One JSONL line per event: `add` when a turn is enqueued, `done`
// when it starts executing (inflight takes over) or settles without starting. On boot,
// replaying add-minus-done yields exactly the lost turns — see resumeQueuedTurns (turn.ts).
// Its own file (not state.json): journal semantics (append + boot-time drain), and a torn
// write here loses at worst the queue, never projects/routines.

export interface QueuedTurn {
  turnId: string;
  key: string; // conversation key (per-key queue identity)
  // Owning tenant (absent = home). Stamped by the journal from the key's tenant prefix
  // at add() — never caller-supplied — so replay picks the right workspace token.
  teamId?: string;
  slug: string; // project, resolved again at replay (the registry may have changed)
  channel: string;
  statusTs: string; // the posted status message — reused/finalized on recovery
  threadTs?: string;
  msgTs?: string; // the user's message (for the eyes/checkmark reactions on replay)
  question: string;
  // Replayable as-is? false when the turn carried attachments or engine-side callbacks
  // (a YT draft's autoPost) that can't be serialized — recovery then asks for a resend.
  plain: boolean;
  // Provenance of a DISPATCHED turn (dispatch.ts): which project proposed it and under which
  // proposal id; of a shadow turn (agent-messaging D10): the asking agent and the task id.
  // Informational on replay (the pointer-back callbacks are not serializable; a shadow turn's are
  // rebuilt from its task record — TurnDeps.shadow).
  origin?: { slug: string; proposalId: string } | { slug: string; taskId: string };
}

type JournalOp = ({ op: 'add' } & QueuedTurn) | { op: 'done'; turnId: string };

// Pure: journal text → still-pending turns, in enqueue order. Tolerant of a torn final
// line (crash mid-append) and of unknown ops (a file shared across bot versions).
export function pendingFromJournal(text: string): QueuedTurn[] {
  const pending = new Map<string, QueuedTurn>();
  for (const line of text.split('\n')) {
    const raw = line.trim();
    if (!raw) continue;
    let op: JournalOp;
    try {
      op = JSON.parse(raw) as JournalOp;
    } catch {
      continue; // torn/partial line — skip, don't lose the rest
    }
    if (typeof op?.turnId !== 'string') continue;
    if (op.op === 'add') {
      const { op: _, ...entry } = op;
      pending.set(entry.turnId, entry);
    } else if (op.op === 'done') {
      pending.delete(op.turnId);
    }
  }
  return [...pending.values()];
}

const QUEUE_PATH = new URL('../queue.jsonl', import.meta.url).pathname;

export class QueueJournal {
  // `path` is injectable so tests use a throwaway file (same pattern as Store).
  constructor(private readonly path: string = QUEUE_PATH) {}

  // Appends are best-effort: a full disk must degrade recovery, never sink a live turn.
  add(entry: QueuedTurn): void {
    // teamId derives from the key (see the field comment); undefined (home) serializes away.
    this.append({ op: 'add', ...entry, teamId: splitTeam(entry.key).tenantId });
  }

  done(turnId: string): void {
    this.append({ op: 'done', turnId });
  }

  // Read the pending turns and truncate the file: every survivor is either re-enqueued
  // (journaling itself afresh via liveTurn) or finalized with a "please resend" note, so
  // the old entries must not replay a second time on the boot after this one.
  drain(): QueuedTurn[] {
    let text = '';
    try {
      text = readFileSync(this.path, 'utf8');
    } catch {
      return []; // no journal yet — nothing queued at last shutdown
    }
    const pending = pendingFromJournal(text);
    try {
      writeFileSync(this.path, '');
    } catch (e) {
      log.error(`queue journal truncate: ${e instanceof Error ? e.message : String(e)}`);
    }
    return pending;
  }

  private append(op: JournalOp): void {
    try {
      appendFileSync(this.path, JSON.stringify(op) + '\n');
    } catch (e) {
      log.error(`queue journal append: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
