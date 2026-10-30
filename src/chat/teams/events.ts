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
import { rewriteMentions, stripBotMention } from './format.js';
import { CMD } from '../slack/blocks.js';
import { splitConversation, threadOf } from './keys.js';
import { channelMessageFiles, hydrateTeamsFiles, teamsFiles, type ChannelMessageRef, type FileTokens } from './files.js';
import type { AdaptiveCard } from './cards.js';
import { signCard, verifyAction, verifyDialog } from './cardsig.js';
import type { TeamsActionCtx, TeamsChatDriver } from './driver.js';
import { RecentSet } from '../../recent.js';
import { log } from '../../log.js';

// A failure on the file path is journaled (and so reaches Sentry) with what was being done, never swallowed.
const failed = (what: string) => (e: unknown) => {
  log.error(`teams files: ${what}: ${e instanceof Error ? e.message : String(e)}`);
  return undefined;
};

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
  attachments?: { contentType?: string; contentUrl?: string; name?: string; content?: unknown }[];
  channelData?: { team?: { id?: string; aadGroupId?: string } };
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
// driver needs to answer privately; `files` is lazy — classified now (files.ts), fetched only
// once the core acts, with the tokens app.ts provides (none in the pure tests: no files).
const CMD_WORD = new RegExp(`^${CMD.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+`, 'i');

export function normalizeMessage(a: InboundActivity, tenant: string, claim: (kind: string) => boolean = () => true, tokens?: FileTokens): Normalized {
  if (a.type !== 'message') return { kind: 'ignore', why: `not a message: ${a.type}` };
  const { conv, root } = splitConversation(a.conversation.id);
  const mentioned = (a.entities ?? []).some((e) => e.type === 'mention' && e.mentioned?.id === a.recipient.id);
  const text = stripBotMention(rewriteMentions(a.text ?? '', a.entities, a.recipient.id), a.recipient.name);
  const direct = isDirect(a);
  const thread = direct ? undefined : threadOf(a.conversation.id, a.id);
  const actor = { tenant, user: a.from.id };
  const ctx: TeamsActionCtx = { conv, thread: thread ?? (direct ? undefined : root), user: a.from.id, direct };
  // `/verb …` is a command wherever the bot listens: after a mention, in a 1:1, in a reply chain
  // (the router answers privately, exactly as a Slack slash command typed in any thread). The
  // Slack spelling `/aven verb …` (the router's own `CMD` hints) is accepted too, so a hint
  // copied from an answer works instead of going to the agent as a question.
  if (text.startsWith('/') && (mentioned || direct || thread)) {
    return { kind: 'command', cmd: { text: text.slice(1).replace(CMD_WORD, ''), conv, actor, ctx } };
  }
  const files = tokens ? teamsFiles(a.attachments) : [];
  // A channel message without files in the activity may still carry an upload Teams left out
  // (files.ts channelMessageFiles): read back through Graph, only once the core acts. The group id
  // comes with the activity or, failing that, from the Connector's team details (tokens.groupIdOf).
  const team = a.channelData?.team;
  const late: Omit<ChannelMessageRef, 'groupId'> | undefined = tokens && !direct && files.length === 0 ? { channelId: conv, rootId: root ?? a.id, messageId: a.id } : undefined;
  const msg: ChatMessage = {
    conv,
    id: a.id,
    thread,
    text,
    actor,
    direct,
    hasFiles: files.length > 0,
    files: async () => {
      if (files.length) return hydrateTeamsFiles(files, tokens!, tokens!.fetch);
      if (!late) return undefined;
      const groupId = team?.aadGroupId ?? (team?.id && tokens!.groupIdOf ? await tokens!.groupIdOf(team.id).catch(failed(`the group id of team ${team.id}`)) : undefined);
      if (!groupId) {
        log.warn(`teams files: no group id for the channel message ${late.messageId} (team ${team?.id ?? 'unknown'}) — an upload cannot be read back`);
        return undefined;
      }
      const graph = await tokens!.graphToken().catch(failed('the Graph token'));
      if (!graph) log.warn(`teams files: no Graph token — the channel message ${late.messageId} cannot be read back for an upload`);
      const found = graph ? ((await channelMessageFiles({ ...late, groupId }, graph, tokens!.fetch).catch(failed(`the read-back of ${late.messageId}`))) ?? []) : [];
      return found.length ? hydrateTeamsFiles(found, tokens!, tokens!.fetch) : undefined;
    },
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
// `task/fetch` invokes (the deferred the driver's openDialog resolves). With `key` (the installation's,
// cardsig.ts) a control is taken only when it carries the signature the bot put on it.
export function normalizeAction(
  a: InboundActivity,
  tenant: string,
  dialog?: TeamsActionCtx['dialog'],
  key?: string,
): ChatAction | undefined {
  const v = a.value as { action?: { data?: Record<string, unknown> }; data?: Record<string, unknown> } | undefined;
  const data = a.name === 'adaptiveCard/action' ? v?.action?.data : v?.data;
  const id = typeof data?.action === 'string' ? data.action : undefined;
  if (!id) return undefined;
  if (key && !verifyAction(key, data)) {
    log.warn(`teams: an unsigned or altered control ${id} from ${a.from.id} — ignored`);
    return undefined;
  }
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

// A dialog submit → the core's DialogSubmit: the form's data minus the routing fields. A
// multi-select ChoiceSet arrives as one comma-separated string; the card names those fields
// in `multi` (cards.ts) and they become the arrays the core's handlers expect. With `key`, the
// form must carry the signature of its dialog and metadata for THIS person (cardsig.ts).
export function normalizeSubmit(a: InboundActivity, tenant: string, key?: string): DialogSubmit | undefined {
  const data = (a.value as { data?: Record<string, unknown> } | undefined)?.data;
  const id = typeof data?.dialog === 'string' ? data.dialog : undefined;
  if (!id) return undefined;
  if (key && !verifyDialog(key, data, a.from.id)) {
    log.warn(`teams: an unsigned or altered dialog ${id} from ${a.from.id} — ignored`);
    return undefined;
  }
  const multi = new Set(Array.isArray(data?.multi) ? data.multi.map(String) : []);
  const values: DialogSubmit['values'] = {};
  for (const [k, val] of Object.entries(data ?? {})) {
    if (k === 'dialog' || k === 'meta' || k === 'msteams' || k === 'multi' || k === 'msig' || k === 'sig') continue;
    if (typeof val === 'string') values[k] = multi.has(k) ? val.split(',').filter(Boolean) : val;
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
  // Every person an accepted activity names (its sender, the people it mentions): the driver
  // renders mentions from these names, app.ts matches operators by Entra id through them.
  onPerson?: (id: string, name: string | undefined, aadObjectId: string | undefined) => void;
  // The project bound to a channel, if any — to say which project lost its channel when the
  // app is removed from a team.
  boundProject?: (conv: string) => string | undefined;
  // Tokens for fetching inbound files (files.ts); absent → files are ignored.
  files?: FileTokens;
  // The installation's card-control key (cardsig.ts): controls are signed on the way out (app.ts, and the
  // dialogs answered here) and checked on the way in. Absent → no check (the pure tests).
  cardKey?: string;
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
    if (deps.onPerson) {
      deps.onPerson(activity.from.id, activity.from.name, activity.from.aadObjectId);
      for (const e of activity.entities ?? []) {
        if (e.type === 'mention' && e.mentioned && e.mentioned.id !== activity.recipient.id) deps.onPerson(e.mentioned.id, e.mentioned.name, undefined);
      }
    }
    return next();
  });

  app.on('message', async ({ activity }) => {
    const n = normalizeMessage(activity, tenantId, claimFor(activity), deps.files);
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
    const a = normalizeAction(activity, tenantId, undefined, deps.cardKey);
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
    const a = normalizeAction(activity, tenantId, resolve, deps.cardKey);
    if (a) {
      const h = core.actions[a.id];
      if (h) void h(a, driver).catch((e) => log.error(`teams ${a.id}: ${e instanceof Error ? e.message : String(e)}`));
    }
    const fallback: { title: string; card: AdaptiveCard } = {
      title: 'CoachAven',
      card: { type: 'AdaptiveCard', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.5', body: [{ type: 'TextBlock', text: '_Nothing to show for this control._', wrap: true }] },
    };
    const d = await Promise.race([opened, new Promise<typeof fallback>((r) => setTimeout(() => r(fallback), DIALOG_WAIT_MS).unref())]);
    // The dialog is this person's: its form is signed for them (a submit by anyone else does not check out).
    const card = deps.cardKey ? signCard(deps.cardKey, d.card, activity.from.id) : d.card;
    return { task: { type: 'continue', value: { title: d.title, card: { contentType: 'application/vnd.microsoft.card.adaptive', content: card } } } };
  });

  app.on('dialog.submit', async ({ activity }) => {
    const s = normalizeSubmit(activity, tenantId, deps.cardKey);
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

  // Removed from a team or a chat: nothing to undo (bindings live in the registry), but a
  // bound project just lost its channel — say so, loudly, in the journal.
  app.on('install.remove', async ({ activity }) => {
    const { conv } = splitConversation(activity.conversation.id);
    const slug = deps.boundProject?.(conv);
    if (slug) log.warn(`teams: the app was removed from ${conv} — project ${slug} is bound there and cannot be reached until it is added again`);
    else log.info(`teams: the app was removed from ${conv} (${activity.conversation.conversationType ?? 'conversation'})`);
  });
}
