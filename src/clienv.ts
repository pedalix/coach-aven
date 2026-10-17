// Running the Claude Code CLI outside the bot's sandboxes — the lab bench (src/lab/llm.ts) and the CLI
// probe (src/cliprobe/) — on the operator's machine, often from inside a Claude Code session. The child
// must neither report to nor wait on the session that launched it, and must not see the operator's own
// configuration (settings, plugins, skills, memory, hooks): it gets a configuration directory of its
// own and the subscription token it was handed, nothing from ~/.claude and nothing from the shell's
// Anthropic credentials.

// The variables a parent Claude Code session sets, plus the shell's ANTHROPIC_* (an API key there would
// silently win over the token the caller chose).
export const PARENT_VARS = /^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_CONFIG_DIR$|AI_AGENT$|ANTHROPIC_)/;

/** Pure: the child's environment — `base` without the parent's variables, then the isolated config dir and the token. */
export function isolatedClaudeEnv(base: NodeJS.ProcessEnv, opts: { configDir: string; token: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!PARENT_VARS.test(k)) env[k] = v;
  env.CLAUDE_CONFIG_DIR = opts.configDir;
  env.CLAUDE_CODE_OAUTH_TOKEN = opts.token;
  return env;
}
