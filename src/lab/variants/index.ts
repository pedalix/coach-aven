// The bench's pipeline variants, by name (`npm run lab -- run --variant <name>`). Lazy: a variant's
// dependencies (a store, a model prompt, an index) load only when it is asked for. One line per variant;
// keep it a plain object literal so adding one is a one-line change.

import type { Variant } from '../types.js';

export const VARIANTS: Record<string, () => Promise<Variant>> = {
  baseline: () => import('./baseline.js').then((m) => m.baseline),
  'prod-today': () => import('./prodtoday.js').then((m) => m.prodToday),
  stage0: () => import('./stage0.js').then((m) => m.stage0Variant),
  keys: () => import('./keys.js').then((m) => m.keys),
  'keys+g': () => import('./keys.js').then((m) => m.keysG),
  judge: () => import('./judge.js').then((m) => m.judge),
};

// Variant parameters for ablations come from the CLI's repeatable --opt key=value (as LAB_OPT_<key>), so a
// sweep needs no new variant names: e.g. --opt machineWeight=1.
export function opt(key: string, fallback: number): number;
export function opt(key: string, fallback: string): string;
export function opt(key: string, fallback: number | string): number | string {
  const v = process.env[`LAB_OPT_${key}`];
  if (v === undefined || v === '') return fallback;
  return typeof fallback === 'number' ? Number(v) : v;
}
