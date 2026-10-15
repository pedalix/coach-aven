// The bench's pipeline variants, by name (`npm run lab -- run --variant <name>`). Lazy: a variant's
// dependencies (a store, a model prompt, an index) load only when it is asked for. One line per variant;
// keep it a plain object literal so adding one is a one-line change.

import type { Variant } from '../types.js';

export const VARIANTS: Record<string, () => Promise<Variant>> = {
  baseline: () => import('./baseline.js').then((m) => m.baseline),
};
