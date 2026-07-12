// Channel ↔ project resolution: which project a Slack channel (or a slug-prefixed
// message) maps to, and the reverse (project → its `bluefin-aven-<slug>` channel id).
// Shared by the event handlers, the /aven router, and the pollers.
//
// Slice 2: every resolution happens INSIDE the calling tenant's project subset
// (teamProjects) — a client workspace can neither resolve nor even enumerate another
// tenant's slugs. `tenantId` undefined = home context (pollers, static mode).

import type bolt from '@slack/bolt';
import { resolveByChannel, resolveBySlug, teamProjects, type ProjectConfig, type RegistryRef } from './projects.js';
import { log } from './log.js';

export interface Channels {
  readonly prefix: string;
  channelName(client: bolt.webApi.WebClient, channelId: string): Promise<string | undefined>;
  channelIdForSlug(
    client: bolt.webApi.WebClient,
    project: ProjectConfig,
    tenantId?: string,
  ): Promise<string | undefined>;
  pickProject(
    client: bolt.webApi.WebClient,
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
  const nameCache = new Map<string, string | undefined>();

  async function channelName(
    client: bolt.webApi.WebClient,
    channelId: string,
  ): Promise<string | undefined> {
    if (nameCache.has(channelId)) return nameCache.get(channelId);
    let name: string | undefined;
    try {
      const r = await client.conversations.info({ channel: channelId });
      name = (r.channel as { name?: string } | undefined)?.name;
    } catch {
      name = undefined; // DM / no access
    }
    nameCache.set(channelId, name);
    return name;
  }

  // Reverse of channelName: resolve a project → the id of its `bluefin-aven-<slug>` channel, so
  // a poller with only a slug (no prior message) can post there. An explicit `slackChannel`
  // override wins; otherwise we page conversations.list and match by name. Only HITS are
  // cached — a miss re-lists next call so a channel created after boot self-heals (the bot
  // must be a member to see a private channel / to post). Used by the investigation poller.
  // Cache is TENANT-keyed: a shared slug resolves to a different channel id in each
  // workspace, and the id only makes sense to that workspace's token.
  const slugChannelCache = new Map<string, string>();
  async function channelIdForSlug(
    client: bolt.webApi.WebClient,
    project: ProjectConfig,
    tenantId?: string,
  ): Promise<string | undefined> {
    if (project.slackChannel) return project.slackChannel;
    const cacheKey = `${tenantId ?? 'home'}:${project.slug}`;
    const cached = slugChannelCache.get(cacheKey);
    if (cached) return cached;
    const want = `${prefix}${project.slug}`;
    let found: string | undefined;
    try {
      let cursor: string | undefined;
      do {
        const r = await client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });
        const hit = (r.channels as Array<{ id?: string; name?: string }> | undefined)?.find(
          (c) => c.name === want,
        );
        if (hit?.id) {
          found = hit.id;
          break;
        }
        cursor = (r.response_metadata as { next_cursor?: string } | undefined)?.next_cursor || undefined;
      } while (cursor);
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
    client: bolt.webApi.WebClient,
    channel: string,
    text: string,
    tenantId?: string,
  ): Promise<{ project?: ProjectConfig; question: string; error?: string }> {
    const mine = teamProjects(reg.current, tenantId, home());
    const scoped = { projects: mine };
    let project = resolveByChannel(scoped, channel);
    let question = text.trim();
    if (!project) {
      const name = await channelName(client, channel);
      if (name && name.startsWith(prefix)) {
        project = resolveBySlug(scoped, name.slice(prefix.length));
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
          ? `This channel isn't bound to a project. Use a \`${prefix}{project}\` channel (e.g. \`${prefix}${mine[0].slug}\`), or prefix your question with a slug — one of: ${slugs}.`
          : `This workspace has no projects configured yet.`,
      };
    }
    return { project, question };
  }

  return { prefix, channelName, channelIdForSlug, pickProject };
}
