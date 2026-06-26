// Pure path helpers for a project's Claude Code auto memory. Claude Code writes auto memory
// to ~/.claude/projects/<cwd with '/'→'-'>/memory/ inside the sandbox — keyed off the same
// session cwd the transcript uses (see sessionTranscriptValid in tasks.ts). Kept pure and
// tested so the path mapping — and the topic sanitization that guards the shell `cat` in
// slack.ts — can't silently drift or open a path-traversal hole.

// The auto-memory directory for a session whose working directory is `cwd`.
export function memoryDir(cwd: string): string {
  return `/root/.claude/projects/${cwd.replace(/\//g, '-')}/memory`;
}

// Absolute path to a memory file: the MEMORY.md index by default, or a named topic file.
// Returns null when the topic is unsafe — only [A-Za-z0-9_-] is allowed (an optional `.md`
// suffix is stripped first), so a user-supplied topic can't escape the memory dir (no `/`,
// no `..`, no shell metacharacters) when interpolated into a `cat`.
export function memoryFilePath(cwd: string, topic?: string): string | null {
  const dir = memoryDir(cwd);
  if (!topic) return `${dir}/MEMORY.md`;
  const base = topic.replace(/\.md$/i, '');
  if (!/^[A-Za-z0-9_-]+$/.test(base)) return null;
  return `${dir}/${base}.md`;
}
