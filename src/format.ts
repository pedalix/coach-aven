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

// Render a finished turn's tool-call trail for the ephemeral "🧭 Show steps" view: a
// step-count/duration header, then one numbered line per step. An oversized trail keeps the
// TAIL (the recent, decisive steps) and notes how many early steps were dropped.
export function trailText(steps: string[], elapsedMs: number, cap = 38000): string {
  const head = `🧭 *${steps.length} step${steps.length === 1 ? '' : 's'} · ${fmtElapsed(elapsedMs)}*`;
  const lines: string[] = [];
  let used = head.length + 40; // headroom for the omission note
  for (let i = steps.length - 1; i >= 0; i--) {
    const line = `${i + 1}. ${steps[i]}`;
    if (used + line.length + 1 > cap) break;
    lines.unshift(line);
    used += line.length + 1;
  }
  const dropped = steps.length - lines.length;
  return [head, ...(dropped ? [`_(first ${dropped} steps omitted)_`] : []), ...lines].join('\n');
}

// One step line from an assistant narration block ("Now let me check the checkout code…") —
// the reasoning path between tool calls that transcripts carry but the trail was dropping.
// First substantive line, markdown punctuation stripped, truncated; undefined when there's
// nothing worth showing (whitespace / separator-only blocks like "---").
export function narrationLabel(text: string, max = 120): string | undefined {
  const line = text
    .split('\n')
    .find((l) => /\w/.test(l))
    ?.replace(/[*_`#>~]/g, '')
    .trim();
  if (!line) return undefined;
  return `💬 _${line.length > max ? `${line.slice(0, max - 1)}…` : line}_`;
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
