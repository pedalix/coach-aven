// The chat driver interface (OpenSpec chat-driver-interface): everything the platform-
// neutral core does to a chat goes through it, so a new chat platform is one new driver,
// not a rewrite of the core. An installation runs exactly one driver (`orch slack` today).
//
// Distinct from the SANDBOX driver (src/driver.ts): that one is where the agent runs, this
// one is where people talk to it.
//
// Grows one PR at a time: the turn path (post / update / mark / permalink), then the
// interaction surface (clicks, dialogs, private replies, Home).

import type { Tally } from '../feedback.js';
import type { DialogView, HomeView, MessageView, PrivateView } from './views.js';

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

// Who acted, in which tenant (undefined = home or unknown — the gates decide).
export interface Actor {
  tenant?: string;
  user?: string;
}

// A click on a control the core rendered, normalized by the driver.
export interface ChatAction {
  id: string; // the control family ('cancel_turn', 'answer_q', 'mem_open', …)
  value: string; // the payload the core put on the control (a select: the chosen option's)
  actor: Actor;
  where?: ConvTarget; // the conversation (and thread) the control lives in
  msg?: MsgRef & { thread?: string }; // the message carrying the control, when known
  msgText?: string; // that message's text as markdown, best-effort (a draft's fallback)
  canDialog: boolean; // whether this click may open a dialog (Slack: a trigger id came along)
  readonly ctx: unknown; // driver-private interaction state (Slack: respond URL, trigger, blocks)
}

// A submitted dialog, normalized: field name → entered text, or the chosen option values.
export interface DialogSubmit {
  id: string; // the dialog family ('feedback', 'yt_prompt', 'yt_send')
  meta: string; // the private metadata the core put on the dialog
  values: Record<string, string | string[] | undefined>;
  actor: Actor;
}

// A handle on an open dialog, for swapping its content in place.
export interface DialogRef {
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
  post(to: ConvTarget, view: MessageView): Promise<MsgRef>;
  // Replace a message the driver posted. Throws on platform failure.
  update(msg: MsgRef, view: MessageView): Promise<void>;
  // Add/remove an acknowledgement on a message. Never throws (best-effort by nature).
  mark(msg: MsgRef, mark: Mark, op: 'add' | 'remove'): Promise<void>;
  // A shareable link to a message (the thread root), when the platform has one. Never throws.
  permalink(msg: MsgRef): Promise<string | undefined>;

  // ── interaction surface ──
  // Answer a click privately, to the person who clicked (`replace`: in place of the private
  // message the click came from). Throws on platform failure.
  reply(action: ChatAction, view: PrivateView, opts?: { replace?: boolean }): Promise<void>;
  // Post privately to one person inside a conversation/thread. Throws on platform failure.
  postPrivate(to: ConvTarget, user: string, view: PrivateView): Promise<void>;
  // Open a dialog for the person who clicked. Throws on platform failure (the click's dialog
  // window is single-use — callers fall back to a private reply, never a retry).
  openDialog(action: ChatAction, view: DialogView): Promise<DialogRef | undefined>;
  updateDialog(dialog: DialogRef, view: DialogView): Promise<void>;
  // Show a fresh vote count on the rated message, leaving everything else on it untouched.
  // Never throws (the verdict is already recorded; the count is cosmetic).
  refreshRating(action: ChatAction, tally: Tally): Promise<void>;
  // Publish a person's home surface. Throws on platform failure.
  publishHome(user: string, view: HomeView): Promise<void>;
}

// The driver for a tenant (undefined = home). Throws for a tenant the installation can no
// longer reach (an uninstalled Slack workspace) — recovery treats that per record.
export type DriverForTenant = (tenantId?: string) => ChatDriver;
