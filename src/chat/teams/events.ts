// Teams activities → the platform-neutral core. Thin by design, like the Slack adapter: an
// activity is normalized here (pure functions, tested over the recorded fixtures), what it
// DOES lives in src/chat/core/. Two halves: `normalize*` (pure) and `registerEvents` (the SDK
// wiring — the only place that knows the Teams SDK's handler shapes).
//
// Shapes we rely on (src/fixtures/chat/teams/activities/*.json, recorded from a real tenant):
// - a channel message: conversation.id = `<channel>;messageid=<root>`, conversationType 'channel',
//   entities carry a `mention` of the bot when it was @-mentioned, `text` has the mention in
//   plain form; a reply without a mention still arrives when the team granted RSC consent;
// - a personal message: conversationType 'personal', no reply chains;
// - an Adaptive Card click: invoke `adaptiveCard/action`, value.action.data = { action, value };
// - a dialog opener: invoke `task/fetch`, value.data = { action, value, msteams }; its answer
//   is the dialog; a dialog submit: invoke `task/submit`, value.data = the form's data;
// - `installationUpdate` (action 'add') in personal scope → the Home card.

import type { ChatAction, ChatCommand, ChatMessage, DialogSubmit } from '../driver.js';
import type { Interactions } from '../core/interactions.js';
import type { createMessages } from '../core/messages.js';
import type { createCommands } from '../core/commands.js';
import { stripBotMention } from './format.js';
import { splitConversation, threadOf } from './keys.js';
import type { AdaptiveCard } from './cards.js';
import type { TeamsActionCtx, TeamsChatDriver } from './driver.js';
import { RecentSet } from '../../recent.js';
import { log } from '../../log.js';

// The slice of a Bot Framework activity we read. Typed here, not with the SDK's classes, so
// the normalizers stay pure and the fixtures stay plain JSON.
export interface InboundActivity {
  type: string;
  id: string;
  name?: string; // invoke name
  text?: string;
  serviceUrl?: string;
  from: { id: string; name?: string; aadObjectId?: string };
  recipient: { id: string; name?: string };
  conversation: { id: string; conversationType?: string; tenantId?: string; isGroup?: boolean };
  replyToId?: string;
  entities?: { type: string; mentioned?: { id: string; name?: string }; text?: string }[];
  attachments?: { contentType?: string; contentUrl?: string; name?: string }[];
  value?: unknown;
  action?: string; // installationUpdate: 'add' | 'remove'
}

export type Normalized =
  | { kind: 'mention'; msg: ChatMessage }
  | { kind: 'message'; msg: ChatMessage }
  | { kind: 'command'; cmd: ChatCommand }
  | { kind: 'ignore'; why: string };

const isDirect = (a: InboundActivity) => a.conversation.conversationType === 'personal';

// A message activity → a mention (the bot is named), a command (`/verb …` after the mention,
// or bare in a 1:1), or a plain message (a thread reply, a 1:1 line). `ctx` is what the
// driver needs to answer privately; `files` is lazy and empty until PR 2.
export function normalizeMessage(a: InboundActivity, tenant: string, claim: (kind: string) => boolean = () => true): Normalized {
  if (a.type !== 'message') return { kind: 'ignore', why: `not a message: ${a.type}` };
  const { conv, root } = splitConversation(a.conversation.id);
  const mentioned = (a.entities ?? []).some((e) => e.type === 'mention' && e.mentioned?.id === a.recipient.id);
  const text = stripBotMention(a.text ?? '', a.recipient.name);
  const direct = isDirect(a);
  const thread = direct ? undefined : threadOf(a.conversation.id, a.id);
  const actor = { tenant, user: a.from.id };
  const ctx: TeamsActionCtx = { conv, thread: thread ?? (direct ? undefined : root), user: a.from.id, direct };
  // `/verb …` is a command wherever the bot listens: after a mention, in a 1:1, in a reply chain
  // (the router answers privately, exactly as a Slack slash command typed in any thread).
  if (text.startsWith('/') && (mentioned || direct || thread)) {
    return { kind: 'command', cmd: { text: text.slice(1), conv, actor, ctx } };
  }
  const msg: ChatMessage = {
    conv,
    id: a.id,
    thread,
    text,
    actor,
    direct,
    hasFiles: false,
    files: async () => undefined,
    claim,
  };
  // In a 1:1 the client may still attach a mention entity (typing "@Aven …"); the chat has no
  // reply chains, so it is a direct message, never a mention that would open a thread.
  if (direct) return { kind: 'message', msg };
  if (mentioned) return { kind: 'mention', msg };
  if (thread) return { kind: 'message', msg };
  // A top-level channel message that does not name the bot: not ours (RSC delivers every
  // channel message once consent is granted).
  return { kind: 'ignore', why: 'channel message without a mention' };
}

// A card click or a dialog opener → the core's ChatAction. `dialog` is set by the caller for
// `task/fetch` invokes (the deferred the driver's openDialog resolves).
export function normalizeAction(
  a: InboundActivity,
  tenant: string,
  dialog?: TeamsActionCtx['dialog'],
): ChatAction | undefined {
  const v = a.value as { action?: { data?: Record<string, unknown> }; data?: Record<string, unknown> } | undefined;
  const data = a.name === 'adaptiveCard/action' ? v?.action?.data : v?.data;
  const id = typeof data?.action === 'string' ? data.action : undefined;
  if (!id) return undefined;
  const { conv, root } = splitConversation(a.conversation.id);
  const direct = isDirect(a);
  const ctx: TeamsActionCtx = { conv, thread: direct ? undefined : root, user: a.from.id, direct, dialog };
  return {
    id,
    value: typeof data?.value === 'string' ? data.value : '',
    actor: { tenant, user: a.from.id },
    where: { conv, thread: direct ? undefined : root },
    msg: a.replyToId ? { conv, id: a.replyToId, thread: direct ? undefined : root } : undefined,
    msgText: undefined,
    canDialog: !!dialog,
    ctx,
  };
}

// A dialog submit → the core's DialogSubmit: the form's data minus the routing fields.
export function normalizeSubmit(a: InboundActivity, tenant: string): DialogSubmit | undefined {
  const data = (a.value as { data?: Record<string, unknown> } | undefined)?.data;
  const id = typeof data?.dialog === 'string' ? data.dialog : undefined;
  if (!id) return undefined;
  const values: DialogSubmit['values'] = {};
  for (const [k, val] of Object.entries(data ?? {})) {
    if (k === 'dialog' || k === 'meta' || k === 'msteams') continue;
    if (typeof val === 'string') values[k] = val;
    else if (Array.isArray(val)) values[k] = val.map(String);
  }
  return { id, meta: typeof data?.meta === 'string' ? data.meta : '', values, actor: { tenant, user: a.from.id } };
}

// ── the SDK wiring ─────────────────────────────────────────────────────────

// The handler context slice we use (the SDK's IActivityContext, narrowed).
interface Ctx {
  activity: InboundActivity;
  next: () => unknown;
}
// The SDK's App, narrowed to what registration needs: `on(route, handler)` and `use`.
export interface TeamsAppLike {
  on(route: string, handler: (ctx: Ctx) => Promise<unknown> | unknown): unknown;
}

export interface EventDeps {
  tenantId: string;
  driver: TeamsChatDriver;
  messages: ReturnType<typeof createMessages>;
  core: Interactions;
  commands: ReturnType<typeof createCommands>;
  // Called with every accepted activity's serviceUrl (proactive sends need it).
  onServiceUrl: (url: string) => void;
}

// Teams gives an invoke 5 s before "Unable to reach the app" (and it retries twice): answer well
// inside that, with a fallback dialog when the core has not produced a view by then.
const DIALOG_WAIT_MS = 4000;
// Teams re-delivers an activity whose first delivery took over 15 s to be answered: the same
// id arrives again and must act at most once (the claim-on-act rule, as on Slack Connect).
const DEDUPE_MS = 10 * 60_000;

export function registerEvents(app: TeamsAppLike, deps: EventDeps): void {
  const { tenantId, driver, messages, core, commands } = deps;
  const rejected = new Set<string>();
  const seen = new RecentSet(DEDUPE_MS);
  const claimFor = (a: InboundActivity) => (kind: string) => seen.claim(`${kind}:${a.id}`);

  // Tenant gate first, for every activity: a foreign tenant is logged once and dropped.
  app.on('activity', async ({ activity, next }) => {
    const t = activity.conversation?.tenantId;
    if (t !== tenantId) {
      if (!rejected.has(t ?? '?')) {
        rejected.add(t ?? '?');
        log.warn(`teams: rejected an activity from tenant ${t ?? '(none)'} — this installation serves ${tenantId} only`);
      }
      return;
    }
    if (activity.serviceUrl) deps.onServiceUrl(activity.serviceUrl);
    return next();
  });

  app.on('message', async ({ activity }) => {
    const n = normalizeMessage(activity, tenantId, claimFor(activity));
    if (n.kind === 'mention' || n.kind === 'message') {
      // A root message IS its chain's root; a reply names it. Needed to react to the message.
      const { conv, root } = splitConversation(activity.conversation.id);
      driver.remember({ conv, id: n.msg.id }, n.msg.direct ? undefined : (n.msg.thread ?? root ?? n.msg.id));
    }
    switch (n.kind) {
      case 'mention':
        return messages.onMention(n.msg, driver);
      case 'message':
        return messages.onMessage(n.msg, driver);
      case 'command':
        if (!claimFor(activity)('command')) return; // a re-delivery of a slow command
        return commands.run(n.cmd, driver);
      case 'ignore':
        return;
    }
  });

  // Card clicks (Action.Execute): run the family handler; the invoke itself is answered with
  // an empty message response (the card changes come through update()).
  app.on('card.action', async ({ activity }) => {
    const a = normalizeAction(activity, tenantId);
    if (!a || !claimFor(activity)('action')) return { statusCode: 200, type: 'application/vnd.microsoft.activity.message', value: '' };
    const h = core.actions[a.id];
    if (!h) log.warn(`teams: no handler for card action ${a.id}`);
    else await h(a, driver).catch((e) => log.error(`teams ${a.id}: ${e instanceof Error ? e.message : String(e)}`));
    return { statusCode: 200, type: 'application/vnd.microsoft.activity.message', value: '' };
  });

  // A dialog opener: the core runs the family handler, which calls driver.openDialog with the
  // view; the deferred below turns that into the invoke's response. No view within the wait
  // → a short "nothing to show" dialog rather than Teams' "unable to reach app".
  app.on('dialog.open', async ({ activity }) => {
    let resolve!: (d: { title: string; card: AdaptiveCard }) => void;
    const opened = new Promise<{ title: string; card: AdaptiveCard }>((r) => (resolve = r));
    const a = normalizeAction(activity, tenantId, resolve);
    if (a) {
      const h = core.actions[a.id];
      if (h) void h(a, driver).catch((e) => log.error(`teams ${a.id}: ${e instanceof Error ? e.message : String(e)}`));
    }
    const fallback: { title: string; card: AdaptiveCard } = {
      title: 'Aven',
      card: { type: 'AdaptiveCard', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.5', body: [{ type: 'TextBlock', text: '_Nothing to show for this control._', wrap: true }] },
    };
    const d = await Promise.race([opened, new Promise<typeof fallback>((r) => setTimeout(() => r(fallback), DIALOG_WAIT_MS).unref())]);
    return { task: { type: 'continue', value: { title: d.title, card: { contentType: 'application/vnd.microsoft.card.adaptive', content: d.card } } } };
  });

  app.on('dialog.submit', async ({ activity }) => {
    const s = normalizeSubmit(activity, tenantId);
    if (s) {
      const h = core.submits[s.id];
      if (!h) log.warn(`teams: no handler for dialog ${s.id}`);
      else await h(s, driver).catch((e) => log.error(`teams dialog ${s.id}: ${e instanceof Error ? e.message : String(e)}`));
    }
    return { task: { type: 'message', value: 'Thanks.' } };
  });

  // Personal install → the Home card, once.
  app.on('install.add', async ({ activity }) => {
    if (!isDirect(activity)) return;
    await core.home({ tenant: tenantId, user: activity.from.id }, driver).catch((e) => log.error(`teams home: ${e instanceof Error ? e.message : String(e)}`));
  });
}
