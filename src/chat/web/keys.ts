// Web conversation ids, decomposed for the core (OpenSpec web-chat-driver, design D5). The core thinks in
// Slack shapes — a conversation (`conv`) and a thread inside it — and the web driver owns both:
//
//   room:<slug>              a project's room; a thread inside it is the id of its root message
//   pc:<userId>:<slug>       one person's private conversation of a project (the Slack DM equivalent)
//
// Both carry their project, so the channel directory resolves them without a name lookup
// (channels.ts `projectOf`), and a conversation key says where it lives: `web:thread:<rootId>` or
// `web:dm:pc:<userId>:<slug>:<slug>` (the core appends the slug to every DM key — harmless redundancy)
// when the web is an additional surface, bare when it is the installation's default. Generated ids
// (messages, threads) never contain ':' so the key parsers of teamkeys.ts stay unambiguous; a user id
// is the identity provider's subject when it is plain, else a digest of it.

import { createHash, randomBytes } from 'node:crypto';

export const roomConv = (slug: string): string => `room:${slug}`;
export const privateConv = (userId: string, slug: string): string => `pc:${userId}:${slug}`;

export type ParsedConv = { kind: 'room'; slug: string } | { kind: 'private'; user: string; slug: string };

// A conversation id names a directory and a file (history.ts), and it reaches the server from the browser and from
// metadata: its parts must be plain names — a project slug, a user id (userIdOf below) — never `..` or a path (the
// security review of 2026-10-30: `room:../../outside` wrote outside the data directory).
const PLAIN_PART = /^(?!\.{1,2}$)[A-Za-z0-9._@-]{1,128}$/;

export function parseConv(conv: string): ParsedConv | undefined {
  if (conv.startsWith('room:')) {
    const slug = conv.slice('room:'.length);
    return PLAIN_PART.test(slug) ? { kind: 'room', slug } : undefined;
  }
  if (conv.startsWith('pc:')) {
    const i = conv.lastIndexOf(':');
    if (i <= 'pc:'.length) return undefined;
    const user = conv.slice('pc:'.length, i);
    const slug = conv.slice(i + 1);
    return PLAIN_PART.test(user) && PLAIN_PART.test(slug) ? { kind: 'private', user, slug } : undefined;
  }
  return undefined;
}

/** The project a web conversation belongs to (channels.ts `projectOf`). */
export const projectOfConv = (conv: string): string | undefined => parseConv(conv)?.slug;

const PLAIN_SUB = /^[A-Za-z0-9._@-]{1,128}$/;
/** The core's user id for an OIDC subject: the subject itself when plain, else a stable digest (no ':' ever). */
export function userIdOf(sub: string): string {
  return PLAIN_SUB.test(sub) ? sub : `u${createHash('sha256').update(sub).digest('hex').slice(0, 32)}`;
}

/** A fresh message / thread / dialog id: time-ordered, no ':'; `ids()` in tests gives sequential ones. */
export function newId(prefix = 'm'): string {
  return `${prefix}${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
}

/** Where a conversation is read on the web: the room thread, or the person's private page. */
export function pageUrl(baseUrl: string, conv: string, thread?: string): string | undefined {
  const p = parseConv(conv);
  if (!p) return undefined;
  if (p.kind === 'room') return thread ? `${baseUrl}/r/${encodeURIComponent(p.slug)}/t/${encodeURIComponent(thread)}` : `${baseUrl}/r/${encodeURIComponent(p.slug)}`;
  return `${baseUrl}/p/${encodeURIComponent(p.slug)}`;
}
