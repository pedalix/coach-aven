// The model credit an installation's sandboxes run Claude Code on (OpenSpec `api-key-credit`): an Anthropic
// API key or a Claude subscription token, exactly one per installation. Pure: the types, how the CLI's own
// report (`system/init` → `apiKeySource`) maps onto them, and the boot line. Resolving the credit from the
// environment lives in config.ts (resolveCredit); the sandbox's command prefix in project.ts (ccCreditEnv).
// No function here ever takes, returns or formats the credit's VALUE except Credit itself.

export type CreditKind = 'api-key' | 'subscription';
// Where the value came from — for the boot line only; `~/.claude` is a developer machine's own login.
export type CreditSource = 'ANTHROPIC_API_KEY' | 'CLAUDE_CODE_OAUTH_TOKEN' | '~/.claude';
export interface Credit {
  kind: CreditKind;
  value: string;
  source: CreditSource;
}

/** The one boot line (design D3): the kind and where it came from, never the value. */
export function creditBootLine(c: Pick<Credit, 'kind' | 'source'>): string {
  const what = c.kind === 'api-key' ? 'an Anthropic API key' : 'a Claude subscription token';
  const from = c.source === '~/.claude' ? "this machine's ~/.claude login" : c.source;
  return `credit: sandboxes run Claude Code on ${what} (from ${from})`;
}

/**
 * What `apiKeySource` in a `system/init` says the CLI runs on (design D3): `ANTHROPIC_API_KEY` → a key,
 * `none` → no API key, i.e. our subscription token. Anything else (missing on a CLI that dropped the
 * field, `apiKeyHelper`, a `/login` key …) is not a credit we configure → undefined: the caller counts
 * the configured kind and warns.
 */
export function creditFromApiKeySource(v: unknown): CreditKind | undefined {
  if (v === 'ANTHROPIC_API_KEY') return 'api-key';
  if (v === 'none') return 'subscription';
  return undefined;
}

/** The dollar label per credit: a key's are billed at list prices, a subscription's an equivalent. */
export const creditLabel = (k: CreditKind): string => (k === 'api-key' ? 'API key' : 'subscription');
