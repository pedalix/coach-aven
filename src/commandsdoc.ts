// docs/commands.md, rendered from the Home tab's cheat-sheet (homeBullets, src/chat/slack/blocks.ts) — the one
// list every user-facing command and button already has to land in (CLAUDE.md), so the docs page cannot drift
// from it: src/commandsdoc.test.ts compares the committed page with this rendering, and
// `UPDATE_SNAPSHOTS=1 npm test` rewrites it on purpose. Pure: Slack mrkdwn in, GitHub markdown out.
import { homeBullets } from './chat/slack/blocks.js';

/** One cheat-sheet bullet as a markdown list item: `• *Title* — text` → `- **Title** — text`. */
export function bulletToMarkdown(bullet: string): string {
  const body = bullet.replace(/^•\s*/, '');
  // mrkdwn bold is *x*, markdown bold is **x**; code spans are left alone (a `*` inside one is literal).
  const parts = body.split(/(`[^`]*`)/);
  return `- ${parts.map((p, i) => (i % 2 ? p : p.replace(/(^|[^\w*])\*([^*\n]+?)\*(?![\w*])/g, '$1**$2**'))).join('')}`;
}

export function commandsDoc(): string {
  const base = homeBullets().map(bulletToMarkdown);
  const messagingOnly = homeBullets({ messaging: true }).filter((b) => !homeBullets().includes(b)).map(bulletToMarkdown);
  return [
    '# Commands and buttons',
    '',
    '<!-- Generated from the Home tab\'s cheat-sheet (homeBullets in src/chat/slack/blocks.ts) by src/commandsdoc.ts.',
    '     Do not edit: change the cheat-sheet, then `UPDATE_SNAPSHOTS=1 npm test`. -->',
    '',
    'What people can do with the agent, as its Home tab tells them. The examples use Slack\'s `/aven`; in Teams and the',
    'web chat a command is `/<verb>` (`/aven <verb>` works too), and the web chat needs no mention: a top-level post in a',
    'room starts a thread ([`web.md`](web.md), [`teams.md`](teams.md)). Operator settings are in',
    '[`configuration.md`](configuration.md).',
    '',
    ...base,
    '',
    '## On an installation with agent messaging',
    '',
    'Shown when a project has a `messaging` block ([`agent-messaging.md`](agent-messaging.md)):',
    '',
    ...messagingOnly,
    '',
  ].join('\n');
}
