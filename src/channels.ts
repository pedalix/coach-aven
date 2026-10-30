// Channel ↔ project resolution: which project a Slack channel (or a slug-prefixed
// message) maps to, and the reverse (project → its `aven-<slug>` channel id).
// Shared by the event handlers, the /aven router, and the pollers.
//
// Slice 2: every resolution happens INSIDE the calling tenant's project subset
// (teamProjects) — a client workspace can neither resolve nor even enumerate another
// tenant's slugs. `tenantId` undefined = home context (pollers, static mode).

import { noProjectsReason, resolveByChannel, resolveBySlug, teamProjects, workspacePrefix, type ProjectConfig, type RegistryRef } from './projects.js';
import type { ChatDriverName } from './chat/drivers.js';
import { log } from './log.js';

// What project resolution needs from a chat platform: a conversation's name (for the
// `<prefix><slug>` wildcard binding), undefined when it has none or can't be read. Any
// ChatDriver provides it.
export interface ConversationNames {
  conversationName(conv: string): Promise<string | undefined>;
}
// …and the reverse, for a poller that has only a slug: the conversation with this name.
export interface ConversationDirectory {
  findConversation(name: string): Promise<string | undefined>;
}

export interface Channels {
  readonly prefix: string; // the deployment default (SLACK_CHANNEL_PREFIX)
  // The wildcard for ONE workspace: its workspaces-entry override ("" = bare slugs,
  // e.g. #coach-aven) or the deployment default. Use this, not `.prefix`, wherever a
  // tenant is known — client workspaces shouldn't be forced to carry `aven-`.
  prefixFor(tenantId: string | undefined): string;
  channelName(names: ConversationNames, channelId: string): Promise<string | undefined>;
  channelIdForSlug(
    dir: ConversationDirectory,
    project: ProjectConfig,
    tenantId?: string,
  ): Promise<string | undefined>;
  pickProject(
    names: ConversationNames,
    channel: string,
    text: string,
    tenantId?: string,
  ): Promise<{ project?: ProjectConfig; question: string; error?: string }>;
}

// Channels auto-bind by name: a channel named `${prefix}<slug>` (e.g. aven-shop)
// maps to the project with that slug — no channel ids to wire. An explicit `slackChannel`
// id in the registry still overrides. Names cached per id. Holds the registry REF (not a
// snapshot) so a runtime config reload is visible immediately. `home()` is late-bound:
// the home tenant id is only known after the boot auth.test resolves it (slack.ts).
export interface ChannelsOptions {
  // Conversations that map to a project ONLY through an explicit binding: the single-project fallback
  // below never applies to them, and an unbound one is told so. The Teams driver passes its team
  // channels here (OpenSpec teams-chat-driver: a channel maps by id only; a mention in an unbound
  // channel gets "not connected" and no turn) — the canary found a mention in a fresh channel driving
  // the installation's one project. Slack passes nothing: a single-project workspace keeps answering
  // in any channel the bot is in, as today.
  boundOnly?: (conversation: string) => boolean;
  // Which explicit binding of a project this surface's directory reads (`slackChannel`, `teamsChannel`):
  // the driver's name. Absent: today's order (slackChannel, then teamsChannel), for a directory that
  // serves one driver as before. The web binds through the two hooks below, never by a field.
  binding?: ChatDriverName;
  // A surface whose conversations ARE its projects' (OpenSpec web-chat-driver: a room is a project's,
  // a private conversation names its project): the project a conversation belongs to, consulted before
  // every other rule of pickProject — and the conversation a project's background deliveries go to.
  // Both absent: the field bindings and the name wildcard decide, as before.
  projectOf?: (conversation: string) => string | undefined;
  conversationFor?: (project: ProjectConfig) => string | undefined;
}

export function createChannels(reg: RegistryRef, home: () => string | undefined, opts: ChannelsOptions = {}): Channels {
  const prefix = process.env.SLACK_CHANNEL_PREFIX || 'aven-';
  const prefixFor = (tenantId: string | undefined): string =>
    workspacePrefix(reg.current, tenantId) ?? prefix;
  const nameCache = new Map<string, string | undefined>();

  async function channelName(names: ConversationNames, channelId: string): Promise<string | undefined> {
    if (nameCache.has(channelId)) return nameCache.get(channelId);
    const name = await names.conversationName(channelId); // undefined: DM / no access
    nameCache.set(channelId, name);
    return name;
  }

  // Reverse of channelName: resolve a project → the id of its `aven-<slug>` channel, so
  // a poller with only a slug (no prior message) can post there. An explicit `slackChannel`
  // override wins; otherwise the driver looks the name up (Slack: pages conversations.list). Only HITS are
  // cached — a miss re-lists next call so a channel created after boot self-heals (the bot
  // must be a member to see a private channel / to post). Used by the investigation poller.
  // Cache is TENANT-keyed: a shared slug resolves to a different channel id in each
  // workspace, and the id only makes sense to that workspace's token.
  const slugChannelCache = new Map<string, string>();
  async function channelIdForSlug(
    dir: ConversationDirectory,
    project: ProjectConfig,
    tenantId?: string,
  ): Promise<string | undefined> {
    // A surface that binds by construction (the web) answers from its own hook — a project without a
    // conversation there (a hidden room) is undefined, never a name lookup.
    if (opts.conversationFor) return opts.conversationFor(project);
    // An explicit binding wins: the one of this surface's driver when the directory knows it (an
    // installation with several surfaces binds a project on each), else `slackChannel` then `teamsChannel`.
    const bound = opts.binding === 'teams' ? project.teamsChannel : opts.binding === 'slack' ? project.slackChannel : opts.binding === 'web' ? undefined : (project.slackChannel ?? project.teamsChannel);
    if (bound) return bound;
    if (opts.binding === 'teams' || opts.binding === 'web') return undefined; // no name wildcard on these surfaces
    const cacheKey = `${tenantId ?? 'home'}:${project.slug}`;
    const cached = slugChannelCache.get(cacheKey);
    if (cached) return cached;
    const want = `${prefixFor(tenantId)}${project.slug}`;
    let found: string | undefined;
    try {
      found = await dir.findConversation(want);
    } catch (e) {
      log.error(`channelIdForSlug ${project.slug}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (found) slugChannelCache.set(cacheKey, found);
    return found;
  }

  // Resolve the project for a turn WITHIN the tenant's subset: explicit channel-id
  // binding wins → else the `aven-<slug>` channel-name wildcard → else a leading
  // <slug> token (handy in DMs) → else the tenant's sole project. The ambiguity error
  // lists only the tenant's own slugs — never the fleet's.
  async function pickProject(
    names: ConversationNames,
    channel: string,
    text: string,
    tenantId?: string,
  ): Promise<{ project?: ProjectConfig; question: string; error?: string }> {
    const mine = teamProjects(reg.current, tenantId, home());
    const scoped = { projects: mine };
    const p = prefixFor(tenantId);
    // The surface's own mapping first (a web room or private conversation names its project) — inside
    // the tenant's subset, like every other rule here.
    const own = opts.projectOf?.(channel);
    let project = (own ? resolveBySlug(scoped, own) : undefined) ?? resolveByChannel(scoped, channel);
    let question = text.trim();
    if (!project) {
      const name = await channelName(names, channel);
      if (name && name.startsWith(p)) {
        project = resolveBySlug(scoped, name.slice(p.length));
      }
    }
    if (!project) {
      const m = question.match(/^(\S+)\s+([\s\S]+)$/);
      if (m) {
        const bySlug = resolveBySlug(scoped, m[1]);
        if (bySlug) {
          project = bySlug;
          question = m[2].trim();
        }
      }
    }
    const boundOnly = opts.boundOnly?.(channel) === true;
    if (!project && mine.length === 1 && !boundOnly) project = mine[0];
    if (!project) {
      const slugs = mine.map((p) => p.slug).join(', ');
      return {
        question,
        error: !mine.length
          ? noProjectsReason(reg.current, tenantId, home())
          : boundOnly
            ? `This channel isn't connected to a project — an operator binds a channel to one by its id in the project registry.`
            : `This channel isn't bound to a project. Use a \`${p}{project}\` channel (e.g. \`${p}${mine[0].slug}\`), or prefix your question with a slug — one of: ${slugs}.`,
      };
    }
    return { project, question };
  }

  return { prefix, prefixFor, channelName, channelIdForSlug, pickProject };
}
