// K2b's content check (notes/20-iter2.md §K2b.1–2): one cheap model pass over the units the floor would auto-decide on
// a STRUCTURAL rung (a tracker key, a rule, a channel, a repo, a marker), asking which of the decided initiative's own
// options the record's content supports. It is a VETO, not a decision, so one pass is enough:
//   - an answer ≠ X lowers the unit below τ (keys2b.ts) — a model may lower a confidence, never raise one;
//   - an answer = X changes nothing;
//   - no valid answer (a failed call, a label off the unit's list, a unit left out) changes nothing either: the floor's
//     decision stands, exactly as without the check.
// The answer is never memory, never evidence (keys, cells, calibration), never a guess shown to a person.
//
//   closed list  per unit: X ∪ its siblings ∪ none ∪ unregistered (siblings.ts), X not marked and not always first
//   cards        J's (judge/cards.ts), with the unit's own floor guess, hint and candidates left out (cards.ts here)
//   batches      ≤25 units per call, in time order; tags u1… (store ids never reach the model); one call's spend is
//                split evenly over its units (Prediction.costUsd)
// Prompt building and parsing are pure; the call goes through ctx.llm (the bench's metered, cached runner).

import { parseJsonLoose } from '../../llm.js';
import type { LlmLike } from '../../types.js';

export const CHECK_MODEL = 'haiku';
export const PER_CALL = 25;
const CITE_MAX = 60;

export interface CheckUnit {
  id: string;
  decided: string; // X, the structural label
  options: string[]; // the unit's closed list in display order (none, unregistered last)
  card: (tag: string) => string; // the unit's card, written with its tag
  order: string; // batching order (the unit's time), ties by id
}

export interface Verdict {
  label: string; // one of the unit's options
  cite: string; // ≤60 chars, as the model gave it (for the `why` line only)
}

export interface CheckResult {
  verdicts: Map<string, Verdict>; // unit id → its valid answer
  invalid: Set<string>; // unit ids without one (failed call, label off the unit's list, left out)
  cost: Map<string, number>; // unit id → its share of its call's spend
  calls: number;
  errors: string[];
}

/** The system text: identical across every call of a run (no tenant words; the tenant enters as data). */
export function checkSystem(): string {
  return [
    'You check work records of one tenant against the initiatives (billing projects) of one client. A structural rule routed each record to one of its options: a tracker key prefix, a channel, a repository, a calendar title or a person. Such rules are coarse: one client’s tracker, channel or repository often carries several of its initiatives, and some records there are not work at all.',
    '',
    'For each record choose the ONE option its content supports:',
    '- an initiative id from the record’s own options (the initiatives are described above the records: id | umbrella | name | billing code | cues | people);',
    '- none = not work: small talk, greetings, thanks, newsletters, automatic replies, noise, nothing to attribute;',
    '- unregistered = real work for this client on a topic none of the listed initiatives covers. Do not force a fit.',
    '',
    'RULES',
    '- Judge by what the record is about: its subject, its text, the thread before it, the participants, the co-activity.',
    '- Cues (key prefixes, channels, repos, title patterns) say where records of a kind usually go; they do not decide between initiatives that share a client.',
    '- When a work record’s content does not point to one initiative more than to another, choose the initiative whose cues the record carries.',
    `- Cite a verbatim span of at most ${CITE_MAX} characters from the record that supports your choice.`,
    '- Output JSON only.',
    '',
    'OUTPUT: a JSON array with one object per record:',
    '[{"unit":"u1","label":"<one of u1’s options>","cite":"<verbatim, at most 60 chars>"}]',
  ].join('\n');
}

export interface PromptUnit {
  tag: string;
  options: string[];
  card: string;
}

/** The user prompt of one batch: the registry lines of every initiative the batch's options name, then the records. */
export function checkPrompt(batch: readonly PromptUnit[], lineOf: (id: string) => string, special: ReadonlySet<string> = new Set(['none', 'unregistered'])): string {
  const ids = [...new Set(batch.flatMap((u) => u.options).filter((id) => !special.has(id)))].sort();
  const tags = batch.map((u) => u.tag);
  return [
    'INITIATIVES',
    ...ids.map(lineOf),
    '',
    `RECORDS (${batch.length})`,
    ...batch.flatMap((u) => [`### ${u.tag} · options: ${u.options.join(' | ')}`, u.card, '']),
    `Answer with the JSON array for ${tags.join(', ')}.`,
  ].join('\n');
}

const rowsOf = (text: string): unknown[] | null => {
  let parsed: unknown;
  try {
    parsed = parseJsonLoose(text);
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    for (const k of ['records', 'results', 'units', 'answers', 'checks']) {
      const v = (parsed as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v;
    }
    if (typeof (parsed as { unit?: unknown }).unit === 'string') return [parsed];
  }
  return null;
};

const citeOf = (v: unknown): string => {
  const s = typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as { span?: unknown }).span === 'string' ? (v as { span: string }).span : '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > CITE_MAX ? `${t.slice(0, CITE_MAX - 1)}…` : t;
};

/**
 * The model's answer → tag → verdict. Only known tags, first answer per tag, and only a label from THAT unit's options
 * (exact, else case-insensitive): anything else is no verdict — the check is a veto, and garbage must never veto.
 */
export function parseVerdicts(text: string, optionsByTag: ReadonlyMap<string, readonly string[]>): Map<string, Verdict> {
  const out = new Map<string, Verdict>();
  const rows = rowsOf(text);
  if (!rows) return out;
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const tag = typeof o.unit === 'string' ? o.unit.trim() : '';
    const options = optionsByTag.get(tag);
    if (!options || out.has(tag) || typeof o.label !== 'string') continue;
    const raw = o.label.trim();
    const label = options.includes(raw) ? raw : options.find((x) => x.toLowerCase() === raw.toLowerCase());
    if (label) out.set(tag, { label, cite: citeOf(o.cite) });
  }
  return out;
}

/** Fixed batches of ≤`size`, in the given order (the caller sorts by time): one batch = one call. */
export function batchesOf<T>(xs: readonly T[], size = PER_CALL): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/**
 * Check every unit once, ≤`perCall` per call, the calls concurrently (the bench's runner caps concurrency and caches
 * by prompt). A call that fails or throws leaves its units without a verdict — never a veto.
 */
export async function runChecks(
  llm: LlmLike,
  units: readonly CheckUnit[],
  lineOf: (id: string) => string,
  opts: { model?: string; perCall?: number; timeoutMs?: number } = {},
): Promise<CheckResult> {
  const res: CheckResult = { verdicts: new Map(), invalid: new Set(), cost: new Map(), calls: 0, errors: [] };
  if (!units.length) return res;
  const sorted = [...units].sort((a, b) => a.order.localeCompare(b.order) || a.id.localeCompare(b.id));
  const system = checkSystem();
  await Promise.all(
    batchesOf(sorted, opts.perCall ?? PER_CALL).map(async (batch) => {
      const tagged = batch.map((u, i) => ({ u, tag: `u${i + 1}` }));
      const prompt = checkPrompt(
        tagged.map(({ u, tag }) => ({ tag, options: u.options, card: u.card(tag) })),
        lineOf,
      );
      let text = '';
      let usd = 0;
      try {
        const r = await llm.call({ model: opts.model ?? CHECK_MODEL, system, prompt, timeoutMs: opts.timeoutMs ?? 180_000 });
        usd = r.costUsd || 0;
        if (r.error) res.errors.push(r.error);
        else text = r.text;
      } catch (err) {
        res.errors.push(err instanceof Error ? err.message : String(err));
      }
      res.calls++;
      const got = text ? parseVerdicts(text, new Map(tagged.map(({ u, tag }) => [tag, u.options]))) : new Map<string, Verdict>();
      for (const { u, tag } of tagged) {
        res.cost.set(u.id, usd / batch.length);
        const v = got.get(tag);
        if (v) res.verdicts.set(u.id, v);
        else res.invalid.add(u.id);
      }
    }),
  );
  return res;
}
