// What configures agent messaging (OpenSpec `agent-messaging`, design D2, D8, D18): a project's
// `messaging` block in projects.config.json, and the installation's environment (INSTALLATION_ID,
// HUB_URL, HUB_KEY_PATH). Pure: projects.ts validates the block at load, config.ts reads the env, and
// both are read again at call time — a reload changes what the next call may do.
import { collapseStars, isSkillPattern } from './skills.js';
import { settingPath } from '../paths.js';
import { INSTALLATION_RE, parseTarget } from './protocol.js';

export interface MessagingConfig {
  /** The sending tools (D9): send_message, get_task, cancel_task, agents. */
  send?: boolean;
  /**
   * Who may ask this agent: `<installation>/<agent>`, a bare `<agent>` of the own installation, or `*`
   * for every agent of this agent's own domain (D14). Absent or empty: nobody. No entry covers a whole
   * other domain.
   */
  accept?: string[];
  /** The agent card's one line (D7). */
  description?: string;
  /**
   * Which of the project's own Claude Code skills its card offers (agent-skills): entries that are skill
   * names or globs with `*` (`"newsletter-*"`), and exclusions prefixed with `!` (`"!openspec-*"`), which
   * apply after the inclusions whatever their order. The string `"*"` is shorthand for `["*"]`. Absent:
   * none — a project's skills stay internal unless listed. Every sender the agent accepts sees the same set
   * (narrowing per sender comes with roles). Normalized to the list form at load.
   */
  skills?: string[];
  /** Tasks this agent may start per day. */
  sendPerDay?: number;
  /** New tasks per sender per day this agent takes. */
  acceptPerDay?: number;
  /** `request_input` calls per task; the next one ends it `failed: too many rounds`. */
  maxRounds?: number;
  /** `ask.cost.high` when a task's answering turns cost more (USD, API-equivalent). */
  costWarnUsd?: number;
}

export const MESSAGING_DEFAULTS = { sendPerDay: 50, acceptPerDay: 30, maxRounds: 5, costWarnUsd: 2 } as const;
export const MAX_DESCRIPTION = 300;

/** The limits in force for a configuration: its own values, the defaults for the rest. */
export const messagingLimits = (c: MessagingConfig): { sendPerDay: number; acceptPerDay: number; maxRounds: number; costWarnUsd: number } => ({
  sendPerDay: c.sendPerDay ?? MESSAGING_DEFAULTS.sendPerDay,
  acceptPerDay: c.acceptPerDay ?? MESSAGING_DEFAULTS.acceptPerDay,
  maxRounds: c.maxRounds ?? MESSAGING_DEFAULTS.maxRounds,
  costWarnUsd: c.costWarnUsd ?? MESSAGING_DEFAULTS.costWarnUsd,
});

/** An accept entry as written: `*`, `<installation>/<agent>` or a bare `<agent>`. */
export const isAcceptPattern = (p: unknown): p is string => p === '*' || (typeof p === 'string' && p.trim() === p && parseTarget(p, 'local') !== undefined);

/**
 * Validate a project's `messaging` block. Throws naming the field — like every other projects.config
 * check, a typo fails the boot (or `/aven reload`) instead of silently changing who may ask whom.
 * Fields this release does not know are ignored: an ops repo may be ahead of the bot (prod runs a tag).
 */
export function validateMessagingConfig(x: unknown, where: string): MessagingConfig {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error(`${where} must be an object`);
  const a = x as Record<string, unknown>;
  const out: MessagingConfig = {};
  if (a.send !== undefined) {
    if (typeof a.send !== 'boolean') throw new Error(`${where}.send must be true or false`);
    out.send = a.send;
  }
  if (a.accept !== undefined) {
    if (!Array.isArray(a.accept)) throw new Error(`${where}.accept must be an array`);
    const bad = a.accept.filter((p) => !isAcceptPattern(p));
    if (bad.length) throw new Error(`${where}.accept: ${bad.map((b) => JSON.stringify(b)).join(', ')} is not "*", "<installation>/<agent>" or "<agent>"`);
    out.accept = [...(a.accept as string[])];
  }
  if (a.description !== undefined) {
    if (typeof a.description !== 'string' || a.description.length > MAX_DESCRIPTION || /\n/.test(a.description)) {
      throw new Error(`${where}.description must be one line of at most ${MAX_DESCRIPTION} characters`);
    }
    out.description = a.description;
  }
  if (a.skills !== undefined) {
    const list = a.skills === '*' ? ['*'] : a.skills;
    if (!Array.isArray(list)) throw new Error(`${where}.skills must be "*" or an array of skill names and patterns`);
    const bad = list.filter((n) => !isSkillPattern(n));
    if (bad.length) throw new Error(`${where}.skills: ${bad.map((b) => JSON.stringify(b)).join(', ')} is not a skill name or pattern (kebab-case, \`*\` as a wildcard, a leading \`!\` to exclude; at most 64)`);
    out.skills = [...new Set((list as string[]).map(collapseStars))];
  }
  const int = (k: 'sendPerDay' | 'acceptPerDay' | 'maxRounds', max: number): void => {
    const v = a[k];
    if (v === undefined) return;
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > max) throw new Error(`${where}.${k} must be an integer in [0, ${max}]`);
    out[k] = v as number;
  };
  int('sendPerDay', 1000);
  int('acceptPerDay', 1000);
  int('maxRounds', 20);
  if (a.costWarnUsd !== undefined) {
    if (typeof a.costWarnUsd !== 'number' || !(a.costWarnUsd > 0) || a.costWarnUsd > 1000) throw new Error(`${where}.costWarnUsd must be a number in (0, 1000]`);
    out.costWarnUsd = a.costWarnUsd;
  }
  return out;
}

// ── the installation (D8, D18) ──────────────────────────────────────────────────────────────────
export const DEFAULT_INSTALLATION = 'local';

export interface MessagingEnv {
  /** INSTALLATION_ID: the own installation in every address. `local` is enough inside one installation. */
  installation: string;
  /** The hub client's settings: HUB_URL is set and everything it needs is in place. */
  hub?: { url: string; keyPath: string };
  /** HUB_URL is set but the client cannot start: why (the composition root logs it; local messaging keeps working). */
  hubProblem?: string;
}

/** Read INSTALLATION_ID / HUB_URL / HUB_KEY_PATH. An invalid INSTALLATION_ID throws (it would go into every address). */
export function messagingEnv(env: Record<string, string | undefined>): MessagingEnv {
  const explicit = env.INSTALLATION_ID?.trim() || undefined;
  if (explicit !== undefined && !INSTALLATION_RE.test(explicit)) {
    throw new Error(`INSTALLATION_ID must match [a-z0-9-]{1,32}, got ${JSON.stringify(explicit)}`);
  }
  const installation = explicit ?? DEFAULT_INSTALLATION;
  const url = env.HUB_URL?.trim() || undefined;
  if (!url) return { installation };
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    parsed = undefined;
  }
  if (!parsed || (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:')) return { installation, hubProblem: `HUB_URL must be a wss:// URL, got ${JSON.stringify(url)}` };
  if (!explicit || explicit === DEFAULT_INSTALLATION) return { installation, hubProblem: 'HUB_URL needs an explicit INSTALLATION_ID (not "local")' };
  const keyPath = settingPath(env.HUB_KEY_PATH, env); // relative → the installation directory (installation-directory)
  if (!keyPath) return { installation, hubProblem: 'HUB_URL needs HUB_KEY_PATH (run `orch hub keygen`)' };
  return { installation, hub: { url, keyPath } };
}
