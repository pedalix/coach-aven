// J's confidence (design §4.6): never the model's own say-so. A judgment lands in a CELL — how the two passes
// related (agree / arbiter / same umbrella / apart) × whether the cite was grounded — and its confidence is the
// MEASURED precision of that cell: a Beta posterior, prior strength 10, over human answers and audits of units the
// cell decided or proposed. Cells are kept per task kind (call / thread / work / item-human / item-bot / t4 …) and
// each kind's cell is shrunk toward the pooled cell (all kinds), so a kind with three answers borrows from the rest.
//
// Static mode runs on the priors alone: the headline then measures how well the cells SEPARATE right from wrong.
// The invariant: only human rows (answers, audits) and seed rows move a cell — machine output is never evidence.

export type CellId = 'AA+g' | 'AA' | 'AA-none' | 'AA-unreg' | 'AR+g' | 'AR' | 'UU' | 'XX' | 'SP' | 'AA-sys' | 'AA-person' | 'AA-unk';

// Prior means. SP (one pass valid, the other missing or invalid) and the t3 cells are not in the design's table:
// SP sits with UU (one opinion), AA-sys with AA+g (a bot is a bot), AA-person is capped below τ anyway (people exact).
export const PRIOR_MEAN: Record<CellId, number> = {
  'AA+g': 0.93,
  AA: 0.85,
  'AA-none': 0.85,
  'AA-unreg': 0.7,
  'AR+g': 0.8,
  AR: 0.7,
  UU: 0.5,
  XX: 0.3,
  SP: 0.5,
  'AA-sys': 0.93,
  'AA-person': 0.85,
  'AA-unk': 0.7,
};
export const PRIOR_STRENGTH = 10;

export type CellKind = 'call' | 'thread' | 'work' | 'item-human' | 'item-bot' | 't4' | 't4-addr' | 't3';

interface Counts {
  a: number; // right (fractional: one answer = one observation, split over its units)
  b: number; // wrong
}

export class Cells {
  private counts = new Map<string, Counts>();
  constructor(private strength = PRIOR_STRENGTH) {}

  private key = (kind: CellKind, cell: CellId): string => `${kind}|${cell}`;

  /** One observation: `right` ∈ [0,1] is the share of the answer's units the cell got right. */
  observe(kind: CellKind, cell: CellId, right: number): void {
    const k = this.key(kind, cell);
    const c = this.counts.get(k) ?? { a: 0, b: 0 };
    const r = Math.min(1, Math.max(0, right));
    c.a += r;
    c.b += 1 - r;
    this.counts.set(k, c);
  }

  /** The pooled posterior mean of a cell over every kind. */
  pooled(cell: CellId): number {
    let a = 0;
    let b = 0;
    for (const [k, c] of this.counts) {
      if (k.endsWith(`|${cell}`)) {
        a += c.a;
        b += c.b;
      }
    }
    const m = PRIOR_MEAN[cell];
    return (this.strength * m + a) / (this.strength + a + b);
  }

  /** A kind's cell: its own answers on a prior centred on the pooled cell. */
  mean(kind: CellKind, cell: CellId): number {
    const c = this.counts.get(this.key(kind, cell)) ?? { a: 0, b: 0 };
    return (this.strength * this.pooled(cell) + c.a) / (this.strength + c.a + c.b);
  }

  n(kind: CellKind, cell: CellId): number {
    const c = this.counts.get(this.key(kind, cell));
    return c ? c.a + c.b : 0;
  }

  /** Every cell with observations: what the nightly log and the report read. */
  table(): { kind: string; cell: string; a: number; b: number; mean: number }[] {
    return [...this.counts.entries()]
      .map(([k, c]) => {
        const [kind, cell] = k.split('|') as [CellKind, CellId];
        return { kind, cell, a: c.a, b: c.b, mean: this.mean(kind, cell) };
      })
      .sort((x, y) => x.kind.localeCompare(y.kind) || x.cell.localeCompare(y.cell));
  }
}

export interface TieBreaks {
  precedentAgrees?: boolean; // the top precedent carries the label
  inCandidates?: boolean; // the label is among the floor's candidates
  candidatesMiss?: boolean; // the floor had candidates and the label is not among them
}

/** conf = the cell's posterior mean plus the design's tie-breaks (+.005, +.005, −.01), clamped to [0, .999]. */
export function cellConf(cells: Cells, kind: CellKind, cell: CellId, t: TieBreaks = {}): number {
  let c = cells.mean(kind, cell);
  if (t.precedentAgrees) c += 0.005;
  if (t.inCandidates) c += 0.005;
  if (t.candidatesMiss) c -= 0.01;
  return Math.max(0, Math.min(0.999, Math.round(c * 10000) / 10000));
}
