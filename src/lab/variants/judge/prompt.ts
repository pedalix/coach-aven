// J's prompts (design §4.4–§4.5). The SYSTEM text is identical across the calls of a run (the closed list rides in
// it, so a provider-side prompt cache can keep it), and its hash is the prompt version `prompt_v` stored with every
// label. The USER prompt is the batch: the case cards, each case's precedents, and the answer schema. Pass B sees
// the same cases with the closed list (and, for T3/T4, the kinds and the roster) permuted — a second framing whose
// agreement with the first means something.
//
// Validation: parseJsonLoose (models wrap JSON in prose now and then); a label outside the closed list gets ONE
// re-ask naming the bad units ("u3: X is not in the list"); whatever is still invalid becomes an abstention with
// rung judge:invalid. Platform-owned text only — no tenant words live here; the tenant enters as data (the list).

import { createHash } from 'node:crypto';
import { parseJsonLoose } from '../../llm.js';
import { KINDS } from '../../types.js';
import { readCite, type Cite } from './cite.js';

export const promptVersion = (system: string): string => createHash('sha256').update(system).digest('hex').slice(0, 10);

// --- t1: attribution ---------------------------------------------------------------------------------------------

export function t1System(closedList: string): string {
  return [
    'You attribute work records of one tenant to its initiatives (billing projects).',
    '',
    'THE CLOSED LIST. Every label you give must be one of these ids, copied exactly.',
    'Each line: id | umbrella | name | billing code | cues (title patterns, channels, key prefixes, repos, hosts/apps, company) | people whose work belongs there.',
    closedList,
    '',
    '- none = not work, noise, or nothing to attribute.',
    '- unregistered = real work on a topic the list lacks. Do not force a fit.',
    '- an admin bucket (an id ending in /admin) = invoices, contracts, payments, visas, taxes for that umbrella.',
    '',
    'RULES',
    '- Judge by content and context, not by source.',
    '- Floor guesses, hints and candidates are weak priors and may be wrong.',
    '- Precedents are past human decisions on similar records.',
    '- A split is allowed only when one record clearly covers two initiatives: at most 2, shares summing to 1.',
    '- Cite a verbatim span of at most 60 characters from the case that justifies the label, and name the field it is in: title, text, participants, coactivity or precedent. If nothing supports any initiative, answer none or unregistered.',
    '- Output JSON only.',
    '',
    'OUTPUT: a JSON array with one object per unit:',
    '[{"unit":"u1","label":"<id>","cite":{"field":"text","span":"<verbatim, at most 60 chars>"},"alt":"<second choice id, or null>"}]',
    'Add "split":[{"label":"<id>","share":0.6},{"label":"<id>","share":0.4}] only for a record that clearly covers two initiatives.',
  ].join('\n');
}

export interface PromptCase {
  card: string; // the rendered case card (units tagged)
  precedents: string[]; // formatted precedent lines
  tags: string[]; // the tags to label in this case
}

export function t1Prompt(cases: PromptCase[]): string {
  const tags = cases.flatMap((c) => c.tags);
  const parts = [`${cases.length} case${cases.length === 1 ? '' : 's'} follow. Label every unit: ${tags.join(', ')}.`, ''];
  cases.forEach((c, i) => {
    parts.push(`### Case ${i + 1}`, c.card, 'Precedents (past human decisions on similar records):', ...(c.precedents.length ? c.precedents.map((p) => `- ${p}`) : ['- (none yet)']), '');
  });
  parts.push(`Answer with the JSON array for ${tags.join(', ')}.`);
  return parts.join('\n');
}

export function arbiterSystem(closedList: string): string {
  return [
    'You arbitrate between two proposed labels for work records of one tenant, attributed to its initiatives (billing projects).',
    '',
    'THE CLOSED LIST (id | umbrella | name | billing code | cues | people):',
    closedList,
    '',
    '- none = not work, noise, or nothing to attribute. unregistered = real work on a topic the list lacks.',
    '- an admin bucket (an id ending in /admin) = invoices, contracts, payments, visas, taxes for that umbrella.',
    '',
    'RULES',
    '- For each unit, choose the better-supported of its two options. Judge by content and context, not by source.',
    '- Weak hints and candidates may be wrong.',
    '- Cite a verbatim span of at most 60 characters from the case that decides it, and name its field: title, text, participants or coactivity.',
    '- Output JSON only: [{"unit":"u3","label":"<one of the two options>","cite":{"field":"text","span":"<verbatim>"}}]',
  ].join('\n');
}

export interface ArbiterCase {
  card: string;
  disputes: { tag: string; options: [string, string] }[];
}

export function arbiterPrompt(cases: ArbiterCase[]): string {
  const tags = cases.flatMap((c) => c.disputes.map((d) => d.tag));
  const parts = [`Two independent readings disagree on ${tags.join(', ')}. Choose for each.`, ''];
  cases.forEach((c, i) => {
    parts.push(`### Case ${i + 1}`, c.card, ...c.disputes.map((d) => `${d.tag}: option 1 = ${d.options[0]} · option 2 = ${d.options[1]}`), '');
  });
  parts.push(`Answer with the JSON array for ${tags.join(', ')}.`);
  return parts.join('\n');
}

// --- t4: kind and addressee --------------------------------------------------------------------------------------

const KIND_DEF: Record<string, string> = {
  request: 'asks someone to do something',
  question: 'asks for information or a decision',
  commitment: 'the author promises to do something',
  incident: 'reports something broken, down or failing',
  info: 'informs; nobody needs to act',
  noise: 'automated, bulk, small talk, or nothing to act on',
};

export function t4System(kindOrder: readonly string[], roster: string[]): string {
  return [
    'You read incoming messages of one tenant and say what kind each is and who must act on it.',
    '',
    'KINDS (exactly one per message):',
    ...kindOrder.map((k) => `- ${k}: ${KIND_DEF[k] ?? k}`),
    '',
    'ROSTER (addressee ids; id | name | company):',
    ...roster,
    '',
    'RULES',
    '- The addressee is who must act or answer: roster ids, or "none" when nobody in particular is asked.',
    '- Judge by the text and its thread, not by the source.',
    '- Cite the cue: a verbatim span of at most 60 characters from the text that shows the kind.',
    '- Output JSON only.',
    '',
    'OUTPUT: a JSON array with one object per message:',
    '[{"unit":"u1","kind":"<kind>","addressee":["<roster id>"],"cue":"<verbatim span>"}]  (addressee may be "none")',
  ].join('\n');
}

export function listPrompt(cards: string[], tags: string[], what: string): string {
  return [`${tags.length} ${what} follow.`, '', ...cards.flatMap((c) => [c, '']), `Answer with the JSON array for ${tags.join(', ')}.`].join('\n');
}

// --- t3: identity ------------------------------------------------------------------------------------------------

export function t3System(roster: string[]): string {
  return [
    'You resolve how people and systems are named in one tenant\'s records.',
    '',
    'ROSTER (id | name | company | identities):',
    ...roster,
    '',
    'LABELS',
    '- "system": a bot, role mailbox, integration or tool — not a person.',
    '- "person:<id>": a roster person. A line that glues several people together: "person:<id>+<id>".',
    '- "unknown": a real person who is not on the roster.',
    '',
    'RULES',
    '- A first name alone is a person only when the context (event attendees, speakers, co-mentions) makes it unique.',
    '- Cite a verbatim span of at most 60 characters from the card that decides it.',
    '- Output JSON only: [{"unit":"u1","label":"person:<id>","cite":"<verbatim span>"}]',
  ].join('\n');
}

// --- answers -----------------------------------------------------------------------------------------------------

export interface Answer {
  unit: string;
  label: string; // canonical (validated) label; t4: the kind
  split?: { label: string; share: number }[];
  cite: Cite | null;
  alt: string | null;
  addressee?: string[] | 'none'; // t4 only
}

export interface Read {
  ok: Map<string, Answer>;
  bad: Map<string, string>; // tag → why ("X is not in the list", "missing", "no JSON")
}

function rows(text: string): unknown[] | null {
  let v: unknown;
  try {
    v = parseJsonLoose(text);
  } catch {
    return null;
  }
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    for (const k of ['units', 'answers', 'labels', 'results', 'items']) {
      const inner = (v as Record<string, unknown>)[k];
      if (Array.isArray(inner)) return inner;
    }
    if (typeof (v as { unit?: unknown }).unit === 'string') return [v];
  }
  return null;
}

const quote = (x: unknown): string => JSON.stringify(typeof x === 'string' ? x.slice(0, 60) : (x ?? null));

/**
 * Read a t1 / t3 answer. `canon` maps a label to its closed-list id (exact, else case-insensitive) or null.
 * A split must have ≤2 parts on valid labels with shares summing to ~1; the primary label is its largest share.
 */
export function readLabels(text: string, tags: readonly string[], canon: (l: string) => string | null): Read {
  const ok = new Map<string, Answer>();
  const bad = new Map<string, string>();
  const want = new Set(tags);
  const list = rows(text);
  if (!list) {
    for (const t of tags) bad.set(t, 'no JSON answer');
    return { ok, bad };
  }
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const tag = typeof o.unit === 'string' ? o.unit.trim() : '';
    if (!want.has(tag) || ok.has(tag)) continue;
    let label = typeof o.label === 'string' ? canon(o.label.trim()) : null;
    let split: Answer['split'];
    if (Array.isArray(o.split) && o.split.length >= 2) {
      const parts = o.split
        .map((s) => (s && typeof s === 'object' ? { label: canon(String((s as { label?: unknown }).label ?? '')), share: Number((s as { share?: unknown }).share) } : null))
        .filter((s): s is { label: string; share: number } => !!s && !!s.label && Number.isFinite(s.share) && s.share > 0);
      const sum = parts.reduce((a, s) => a + s.share, 0);
      if (parts.length === 2 && Math.abs(sum - 1) <= 0.05 && parts[0]!.label !== parts[1]!.label) {
        split = parts.sort((a, b) => b.share - a.share || a.label.localeCompare(b.label));
        label = split[0]!.label;
      }
    }
    if (!label) {
      bad.set(tag, `${quote(o.label)} is not in the list`);
      continue;
    }
    bad.delete(tag);
    const alt = typeof o.alt === 'string' ? canon(o.alt.trim()) : null;
    ok.set(tag, { unit: tag, label, ...(split ? { split } : {}), cite: readCite(o.cite), alt: alt && alt !== label ? alt : null });
  }
  for (const t of tags) if (!ok.has(t) && !bad.has(t)) bad.set(t, 'missing');
  return { ok, bad };
}

/**
 * Read a t4 answer: kind ∈ KINDS, addressee = roster ids or 'none' (models also write ["none"] or []). One call serves
 * both t4 tasks; only what `need` asks for is validated, so a bad addressee never voids a good kind (and the re-ask
 * names only what the task needs).
 */
export function readT4(text: string, tags: readonly string[], roster: ReadonlySet<string>, need: 'kind' | 'addressee' = 'kind'): Read {
  const ok = new Map<string, Answer>();
  const bad = new Map<string, string>();
  const want = new Set(tags);
  const list = rows(text);
  if (!list) {
    for (const t of tags) bad.set(t, 'no JSON answer');
    return { ok, bad };
  }
  const kinds = new Set<string>(KINDS);
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const tag = typeof o.unit === 'string' ? o.unit.trim() : '';
    if (!want.has(tag) || ok.has(tag)) continue;
    const kind = typeof o.kind === 'string' ? o.kind.trim().toLowerCase() : '';
    if (need === 'kind' && !kinds.has(kind)) {
      bad.set(tag, `kind ${quote(o.kind)} is not one of ${[...kinds].join('|')}`);
      continue;
    }
    const raw = o.addressee;
    const ids = (Array.isArray(raw) ? raw : raw === null || raw === undefined ? [] : [raw]).map((x) => String(x ?? '').trim()).filter((x) => x && x.toLowerCase() !== 'none');
    const unknown = ids.filter((x) => !roster.has(x));
    if (need === 'addressee' && unknown.length) {
      bad.set(tag, `addressee ${quote(unknown[0])} is not on the roster`);
      continue;
    }
    const addressee: string[] | 'none' = unknown.length ? 'none' : ids.length ? [...new Set(ids)].sort() : 'none';
    bad.delete(tag);
    ok.set(tag, { unit: tag, label: kinds.has(kind) ? kind : 'info', cite: readCite(o.cue ?? o.cite), alt: null, addressee });
  }
  for (const t of tags) if (!ok.has(t) && !bad.has(t)) bad.set(t, 'missing');
  return { ok, bad };
}

/** The one re-ask: the same batch, the problems named, the answer wanted for the bad units only. */
export function reaskPrompt(original: string, bad: ReadonlyMap<string, string>): string {
  const lines = [...bad.entries()].map(([t, why]) => `- ${t}: ${why}`);
  return `${original}\n\nYour previous answer had problems:\n${lines.join('\n')}\nAnswer again with the JSON array for ${[...bad.keys()].join(', ')} only.`;
}
