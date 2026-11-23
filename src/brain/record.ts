// Company brain (OpenSpec company-brain): one memory record as the host reads it. The records stay Claude Code's
// own auto-memory files (design D1) — `name`/`description` and a nested `metadata:` block the CLI writes — and the
// contract adds three TOP-LEVEL frontmatter keys the agent is asked for: `kind`, `status`, `ticket`. Pure: a
// record is parsed from its text alone, and a value outside the contract reads as absent (the lint lists it)
// rather than failing — these files are written by a model.

export const KINDS = ['investigation', 'domain', 'method', 'decision'] as const;
export type Kind = (typeof KINDS)[number];
export const STATUSES = ['open', 'answered', 'fixed', 'closed'] as const;
export type Status = (typeof STATUSES)[number];

export interface ParsedRecord {
  title?: string; // frontmatter `name`
  kind?: Kind;
  status?: Status;
  ticket?: string;
  modified?: string; // `metadata.modified` as written (Claude Code's own stamp), when present
  body: string; // the text after the frontmatter
}

const unquote = (v: string): string => v.trim().replace(/^(['"])(.*)\1$/, '$2').trim();

// The frontmatter is the block between a leading `---` line and the next one. Only two shapes matter here:
// `key: value` at column 0, and `key: value` indented under `metadata:` — no YAML library for that.
export function parseRecord(content: string): ParsedRecord {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!m) return { body: content };
  const top = new Map<string, string>();
  const meta = new Map<string, string>();
  let block = '';
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    if (kv[1] === '') {
      block = kv[3] === '' ? kv[2] : '';
      if (kv[3] !== '') top.set(kv[2], unquote(kv[3]));
    } else if (block === 'metadata') meta.set(kv[2], unquote(kv[3]));
  }
  const kind = top.get('kind')?.toLowerCase();
  const status = top.get('status')?.toLowerCase();
  const ticket = top.get('ticket');
  return {
    ...(top.get('name') ? { title: top.get('name') } : {}),
    ...(kind && (KINDS as readonly string[]).includes(kind) ? { kind: kind as Kind } : {}),
    ...(status && (STATUSES as readonly string[]).includes(status) ? { status: status as Status } : {}),
    ...(ticket ? { ticket } : {}),
    ...(meta.get('modified') ? { modified: meta.get('modified') } : {}),
    body: content.slice(m[0].length),
  };
}
