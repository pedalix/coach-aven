// Teams conversation ids, decomposed for the core (OpenSpec teams-chat-driver, design D3).
//
// A channel activity's `conversation.id` is `<channel id>;messageid=<root message id>`: the
// channel plus the reply chain the message belongs to. The core thinks in Slack shapes — a
// conversation (`conv`) and a thread inside it — so a Teams channel id is the `conv` and the
// root message id is the `thread`. A personal (1:1) chat has no reply chains: its id is the
// `conv`, the thread stays undefined. Channel ids carry ':' and '@' (`19:…@thread.tacv2`);
// the only key shape that embeds a `conv` is `dm:<conv>:<slug>`, whose slug is the LAST
// segment (teamkeys.slugOfBase), so the extra ':' is harmless. Thread keys embed only the
// root message id (digits).

const MESSAGE_ID = ';messageid=';

// The conversation without its reply-chain suffix, and the chain's root when there is one.
export function splitConversation(conversationId: string): { conv: string; root?: string } {
  const i = conversationId.indexOf(MESSAGE_ID);
  if (i < 0) return { conv: conversationId };
  return { conv: conversationId.slice(0, i), root: conversationId.slice(i + MESSAGE_ID.length) || undefined };
}

// The id the Connector API wants for a send: the chain (`<conv>;messageid=<thread>`) when the
// core targets a thread, the bare conversation otherwise (a new root post in a channel, or a
// 1:1 chat).
export function targetId(conv: string, thread?: string): string {
  return thread ? `${conv}${MESSAGE_ID}${thread}` : conv;
}

// Where an inbound channel message sits for the core: `thread` is the chain root when the
// message is a REPLY; a message that starts its own chain (the root id is its own id) has no
// thread yet — exactly a Slack top-level mention, whose thread the core then opens on its id.
export function threadOf(conversationId: string, activityId: string): string | undefined {
  const { root } = splitConversation(conversationId);
  return root && root !== activityId ? root : undefined;
}

// A deep link to a channel message (the thread root), for the "see the thread" line.
export function deepLink(conv: string, messageId: string, tenantId: string): string | undefined {
  if (!conv.includes('@thread')) return undefined; // 1:1 chats have no shareable link
  return `https://teams.microsoft.com/l/message/${encodeURIComponent(conv)}/${messageId}?tenantId=${tenantId}`;
}
