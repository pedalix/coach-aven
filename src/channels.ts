// Channel ↔ project resolution: which project a Slack channel (or a slug-prefixed
// message) maps to, and the reverse (project → its `bluefin-aven-<slug>` channel id).
// Shared by the event handlers, the /aven router, and the pollers.

import type bolt from '@slack/bolt';
import { resolveByChannel, resolveBySlug, type ProjectConfig, type RegistryRef } from './projects.js';
import { log } from './log.js';

export interface Channels {
  readonly prefix: string;
  channelName(client: bolt.webApi.WebClient, channelId: string): Promise<string | undefined>;
  channelIdForSlug(client: bolt.webApi.WebClient, project: ProjectConfig): Promise<string | undefined>;
  pickProject(
    client: bolt.webApi.WebClient,
    channel: string,
    text: string,
  ): Promise<{ project?: ProjectConfig; question: string; error?: string }>;
}

// Channels auto-bind by name: a channel named `${prefix}<slug>` (e.g. bluefin-aven-caldora)
// maps to the project with that slug — no channel ids to wire. An explicit `slackChannel`
// id in the registry still overrides. Names cached per id. Holds the registry REF (not a
// snapshot) so a runtime config reload is visible immediately.
export function createChannels(reg: RegistryRef): Channels {
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
  const slugChannelCache = new Map<string, string>();
  async function channelIdForSlug(
    client: bolt.webApi.WebClient,
    project: ProjectConfig,
  ): Promise<string | undefined> {
    if (project.slackChannel) return project.slackChannel;
    const cached = slugChannelCache.get(project.slug);
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
    if (found) slugChannelCache.set(project.slug, found);
    return found;
  }

  // Resolve the project for a turn: explicit channel-id binding wins → else the
  // `bluefin-aven-<slug>` channel-name wildcard → else a leading <slug> token (handy in
  // DMs) → else the sole project. Returns an error listing slugs when ambiguous.
  async function pickProject(
    client: bolt.webApi.WebClient,
    channel: string,
    text: string,
  ): Promise<{ project?: ProjectConfig; question: string; error?: string }> {
    const registry = reg.current;
    let project = resolveByChannel(registry, channel);
    let question = text.trim();
    if (!project) {
      const name = await channelName(client, channel);
      if (name && name.startsWith(prefix)) {
        project = resolveBySlug(registry, name.slice(prefix.length));
      }
    }
    if (!project) {
      const m = question.match(/^(\S+)\s+([\s\S]+)$/);
      if (m) {
        const bySlug = resolveBySlug(registry, m[1]);
        if (bySlug) {
          project = bySlug;
          question = m[2].trim();
        }
      }
    }
    if (!project && registry.projects.length === 1) project = registry.projects[0];
    if (!project) {
      const slugs = registry.projects.map((p) => p.slug).join(', ');
      return {
        question,
        error: `This channel isn't bound to a project. Use a \`${prefix}{project}\` channel (e.g. \`${prefix}${registry.projects[0]?.slug ?? 'caldora'}\`), or prefix your question with a slug — one of: ${slugs}.`,
      };
    }
    return { project, question };
  }

  return { prefix, channelName, channelIdForSlug, pickProject };
}
