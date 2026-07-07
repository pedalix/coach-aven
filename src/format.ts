// Pure text/formatting helpers shared by the Slack layer. No Slack/Daytona deps, so they
// unit-test in isolation (see format.test.ts).

// Pull GitHub PR URLs out of an answer so we can surface them as clickable buttons
// instead of leaving them buried in prose. Deduped, original order.
export function prUrls(text: string): string[] {
  const m = text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g);
  return m ? [...new Set(m)] : [];
}

// Plain-text fallback (notifications / accessibility) required alongside Slack blocks:
// first non-blank line, stripped of markdown punctuation, capped.
export function fallbackText(answer: string): string {
  const line = answer.split('\n').find((l) => l.trim()) ?? 'Answer';
  return line.replace(/[*_`#>~[\]()]/g, '').slice(0, 200) || 'Answer';
}

// Human-readable elapsed time: "45s" under a minute, "2m05s" beyond.
export function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

// Coarse age for ticket headers: "5m", "3h", "2d" — triage needs the magnitude, not seconds.
export function fmtAge(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// Drop Slack user mentions (<@U…>) from message text.
export function stripMention(text: string): string {
  return text.replace(/<@[^>]+>/g, '').trim();
}

// Convert common Markdown to Slack mrkdwn for the message `text` field. We send memory/prompt
// over the ephemeral respond path, which rejects Slack's `markdown` block — so headers, bold,
// and links must be translated to mrkdwn or they show as raw syntax. Real URLs become
// <url|text>; other links (e.g. relative memory topic files) keep their target visible as
// `text (`target`)` so it's still usable with `/aven memory <topic>`.
export function mdToMrkdwn(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>')
    .replace(/\[([^\]]+)\]\(([^)\s]*)\)/g, '$1 (`$2`)')
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
    .replace(/^#{1,6}\s+(.*)$/gm, '*$1*');
}

// Extract `[title](file.md)` links to local topic files from a MEMORY.md index, so the index
// can be rendered with a drill-down button per topic. Only relative `.md` targets with safe
// names (the topic-file convention) — never http links or anything path-y. Deduped by file.
export function parseTopics(index: string): { title: string; file: string }[] {
  const seen = new Set<string>();
  const out: { title: string; file: string }[] = [];
  const re = /\[([^\]\n]+)\]\(([A-Za-z0-9._-]+\.md)\)/g;
  for (let m = re.exec(index); m; m = re.exec(index)) {
    if (!seen.has(m[2])) {
      seen.add(m[2]);
      out.push({ title: m[1].trim(), file: m[2] });
    }
  }
  return out;
}
