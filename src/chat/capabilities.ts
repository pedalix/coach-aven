// One table of what each chat driver implements (OpenSpec chat-driver-interface): rendered from the drivers' own
// `capabilities` declarations and pinned into docs/chat-drivers.md by capabilities.test.ts, so "where is this
// implemented" has one answer that cannot drift from the code. Pure.

import type { DriverCapabilities } from './driver.js';

// One row per capability, in the order the document shows them.
export const CAPABILITY_ROWS: { key: keyof DriverCapabilities; label: string }[] = [
  { key: 'reactions', label: "Acknowledgements on the person's message (👀 / ✅ / ❌)" },
  { key: 'privateReplies', label: 'Private replies (`native`: in place, only they see it; `fallback`: a direct message with a pointer in the thread)' },
  { key: 'threadRepliesNeedMention', label: 'Replies in a bot thread reach it only with a mention' },
  { key: 'outboundFiles', label: "Outbound files (the agent's outbox is posted into the thread)" },
];

export interface DriverColumn {
  name: string;
  caps: DriverCapabilities;
  // A word beside a cell whose value depends on the installation (Teams' thread replies).
  notes?: Partial<Record<keyof DriverCapabilities, string>>;
}

const cell = (v: boolean | string): string => (v === true ? 'yes' : v === false ? 'no' : `\`${v}\``);

export function capabilitiesTable(drivers: DriverColumn[]): string {
  const head = `| Capability | ${drivers.map((d) => d.name).join(' | ')} |`;
  const sep = `|---|${drivers.map(() => '---').join('|')}|`;
  const rows = CAPABILITY_ROWS.map(
    (r) => `| ${r.label} | ${drivers.map((d) => `${cell(d.caps[r.key])}${d.notes?.[r.key] ? ` — ${d.notes[r.key]}` : ''}`).join(' | ')} |`,
  );
  return [head, sep, ...rows].join('\n');
}

// The document keeps the table between these two lines; the test reads and (UPDATE_SNAPSHOTS=1) rewrites it.
export const TABLE_START = '<!-- capabilities:start -->';
export const TABLE_END = '<!-- capabilities:end -->';

export function tableIn(doc: string): string | undefined {
  const a = doc.indexOf(TABLE_START);
  const b = doc.indexOf(TABLE_END);
  if (a < 0 || b < a) return undefined;
  return doc.slice(a + TABLE_START.length, b).trim();
}

export function replaceTable(doc: string, table: string): string {
  const a = doc.indexOf(TABLE_START);
  const b = doc.indexOf(TABLE_END);
  if (a < 0 || b < a) throw new Error('the document has no capabilities markers');
  return `${doc.slice(0, a + TABLE_START.length)}\n${table}\n${doc.slice(b)}`;
}
