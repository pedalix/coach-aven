// Text for Teams, pure (OpenSpec teams-chat-driver, design D6). The core writes two dialects:
// the agent's GitHub markdown (answers, memory files) and Slack mrkdwn in its own short texts
// (`*bold*`, `:emoji:` shortcodes, `<url|label>` links — the `info()` / `errText()` helpers).
// Teams renders a markdown subset in message text; this file turns both dialects into it and
// splits what is too long for one message.

// Teams rejects messages past ~28 KB; stay well under, as Slack's splitter does.
export const MAX_TEAMS_TEXT = 25_000;

const SHORTCODES: Record<string, string> = {
  information_source: 'ℹ️',
  x: '❌',
  white_check_mark: '✅',
  warning: '⚠️',
  rotating_light: '🚨',
  hourglass_flowing_sand: '⏳',
  ticket: '🎫',
  eyes: '👀',
  shushing_face: '🤫',
  mag: '🔍',
  memo: '📝',
  wrench: '🔧',
  bell: '🔔',
  crescent_moon: '🌙',
  compass: '🧭',
  gear: '⚙️',
  arrows_counterclockwise: '🔄',
  link: '🔗',
  '+1': '👍',
  '-1': '👎',
};

// Slack mrkdwn → Teams markdown. Bold is the one construct that differs (`*x*` vs `**x**`);
// `_italic_`, backticks and bullets are shared. Shortcode emoji become the characters Teams
// shows; unknown codes are left as written rather than dropped.
export function mrkdwnToTeams(s: string): string {
  return (
    s
      // <url|label> and <url> links
      .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '[$2]($1)')
      .replace(/<(https?:\/\/[^>]+)>/g, '$1')
      // *bold* → **bold** (not already-double, not a bullet "• *x*" either — that is bold too)
      .replace(/(^|[^*\w])\*(?!\*)([^*\n]+?)\*(?!\*)/g, '$1**$2**')
      // :shortcode:
      .replace(/:([a-z0-9_+-]+):/g, (m, code: string) => SHORTCODES[code] ?? m)
  );
}

// GitHub markdown as the agent wrote it. Teams renders tables, headings, fenced code, lists and
// links as written (checked in the tenant 2026-10-16 with `textFormat: extendedmarkdown`), so
// nothing is rewritten; the function stays as the one place to add a fix-up if a construct turns
// out to misrender.
export function markdownToTeams(md: string): string {
  return md;
}

// Split at paragraph, then line, then hard boundaries; the parts concatenate to the input.
export function splitText(text: string, max = MAX_TEAMS_TEXT): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut <= 0) cut = rest.lastIndexOf('\n', max);
    if (cut <= 0) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  parts.push(rest);
  return parts;
}

// The bot's mention, as Teams delivers it, removed from a message's text: `<at>Aven</at>` in
// the HTML form, and the plain `@Aven` the client puts in `text`.
export function stripBotMention(text: string, botName: string | undefined): string {
  let t = text.replace(/<at>[^<]*<\/at>/g, '');
  if (botName) t = t.replace(new RegExp(`(^|\\s)@${botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'g'), '$1');
  return t.replace(/\s+/g, ' ').trim();
}
