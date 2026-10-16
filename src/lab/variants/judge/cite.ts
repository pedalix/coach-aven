// The cite check (design §4.6), deterministic: a model's cite counts as GROUNDED only when both hold —
//   1. the span really is in the card field the model named (case-, accent- and whitespace-insensitive), and
//   2. the span carries something that supports the claimed label: a registry token of the label (name word, key
//      prefix, title pattern, channel, repo, host/app, company), the name of a person whose marker holds the label,
//      a distinctive token of a precedent with that label (field `precedent`), or — for T4 — a cue of the claimed kind.
// A span copied from the card that names nothing of the label ("let's sync tomorrow") is a quote, not a reason.
// The check never decides anything: it only splits the agreement cells (cells.ts), whose precision is measured.
//
// The cue lexicon (EN/DE/RU/IT) is shared with K's `cue` key (design §3.2).

import { containsTerm, squash, tokens } from './text.js';

export type CueClass = 'Q' | 'R' | 'C' | 'I';

// Whole-word cues per class (folded on use). Q also fires on a '?'.
export const CUES: Record<CueClass, string[]> = {
  Q: ['what', 'when', 'how', 'why', 'where', 'which', 'can you', 'could you', 'do you', 'is it', 'are you', 'wann', 'wie', 'was', 'warum', 'wo', 'kannst', 'können sie', 'когда', 'как', 'что', 'почему', 'где', 'можешь', 'можете', 'ли', 'quando', 'come', 'perché', 'dove', 'puoi', 'potete'],
  R: ['please', 'could you', 'can you', 'would you', 'need you', 'pls', 'bitte', 'könntest', 'könnten sie', 'kannst du', 'пожалуйста', 'сделай', 'сделайте', 'нужно', 'надо', 'посмотри', 'per favore', 'potresti', 'potreste'],
  C: ["i'll", 'i will', "i'm going to", 'will do', 'on it', 'ich mache', 'ich werde', 'mache ich', 'сделаю', 'пришлю', 'посмотрю', 'отправлю', 'farò', 'lo faccio', 'ci penso'],
  I: ['down', 'error', 'errors', 'outage', 'not working', 'broken', 'failed', 'failing', 'crash', 'fehler', 'ausfall', 'geht nicht', 'funktioniert nicht', 'не работает', 'упал', 'упало', 'ошибка', 'сломал', 'errore', 'non funziona', 'guasto'],
};

// The T4 kinds a cue class grounds; info and noise have no positive cue, so they are never "grounded".
export const KIND_CUES: Record<string, CueClass[]> = { question: ['Q'], request: ['R'], commitment: ['C'], incident: ['I'] };

/** Cue classes that fire in a text (sorted). */
export function cuesOf(text: string): CueClass[] {
  const out: CueClass[] = [];
  for (const k of Object.keys(CUES) as CueClass[]) {
    if (k === 'Q' && text.includes('?')) {
      out.push(k);
      continue;
    }
    if (CUES[k].some((w) => containsTerm(text, w))) out.push(k);
  }
  return out;
}

export interface Cite {
  field: string;
  span: string;
}

export interface CiteContext {
  fields: Record<string, string>; // the card's fields (title, text, participants, coactivity) + 'precedent'
  labelTokens: string[]; // registry tokens of the claimed label
  markerNames: string[]; // names of people whose marker holds the label
  precedentTokens?: string[]; // distinctive tokens of shown precedents that carry the label
  kind?: string; // T4: the claimed kind (its cues ground it)
}

export interface CiteVerdict {
  grounded: boolean;
  why: string; // 'no cite' | 'not in <field>' | 'no support' | 'token <t>' | 'person <n>' | 'precedent <t>' | 'cue <c>'
}

export const SPAN_MAX = 60;

/** Normalise a model's cite: {field, span} or a bare string (the span, field unknown). */
export function readCite(raw: unknown): Cite | null {
  if (typeof raw === 'string') return raw.trim() ? { field: '', span: raw.trim() } : null;
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { field?: unknown; span?: unknown };
  const span = typeof r.span === 'string' ? r.span.trim() : '';
  if (!span) return null;
  return { field: typeof r.field === 'string' ? r.field.trim().toLowerCase() : '', span };
}

export function checkCite(cite: Cite | null, ctx: CiteContext): CiteVerdict {
  if (!cite || !cite.span) return { grounded: false, why: 'no cite' };
  // A span longer than asked is still checked (the model may overrun by a word); a whole paragraph is not a cite.
  if (cite.span.length > SPAN_MAX * 2) return { grounded: false, why: 'span too long' };
  const span = squash(cite.span).replace(/^["'«“]+|["'»”]+$/g, '');
  if (span.length < 2) return { grounded: false, why: 'no cite' };
  // The named field; a cite with no or an unknown field may sit in any field (it still has to be there).
  const named = cite.field && cite.field in ctx.fields ? [cite.field] : cite.field ? [] : Object.keys(ctx.fields);
  const where = named.find((f) => squash(ctx.fields[f]).includes(span));
  if (!where) return { grounded: false, why: `not in ${cite.field || 'any field'}` };
  if (ctx.kind) {
    const classes = KIND_CUES[ctx.kind] ?? [];
    const fired = cuesOf(cite.span).filter((c) => classes.includes(c));
    return fired.length ? { grounded: true, why: `cue ${fired.join('')}` } : { grounded: false, why: 'no cue of the kind' };
  }
  const tok = ctx.labelTokens.find((t) => containsTerm(span, t));
  if (tok) return { grounded: true, why: `token ${tok}` };
  const person = ctx.markerNames.find((n) => containsTerm(span, n) || tokens(n, 4).some((w) => containsTerm(span, w)));
  if (person) return { grounded: true, why: `person ${person}` };
  if (where === 'precedent' && ctx.precedentTokens?.length) {
    const p = ctx.precedentTokens.find((t) => containsTerm(span, t));
    if (p) return { grounded: true, why: `precedent ${p}` };
  }
  return { grounded: false, why: 'no support' };
}
