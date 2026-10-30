// `orch sources auth <slug> wrike check` — who the token is, and whether every configured folder is
// readable with it (the daily credential check runs exactly this). There is no `add`: the permanent
// token (Wrike → Apps & Integrations → API → permanent access token) lives in the env var the config
// names (default WRIKE_API_TOKEN), like a YouTrack block with `tokenEnv`.
import type { AuthContext, WrikeSourcesConfig } from '../types.js';
import { runTrackerAuth } from '../trackers/auth.js';
import { dataOf } from './normalise.js';
import { WRIKE_TOKEN_ENV, wrikeHost, wrikeHttp, wrikeToken } from './pull.js';

async function whoami(cfg: WrikeSourcesConfig): Promise<string> {
  const host = wrikeHost(cfg);
  const http = wrikeHttp(wrikeToken(cfg));
  const me = dataOf((await http.get(`https://${host}/api/v4/contacts?me=true`)).json)[0] ?? {};
  // One call for every folder (the config holds a handful; the API takes up to 100 ids). A folder the
  // token cannot see is missing from the answer — or the whole call is a 400 for a malformed id.
  const seen = new Set(dataOf((await http.get(`https://${host}/api/v4/folders/${cfg.folders.join(',')}`)).json).map((f) => String(f.id ?? '')));
  const missing = cfg.folders.filter((f) => !seen.has(f));
  if (missing.length) throw new Error(`folders not readable with this token: ${missing.join(', ')}`);
  const name = [me.firstName, me.lastName].filter((x) => typeof x === 'string' && x).join(' ');
  return `${host} as ${name || '?'} (${String(me.id ?? '')}), token from ${cfg.tokenEnv ?? WRIKE_TOKEN_ENV}; ${cfg.folders.length} folder(s) readable`;
}

export function runWrikeAuth(ctx: AuthContext, argv: string[], cfg: WrikeSourcesConfig): Promise<number> {
  return runTrackerAuth(ctx, argv, { name: 'wrike', check: () => whoami(cfg) });
}
