// Minimal, read-only ~/.netrc reader: `machine <host> login <l> password <p>` (tokens may span
// lines; `default` is ignored on purpose — a project must name its host). Used by the Jira
// connector so an operator's existing Atlassian API token (already used by git/curl on the bot
// host) is reused instead of copied into a second file. Never log `password`.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface NetrcEntry {
  login: string;
  password: string;
}

export function parseNetrc(text: string): Map<string, NetrcEntry> {
  const toks = text.replace(/#.*$/gm, '').split(/\s+/).filter(Boolean);
  const out = new Map<string, NetrcEntry>();
  let host: string | undefined;
  let cur: Partial<NetrcEntry> = {};
  const flush = () => {
    if (host && cur.login !== undefined && cur.password !== undefined) out.set(host.toLowerCase(), { login: cur.login, password: cur.password });
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t === 'machine') {
      flush();
      host = toks[++i];
      cur = {};
    } else if (t === 'default') {
      flush();
      host = undefined;
      cur = {};
    } else if (t === 'login' || t === 'password') {
      cur[t] = toks[++i] ?? '';
    } else if (t === 'account' || t === 'macdef') {
      i++;
    }
  }
  flush();
  return out;
}

export function netrcEntry(host: string, path = process.env.NETRC ?? join(homedir(), '.netrc')): NetrcEntry | undefined {
  try {
    return parseNetrc(readFileSync(path, 'utf8')).get(host.toLowerCase());
  } catch {
    return undefined;
  }
}
