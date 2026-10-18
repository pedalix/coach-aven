// Every scenario the probe knows, contract first (design D7). A contract scenario states what the bot
// relies on today; the probed set (cliversion.ts PROBED_CLI_VERSIONS) requires all of them to hold.
import type { ProbeCtx } from '../ctx.js';
import type { Scenario } from '../types.js';
import { CANDIDATES } from './candidates.js';
import { CONTRACT } from './contract.js';
import { DELIVERY } from './delivery.js';
import { SKILLS } from './skills.js';

export const SCENARIOS: Scenario<ProbeCtx>[] = [...CONTRACT, ...DELIVERY, ...SKILLS, ...CANDIDATES];

export const contractIds = (): string[] => SCENARIOS.filter((s) => s.meta.contract).map((s) => s.meta.id);
