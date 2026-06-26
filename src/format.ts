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

// Drop Slack user mentions (<@U…>) from message text.
export function stripMention(text: string): string {
  return text.replace(/<@[^>]+>/g, '').trim();
}
