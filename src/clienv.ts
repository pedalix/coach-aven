// Running the Claude Code CLI outside the bot's sandboxes — the lab bench (src/lab/llm.ts) and the CLI
// probe (src/cliprobe/) — on the operator's machine, often from inside a Claude Code session. The child
// must neither report to nor wait on the session that launched it, and must not see the operator's own
// configuration (settings, plugins, skills, memory, hooks): it gets a configuration directory of its
// own and the credit it was handed — a subscription token, or for the probe an API key (OpenSpec
// api-key-credit D6) — nothing from ~/.claude and nothing from the shell's Anthropic credentials.

import type { CreditKind } from './credit.js';

// The variables a parent Claude Code session sets, plus the shell's ANTHROPIC_* (an API key there would
// silently win over the token the caller chose — and a key run sets its own after stripping them).
export const PARENT_VARS = /^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_CONFIG_DIR$|AI_AGENT$|ANTHROPIC_)/;

/**
 * Pure: the child's environment — `base` without the parent's variables, then the isolated config dir and the
 * credit in the one variable its kind is read from: `token` is the value, `credit` its kind (absent → a
 * subscription token in CLAUDE_CODE_OAUTH_TOKEN, as the lab bench calls it).
 */
export function isolatedClaudeEnv(base: NodeJS.ProcessEnv, opts: { configDir: string; token: string; credit?: CreditKind }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!PARENT_VARS.test(k)) env[k] = v;
  env.CLAUDE_CONFIG_DIR = opts.configDir;
  if (opts.credit === 'api-key') env.ANTHROPIC_API_KEY = opts.token;
  else env.CLAUDE_CODE_OAUTH_TOKEN = opts.token;
  return env;
}
