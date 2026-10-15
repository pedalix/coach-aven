// Channel ↔ project resolution: which project a Slack channel (or a slug-prefixed
// message) maps to, and the reverse (project → its `bluefin-aven-<slug>` channel id).
// Shared by the event handlers, the /aven router, and the pollers.
//
// Slice 2: every resolution happens INSIDE the calling tenant's project subset
// (teamProjects) — a client workspace can neither resolve nor even enumerate another
// tenant's slugs. `tenantId` undefined = home context (pollers, static mode).

import { resolveByChannel, resolveBySlug, teamProjects, workspacePrefix, type ProjectConfig, type RegistryRef } from './projects.js';
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
  // tenant is known — client workspaces shouldn't be forced to carry `bluefin-aven-`.
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

// Channels auto-bind by name: a channel named `${prefix}<slug>` (e.g. bluefin-aven-caldora)
// maps to the project with that slug — no channel ids to wire. An explicit `slackChannel`
// id in the registry still overrides. Names cached per id. Holds the registry REF (not a
// snapshot) so a runtime config reload is visible immediately. `home()` is late-bound:
// the home tenant id is only known after the boot auth.test resolves it (slack.ts).
export function createChannels(reg: RegistryRef, home: () => string | undefined): Channels {
  const prefix = process.env.SLACK_CHANNEL_PREFIX || 'bluefin-aven-';
  const prefixFor = (tenantId: string | undefined): string =>
    workspacePrefix(reg.current, tenantId) ?? prefix;
  const nameCache = new Map<string, string | undefined>();

  async function channelName(names: ConversationNames, channelId: string): Promise<string | undefined> {
    if (nameCache.has(channelId)) return nameCache.get(channelId);
    const name = await names.conversationName(channelId); // undefined: DM / no access
    nameCache.set(channelId, name);
    return name;
  }

  // Reverse of channelName: resolve a project → the id of its `bluefin-aven-<slug>` channel, so
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
    if (project.slackChannel) return project.slackChannel;
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
  // binding wins → else the `bluefin-aven-<slug>` channel-name wildcard → else a leading
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
    let project = resolveByChannel(scoped, channel);
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
    if (!project && mine.length === 1) project = mine[0];
    if (!project) {
      const slugs = mine.map((p) => p.slug).join(', ');
      return {
        question,
        error: mine.length
          ? `This channel isn't bound to a project. Use a \`${p}{project}\` channel (e.g. \`${p}${mine[0].slug}\`), or prefix your question with a slug — one of: ${slugs}.`
          : `This workspace has no projects configured yet.`,
      };
    }
    return { project, question };
  }

  return { prefix, prefixFor, channelName, channelIdForSlug, pickProject };
}
