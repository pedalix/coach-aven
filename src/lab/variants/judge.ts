// PLACEHOLDER — the iteration-1 agent that owns this file replaces it (design notes/10-design.md).
import type { Variant } from '../types.js';
const todo = (name: string): Variant => ({ name, description: 'not built yet', tasks: [], decide: async () => { throw new Error(`${name}: not built yet`); } });
export const judge: Variant = todo('judge');
