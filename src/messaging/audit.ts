// `/aven asks` (OpenSpec `agent-messaging`, design D17): what an installation's operators see of the tasks
// between agents — every tenant, both directions, inside the installation and across, held ones first.
// Pure rendering (mrkdwn, Slack and Teams both get it through `say`); the runtime gathers the rows.
import type { TaskState } from './a2a.js';
import type { JournalEntry } from '../chat/shadow/driver.js';

export interface AskRow {
  dir: 'out' | 'in';
  id: string;
  /** The agent of this installation (asker for `out`, answerer for `in`) and its tenant (undefined = home). */
  slug: string;
  tenant?: string;
  /** The other side: the target (`out`) or the origin (`in`). */
  peer: string;
  state: TaskState | 'held';
  reason?: string;
  createdAt: string;
  updatedAt: string;
  /** USD, API-equivalent: metering for turns run here, the reported cost for answers from another installation. */
  cost?: number;
  question: string;
  /** The skill the task asked for (agent-skills). */
  skill?: string;
  answer?: string;
  /** Why it is held (a held message). */
  why?: string;
}

export const ASKS_LIMIT = 50;
const first = (t: string | undefined, n = 80): string => {
  const line = (t ?? '').split('\n').find((l) => l.trim()) ?? '';
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};
const when = (iso: string): string => iso.replace('T', ' ').slice(5, 16); // MM-DD HH:MM (UTC)
const ICON: Record<string, string> = { held: '✋', submitted: '⏳', working: '⏳', 'input-required': '❔', completed: '✅', failed: '⚠️', canceled: '🚫', rejected: '⛔' };

export function asksList(rows: readonly AskRow[]): string {
  if (!rows.length) return 'No tasks between agents yet.';
  const sorted = [...rows].sort((a, b) => (a.state === 'held') !== (b.state === 'held') ? (a.state === 'held' ? -1 : 1) : b.updatedAt.localeCompare(a.updatedAt)).slice(0, ASKS_LIMIT);
  const lines = sorted.map((r) => {
    const arrow = r.dir === 'out' ? `${r.slug} → ${r.peer}` : `${r.slug} ← ${r.peer}`;
    const state = `${r.state}${r.reason ? ` (${r.reason})` : ''}`;
    const span = r.createdAt === r.updatedAt ? when(r.createdAt) : `${when(r.createdAt)} → ${when(r.updatedAt).slice(6)}`;
    const cost = r.cost !== undefined ? ` · $${r.cost.toFixed(2)}` : '';
    const tenant = r.tenant ? ` · tenant ${r.tenant}` : '';
    const skill = r.skill ? ` · skill ${r.skill}` : '';
    const q = `“${first(r.question)}”`;
    const a = r.answer ? ` → “${first(r.answer)}”` : r.why ? ` — held: ${r.why}` : '';
    return `${ICON[r.state] ?? '•'} ${arrow} · ${state} · ${span}${cost}${skill}${tenant} · \`${r.id}\`\n    ${q}${a}`;
  });
  return [`*Tasks between agents* — the last ${sorted.length}${rows.length > sorted.length ? ` of ${rows.length}` : ''}, held first (times UTC)`, ...lines, '_`/aven asks <task id>` shows a transcript; `/aven asks cancel <task id>` cancels a task._'].join('\n');
}

/** A task's transcript: its record, and for a task answered here the shadow conversation's journal. */
export function asksTranscript(row: AskRow, journal: readonly JournalEntry[]): string {
  const head = [
    `*Task \`${row.id}\`* — ${row.dir === 'out' ? `${row.slug} → ${row.peer}` : `${row.slug} ← ${row.peer}`} · ${row.state}${row.reason ? ` (${row.reason})` : ''}${row.skill ? ` · skill ${row.skill}` : ''}`,
    `Question:\n${quote(row.question)}`,
    ...(row.answer ? [`Last message:\n${quote(row.answer)}`] : []),
  ];
  if (row.dir === 'out') return [...head, '_Asked from here: the answering side keeps the transcript of its turns._'].join('\n\n');
  const steps: string[] = [];
  for (const e of journal) {
    const v = e.view as { kind: string; line?: string; markdown?: string; text?: string };
    if (v.kind === 'answer' && v.markdown) steps.push(`*${when(e.at)} answer*\n${quote(v.markdown)}`);
    else if (v.kind === 'text' && v.text) steps.push(`${when(e.at)} ${v.text}`);
  }
  return [...head, steps.length ? `*The shadow conversation*\n${steps.join('\n')}` : '_No turn has been journaled for it yet._'].join('\n\n');
}

const quote = (t: string): string =>
  t
    .slice(0, 3000)
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
