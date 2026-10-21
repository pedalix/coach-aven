// A table pasted into a Slack message (Slack's native tables, 2025) is NOT in the message's `text`:
// it travels as an attachment whose `blocks` hold one `table` block — rows of cells, each a
// `{ type: 'raw_text', text }` or null. The bot read `text` only, so the agent got the sentence before
// the table and nothing else (the home canary, 2026-10-21). Rendered here as a pipe table the agent
// reads like markdown, appended after the text. Pure; tested in tables.test.ts.

interface TableCell {
  type?: string;
  text?: string;
}
interface TableBlock {
  type?: string;
  rows?: (TableCell | null)[][];
}
interface SlackAttachment {
  blocks?: TableBlock[];
}

const cell = (c: TableCell | null): string => (c?.text ?? '').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim();

/** The pipe tables of a message's attachments, one per `table` block; '' when there is none. */
export function renderSlackTables(attachments: unknown): string {
  if (!Array.isArray(attachments)) return '';
  const out: string[] = [];
  for (const a of attachments as SlackAttachment[]) {
    for (const b of a?.blocks ?? []) {
      if (b?.type !== 'table' || !Array.isArray(b.rows)) continue;
      // Rows that are entirely empty (Slack pads a pasted range with them) say nothing.
      const rows = b.rows.filter((r) => Array.isArray(r) && r.some((c) => cell(c) !== '')).map((r) => r.map(cell));
      if (!rows.length) continue;
      const width = Math.max(...rows.map((r) => r.length));
      const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
      // The first non-empty row is the header: a pasted sheet's header or its first data row — the
      // agent sees the columns either way.
      out.push([line(rows[0]!), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n'));
    }
  }
  return out.join('\n\n');
}

/** The message text with its pasted tables appended, for the normalizers. */
export function withSlackTables(text: string, attachments: unknown): string {
  const tables = renderSlackTables(attachments);
  return tables ? (text.trim() ? `${text}\n\n${tables}` : tables) : text;
}
