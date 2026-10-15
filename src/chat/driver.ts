// The chat driver interface (OpenSpec chat-driver-interface): everything the platform-
// neutral core does to a chat goes through it, so a new chat platform is one new driver,
// not a rewrite of the core. An installation runs exactly one driver (`orch slack` today).
//
// Distinct from the SANDBOX driver (src/driver.ts): that one is where the agent runs, this
// one is where people talk to it.
//
// Grows one PR at a time: PR 1 carries the turn path (post / update / mark / permalink).

import type { TurnView } from './views.js';

// Where to post: a conversation (Slack channel/DM id) and, optionally, the thread in it.
export interface ConvTarget {
  conv: string;
  thread?: string;
}

// A message the driver posted (or the user's message the core reacts to).
export interface MsgRef {
  conv: string;
  id: string;
}

// Lightweight acknowledgements on the USER'S message. Slack shows them as reactions;
// a platform without reactions may show nothing.
export type Mark = 'working' | 'done' | 'failed' | 'note';

// What a platform can and cannot do, so shared texts (help, Home cheat-sheet) can pick the
// right wording instead of promising a Slack-only affordance everywhere.
export interface DriverCapabilities {
  reactions: boolean; // acknowledgements on the user's message are visible
  privateReplies: 'native' | 'fallback'; // ephemeral in place, or via a direct message
  threadRepliesNeedMention: boolean; // replies in a bot thread reach it only with a mention
}

export interface ChatDriver {
  readonly capabilities: DriverCapabilities;
  // Post a new message; resolves to its reference. Throws on platform failure (callers
  // decide whether that is fatal, exactly as they did with the raw Slack client).
  post(to: ConvTarget, view: TurnView): Promise<MsgRef>;
  // Replace a message the driver posted. Throws on platform failure.
  update(msg: MsgRef, view: TurnView): Promise<void>;
  // Add/remove an acknowledgement on a message. Never throws (best-effort by nature).
  mark(msg: MsgRef, mark: Mark, op: 'add' | 'remove'): Promise<void>;
  // A shareable link to a message (the thread root), when the platform has one. Never throws.
  permalink(msg: MsgRef): Promise<string | undefined>;
}

// The driver for a tenant (undefined = home). Throws for a tenant the installation can no
// longer reach (an uninstalled Slack workspace) — recovery treats that per record.
export type DriverForTenant = (tenantId?: string) => ChatDriver;
