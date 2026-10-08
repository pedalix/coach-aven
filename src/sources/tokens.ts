// Where source credentials live on the BOT HOST: ~/.config/coach-aven/sources/<slug>/<kind>.json
// (XDG_CONFIG_HOME honoured), one file per (project, source kind), mode 600 in a 700 dir.
//
// Why not beside state.json: state.json is deploy-synced and exportable (infra/prod/deploy.sh
// export|import) and a tenant purge may delete data/<slug>; an OAuth grant must survive both
// and never leave the host in an export. Why not `${ENV}` refs like MCP servers: refresh tokens
// ROTATE (Entra on every use, Slack with rotation on) and must be rewritten in place.
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { VaultPaths } from './common/vault.js';
import { assertSlug, vaultDir } from './paths.js';
import type { SourceKind } from './types.js';

export function sourcesConfigRoot(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && xdg.trim() ? xdg : join(homedir(), '.config'), 'coach-aven', 'sources');
}

export function sourcesConfigDir(slug: string): string {
  return join(sourcesConfigRoot(), assertSlug(slug));
}

export function tokenPath(slug: string, kind: SourceKind): string {
  return join(sourcesConfigDir(slug), `${kind}.json`);
}

/**
 * The vault's encrypted files sit with the project's data (they ARE project data), but the
 * recipient (age public key) sits with the credentials: both are operator-owned material that
 * must not travel with a data export. The private key is never on this host at all — decrypt
 * happens wherever the operator keeps `age` keys.
 */
export function vaultPathsFor(slug: string): VaultPaths {
  return { dir: vaultDir(slug), recipientFile: join(sourcesConfigDir(slug), 'vault.recipient') };
}
