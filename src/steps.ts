// Pure step-line rendering for the live status / "🧭 Show steps" trail: one human-readable
// line per agent tool call. Kept free of Slack/Daytona deps so it unit-tests in isolation
// (steps.test.ts); the stream plumbing that calls this lives in claudeSession.ts.

function truncate(s: unknown, n = 50): string {
  const str = typeof s === 'string' ? s : '';
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}
function shortPath(p: unknown): string {
  const s = typeof p === 'string' ? p : '';
  return s.length > 56 ? '…' + s.slice(-55) : s;
}

// The most telling string argument of an unknown/MCP tool call, for a one-line preview.
function argPreview(input: Record<string, unknown>): string {
  for (const k of ['query', 'id', 'url', 'prompt', 'pattern', 'name']) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return ` ${truncate(v, 45)}`;
  }
  const v = Object.values(input).find((x) => typeof x === 'string' && (x as string).trim());
  return v ? ` ${truncate(v as string, 45)}` : '';
}

// `subtaskSeq` numbers a Task/Agent spawn ("🤖 Subtask 2: …") so its children — prefixed
// ↳2 by the caller — stay attributable when several subagents run in parallel.
export function stepLabel(name: string, input: Record<string, unknown> = {}, subtaskSeq?: number): string {
  switch (name) {
    case 'Read':
      return `📖 Read ${shortPath(input.file_path ?? input.path)}`;
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return `✏️ Edit ${shortPath(input.file_path ?? input.notebook_path ?? input.path)}`;
    case 'Grep':
      return `🔍 Grep ${truncate(input.pattern)}`;
    case 'Glob':
      return `🔍 Glob ${truncate(input.pattern)}`;
    case 'Bash':
      return `⚙️ ${truncate(input.command, 70)}`;
    case 'Task':
    case 'Agent':
      return `🤖 Subtask${subtaskSeq ? ` ${subtaskSeq}` : ''}: ${truncate(input.description ?? input.prompt)}`;
    case 'WebFetch':
      return `🌐 Fetch ${truncate(input.url)}`;
    case 'WebSearch':
      return `🌐 Search ${truncate(input.query)}`;
    case 'TodoWrite':
      return '📝 Updating plan…';
    default: {
      // MCP tools stream as mcp__<server>__<tool> — render "🔌 server: tool <key arg>"
      // so e.g. a YouTrack search reads as a search, not as a raw identifier.
      const mcp = name.match(/^mcp__(.+?)__(.+)$/);
      if (mcp) return `🔌 ${mcp[1]}: ${mcp[2]}${argPreview(input)}`;
      return `🔧 ${name}`;
    }
  }
}
