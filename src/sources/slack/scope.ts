// Which conversations a project's Slack pull may read (docs/sources.md → Config, `slack.channels`
// and `slack.kinds`). users.conversations returns everything the token's user is a member of —
// for a personal store that is the point, for a tenant store (Bluefin's shared channels inside Owen's
// workspace) it would drag the user's DMs and internal channels across the tenant boundary. This
// module is the pure selection step; with no scope configured it keeps everything, exactly as
// the pull behaved before the allow-list existed (rollout bucket 2).
import type { SlackConversationKind } from '../types.js';
import type { RawConversation } from './normalise.js';

export interface SlackScope {
  /** Channel names (with or without `#`) or conversation ids; DMs/MPIMs have no name — list them by id. */
  channels?: readonly string[];
  /** Subset of channel (public), group (private), im, mpim. */
  kinds?: readonly SlackConversationKind[];
}

/** Slack's own vocabulary: public → channel, private → group, direct → im, group direct → mpim. */
export function conversationKind(c: RawConversation): SlackConversationKind {
  return c.is_im ? 'im' : c.is_mpim ? 'mpim' : c.is_private ? 'group' : 'channel';
}

/** Normalised match key for a configured entry: `#Name` → `name`, ids as-is lower-cased. */
export function channelKey(entry: string): string {
  return entry.replace(/^#/, '').trim().toLowerCase();
}

export interface Selection {
  kept: RawConversation[];
  skipped: RawConversation[];
  /** False when no scope is configured — the caller logs nothing then. */
  scoped: boolean;
}

/**
 * Keep a conversation when it is listed (by id or name, case-insensitive) AND its kind is allowed.
 * A listed name that no longer exists simply matches nothing — the skip log is where one notices.
 */
export function selectConversations(convs: readonly RawConversation[], scope: SlackScope): Selection {
  const keys = scope.channels ? new Set(scope.channels.map(channelKey).filter(Boolean)) : undefined;
  const kinds = scope.kinds ? new Set(scope.kinds) : undefined;
  if (!keys && !kinds) return { kept: [...convs], skipped: [], scoped: false };
  const kept: RawConversation[] = [];
  const skipped: RawConversation[] = [];
  for (const c of convs) {
    const listed = !keys || keys.has(c.id.toLowerCase()) || (!!c.name && keys.has(c.name.toLowerCase()));
    const allowedKind = !kinds || kinds.has(conversationKind(c));
    (listed && allowedKind ? kept : skipped).push(c);
  }
  return { kept, skipped, scoped: true };
}
