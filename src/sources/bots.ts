// Bots and Slack names, decided at store build.
//
// Why at build and not only in the puller: the raw archive already holds months of lines
// written before these rules existed, and the users map (raw/slack/slack.users.json) keeps
// improving (Slack Connect people resolved later). Labels and the bot flag are derived columns:
// recomputed for every row whenever the users map or these rules change.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Integrations seen in real workspaces whose author label is the app name. Lower-case. */
export const KNOWN_BOT_NAMES = new Set([
  'intercom',
  'intercom convert',
  'monto-webhook',
  'sentry',
  'sentry quick analyzer',
  'gleap',
  'zapier',
  'digitalocean',
  'github',
  'gitlab',
  'jira',
  'jira cloud',
  'youtrack',
  'asana',
  'google calendar',
  'google drive',
  'slackbot',
  'grafana',
  'alertmanager',
  'uptime robot',
  'uptimerobot',
  'stripe',
  'vercel',
  'netlify',
  'datadog',
  'pagerduty',
  'coach-aven',
  'coachaven',
]);

// Mail senders that are machines: no-reply aliases, notification relays, calendar invites.
const BOT_MAIL_LOCAL = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|notifications?|notify|alerts?|mailer-daemon|postmaster|bounces?|calendar-notification|gemini-notes|comments-noreply|drive-shares-dm-noreply|automated|system|robot|info-noreply)([+.-].*)?$/i;
const BOT_MAIL_DOMAIN = /(^|\.)(noreply\.github\.com|accountprotection\.microsoft\.com|calendar\.google\.com|bounce\.|amazonses\.com|sendgrid\.net|mailchimp|mandrillapp\.com)$/i;

export interface SlackUserInfo {
  label: string;
  handle: string;
  isBot: boolean;
}

/** id → label/handle/bot for every user in every workspace's cached users.list (+ users.info). */
export type SlackDirectory = Map<string, SlackUserInfo>;

interface RawCacheUser {
  id?: string;
  name?: string;
  real_name?: string;
  is_bot?: boolean;
  is_app_user?: boolean;
  profile?: { display_name?: string; real_name?: string };
}

/** Parse slack.users.json text (the puller's cache). Malformed → empty map, never a throw. */
export function parseSlackDirectory(text: string): SlackDirectory {
  const out: SlackDirectory = new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== 'object') return out;
  for (const ws of Object.values(parsed as Record<string, unknown>)) {
    const users = (ws as { users?: unknown })?.users;
    if (!Array.isArray(users)) continue;
    for (const u of users as RawCacheUser[]) {
      if (!u || typeof u.id !== 'string') continue;
      const label = u.profile?.display_name || u.real_name || u.profile?.real_name || u.name || u.id;
      out.set(u.id, { label, handle: u.name ? `@${u.name}` : u.id, isBot: u.is_bot === true || (u.is_app_user === true && u.id !== 'USLACKBOT') });
    }
  }
  return out;
}

export function slackDirectoryPath(rawDir: string): string {
  return join(rawDir, 'slack', 'slack.users.json');
}

export function slackDirectoryText(rawDir: string): string {
  const p = slackDirectoryPath(rawDir);
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

const SLACK_ID = /^[UWB][A-Z0-9]{6,}$/;

/** `dm:U0…` / `mpim:@a+U0…` → names; anything else unchanged. */
export function resolveSlackContainer(container: string, dir: SlackDirectory): string {
  if (container.startsWith('dm:')) {
    const id = container.slice(3);
    const u = SLACK_ID.test(id) ? dir.get(id) : undefined;
    return u ? `dm:${u.handle}` : container;
  }
  if (container.startsWith('mpim:')) {
    return `mpim:${container
      .slice(5)
      .split('+')
      .map((p) => (SLACK_ID.test(p) && dir.get(p) ? dir.get(p)!.handle : p))
      .join('+')}`;
  }
  return container;
}

/** A Slack author/participant that is still a raw id → its display label when known. */
export function resolveSlackName(name: string, dir: SlackDirectory): string {
  return SLACK_ID.test(name) ? (dir.get(name)?.label ?? name) : name;
}

/**
 * Is this author a machine? `explicit` is the puller's own flag (bot_id / bot_message), which
 * wins. Slack: a users-map bot/app, or a known integration name. Mail: a no-reply/notification
 * sender. Unknown humans (Slack Connect guests whose label is still an id) are NOT bots.
 */
export function isBotAuthor(source: string, author: string, dir: SlackDirectory, explicit?: boolean): boolean {
  if (explicit === true) return true;
  const a = author.trim();
  if (!a) return false;
  const lower = a.toLowerCase();
  if (KNOWN_BOT_NAMES.has(lower)) return true;
  if (source === 'slack') {
    if (SLACK_ID.test(a)) return dir.get(a)?.isBot ?? false;
    for (const u of dir.values()) if (u.label === a) return u.isBot;
    return false;
  }
  const email = lower.match(/<?([^<>\s]+@[^<>\s]+)>?$/)?.[1];
  if (email) {
    const [local = '', domain = ''] = email.split('@');
    return BOT_MAIL_LOCAL.test(local) || /no-?reply/.test(local) || BOT_MAIL_DOMAIN.test(domain);
  }
  return false;
}
