/**
 * One-time bootstrap for the Microsoft Graph source. Runs ONCE on the operator's machine (WSL2 +
 * Chrome on Windows, or any box with a browser); afterwards the puller refreshes forever without
 * a human. Entry point `runMsgraphAuth(ctx, argv)`, exposed as `orch sources auth <slug> msgraph …`:
 *
 *   login  --tenant <guid> --client <app-id> [--device] [--port 53682]
 *   scopes --account <key|upn> --add ChannelMessage.Read.All
 *   check  [--account <key|upn>]          # run this FROM THE BOT HOST: proves headless refresh works
 *   list | remove --account <key> | admin-consent-url --tenant --client
 *
 * Flow choice (https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow):
 *  - Default: authorization code + PKCE (S256) with a loopback redirect `http://localhost:<port>`.
 *    Entra accepts any port when the platform "Mobile and desktop applications" registers the
 *    bare `http://localhost`. Chrome on Windows reaches the WSL2 listener because WSL2
 *    forwards localhost by default. Public client ⇒ NO client_secret is ever sent.
 *  - `--device`: device code flow for a browserless box. Works, but Microsoft recommends
 *    tenants BLOCK it via Conditional Access "authentication flows", and a session minted this
 *    way stays protocol-tracked (AADSTS530036 later if such a policy appears) — so PKCE first.
 *
 * Authority is ALWAYS the tenant GUID, never /common: it pins the client's tenant for a user that
 * may be a member/guest elsewhere, and avoids the home-tenant ambiguity on refresh.
 *
 * Consent: under the Microsoft-managed default consent policy (default since mid-2025,
 * https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/manage-app-consent-policies)
 * Mail.Read, Calendars.Read, Chat.Read, Files.Read.All and Sites.Read.All are NOT user-
 * consentable. Expect "Need admin approval" (AADSTS65001/90094) on the first login as the
 * normal outcome; `admin-consent-url` prints the one link a tenant admin has to click, after
 * which `login` succeeds. ChannelMessage.Read.All is admin-only by definition and is added later
 * with `scopes --add` (no re-login: the refresh token covers every consented permission).
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import {
  CHANNEL_SCOPE,
  DEFAULT_SCOPES,
  GraphClient,
  GraphError,
  MsTokenStore,
  TokenError,
  USER_AGENT,
  accountKey,
  authority,
  pkcePair,
  scopeString,
  sleep,
  tokenRequest,
  tokenScopes,
  type StoredAccount,
  type TokenResponse,
} from './client.js';
import type { AuthContext } from '../types.js';
import { UsageError } from '../errors.js';

const OPTIONS = {
  tenant: { type: 'string' },
  client: { type: 'string' },
  account: { type: 'string' },
  scopes: { type: 'string' },
  add: { type: 'string', multiple: true },
  device: { type: 'boolean', default: false },
  port: { type: 'string' },
  'no-browser': { type: 'boolean', default: false },
} as const;
type Parsed = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];

// Per-run state, set by runMsgraphAuth. Module-level on purpose: this file is CLI-only and
// runs one action per process; threading three values through a dozen helpers would only
// obscure the OAuth logic they wrap.
let args!: Parsed;
let ctx!: AuthContext;
let store!: MsTokenStore;
const log = (m: string) => ctx.log(m);

function need(name: 'tenant' | 'client', envName: string): string {
  const v = args[name] ?? process.env[envName];
  if (!v) throw new UsageError(`--${name} (or ${envName}) is required`);
  return v;
}

/** `--scopes a,b` replaces the default list; `--scopes +X` appends to it. */
function requestedScopes(): string[] {
  const s = args.scopes;
  if (!s) return DEFAULT_SCOPES;
  if (s.startsWith('+')) return [...DEFAULT_SCOPES, ...s.slice(1).split(',').map((x) => x.trim()).filter(Boolean)];
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

function adminConsentUrl(tenant: string, client: string): string {
  return `https://login.microsoftonline.com/${tenant}/adminconsent?client_id=${client}`;
}

function explainTokenError(e: TokenError, tenant: string, client: string): string {
  const lines = [`Entra refused: ${e.error} (${e.codes.join(',') || e.status})`, `  ${e.description.split(/\r?\n/)[0]}`];
  if (e.codes.includes(65001) || e.codes.includes(90094) || /admin/i.test(e.description)) {
    lines.push('  → One or more scopes need ADMIN consent in this tenant. Send a tenant admin this link and retry afterwards:');
    lines.push(`    ${adminConsentUrl(tenant, client)}`);
  } else if (e.codes.includes(7000218) || e.codes.includes(700025)) {
    lines.push('  → The app registration must be a PUBLIC client: Authentication → "Allow public client flows" = Yes, platform "Mobile and desktop applications" with redirect URI http://localhost.');
  } else if (e.codes.includes(50011)) {
    lines.push('  → Redirect URI mismatch: register http://localhost under "Mobile and desktop applications" (no port, no path).');
  } else if (e.codes.includes(530036)) {
    lines.push('  → Conditional Access blocks the device code flow in this tenant; rerun without --device.');
  } else if (e.needsReauth) {
    lines.push('  → The session is no longer valid headlessly (revoked / forced re-auth). Re-run `orch sources auth <slug> msgraph login`.');
  }
  return lines.join('\n');
}

function openBrowser(url: string): void {
  if (args['no-browser']) return;
  // WSL2: `wslview` (wslu) or cmd.exe reach Chrome on Windows; elsewhere xdg-open/open.
  const candidates: Array<[string, string[]]> = [
    ['wslview', [url]],
    ['/mnt/c/Windows/System32/cmd.exe', ['/c', 'start', '', url.replace(/&/g, '^&')]],
    ['xdg-open', [url]],
    ['open', [url]],
  ];
  for (const [bin, a] of candidates) {
    try {
      const p = spawn(bin, a, { stdio: 'ignore', detached: true });
      p.on('error', () => undefined);
      p.unref();
      return;
    } catch {
      /* try next */
    }
  }
}

// ---------------------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------------------

async function pkceLogin(tenant: string, client: string, scopes: string[]): Promise<TokenResponse> {
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(16).toString('hex');
  const port = Number(args.port ?? 0);
  const pending = { redirect: '' };

  const result = new Promise<{ code: string } | { error: string; description: string }>((resolve) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://localhost');
      if (u.searchParams.get('state') !== state) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('state mismatch — ignore this tab and retry');
        return;
      }
      const code = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
        code ? '<h2>CoachAven sources: signed in. You can close this tab.</h2>' : `<h2>CoachAven sources: ${err}</h2><pre>${u.searchParams.get('error_description') ?? ''}</pre>`,
      );
      server.close();
      resolve(code ? { code } : { error: err ?? 'unknown', description: u.searchParams.get('error_description') ?? '' });
    });
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const p = typeof addr === 'object' && addr ? addr.port : port;
      const redirect = `http://localhost:${p}`;
      const q = new URLSearchParams({
        client_id: client,
        response_type: 'code',
        redirect_uri: redirect,
        response_mode: 'query',
        scope: scopeString(scopes),
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        prompt: 'select_account',
      });
      const url = `${authority(tenant)}/authorize?${q.toString()}`;
      log(`Listening on ${redirect}. Open this URL in a browser and sign in as the tenant account:\n\n${url}\n`);
      openBrowser(url);
      pending.redirect = redirect;
    });
  });
  const r = await result;
  if ('error' in r) throw new TokenError(r.error, r.description, [...r.description.matchAll(/AADSTS(\d+)/g)].map((m) => Number(m[1])), 400);
  return tokenRequest(tenant, {
    client_id: client,
    grant_type: 'authorization_code',
    code: r.code,
    redirect_uri: pending.redirect,
    code_verifier: verifier,
    scope: scopeString(scopes),
  });
}

async function deviceLogin(tenant: string, client: string, scopes: string[]): Promise<TokenResponse> {
  const res = await fetch(`${authority(tenant)}/devicecode`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': USER_AGENT },
    body: new URLSearchParams({ client_id: client, scope: scopeString(scopes) }).toString(),
  });
  const dc = (await res.json()) as { device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number; message: string; error?: string; error_description?: string; error_codes?: number[] };
  if (!res.ok || !dc.device_code) throw new TokenError(dc.error ?? `http_${res.status}`, dc.error_description ?? '', dc.error_codes ?? [], res.status);
  log(`\n${dc.message}\n(code expires in ${Math.round(dc.expires_in / 60)} min)\n`);
  let interval = (dc.interval || 5) * 1000;
  for (;;) {
    await sleep(interval);
    try {
      return await tokenRequest(tenant, { client_id: client, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: dc.device_code });
    } catch (e) {
      if (!(e instanceof TokenError)) throw e;
      if (e.error === 'authorization_pending') continue;
      if (e.error === 'slow_down') {
        interval += 5000;
        continue;
      }
      throw e;
    }
  }
}

async function login(): Promise<number> {
  const tenant = need('tenant', 'MSGRAPH_TENANT_ID');
  const client = need('client', 'MSGRAPH_CLIENT_ID');
  const scopes = requestedScopes();
  log(`Scopes: ${scopes.join(' ')}`);
  let tok: TokenResponse;
  try {
    tok = args.device ? await deviceLogin(tenant, client, scopes) : await pkceLogin(tenant, client, scopes);
  } catch (e) {
    if (e instanceof TokenError) {
      log(explainTokenError(e, tenant, client));
      return 2;
    }
    throw e;
  }
  if (!tok.refresh_token) throw new Error('No refresh_token in the response — was offline_access in the scopes?');

  // Identify the account from Graph itself (needs only User.Read); proves the token works.
  const meRes = await fetch('https://graph.microsoft.com/v1.0/me?$select=id,userPrincipalName,displayName', {
    headers: { authorization: `Bearer ${tok.access_token}`, 'user-agent': USER_AGENT },
  });
  const me = (await meRes.json()) as { id: string; userPrincipalName: string; displayName?: string };
  if (!meRes.ok || !me.id) throw new Error(`GET /me failed: ${meRes.status} ${JSON.stringify(me).slice(0, 300)}`);

  const key = accountKey(tenant, me.userPrincipalName);
  await store.withLock(async () => {
    const st = store.read();
    const prev = st.accounts[key];
    const acct: StoredAccount = {
      key,
      tenant_id: tenant,
      client_id: client,
      upn: me.userPrincipalName,
      user_id: me.id,
      display_name: me.displayName,
      scopes,
      refresh_token: tok.refresh_token!,
      access_token: tok.access_token,
      expires_at: Date.now() + tok.expires_in * 1000,
      obtained_via: args.device ? 'device_code' : 'pkce',
      obtained_at: new Date().toISOString(),
      refresh_count: prev?.refresh_count ?? 0,
    };
    st.accounts[key] = acct;
    store.write(st);
  });
  const granted = tokenScopes(tok.access_token);
  log(`Stored ${key} in ${store.path} (mode 600).`);
  log(`Granted scopes (scp): ${granted.join(' ')}`);
  const missing = scopes.filter((s) => !['openid', 'profile', 'offline_access'].includes(s) && !granted.includes(s));
  if (missing.length) log(`NOT granted (need admin consent?): ${missing.join(' ')} → ${adminConsentUrl(tenant, client)}`);
  log(`Next: run \`orch sources auth ${ctx.slug} msgraph check\` FROM THE BOT HOST (copy ${store.path} there once if you bootstrapped elsewhere), then \`orch sources pull ${ctx.slug}\`.`);
  return 0;
}

// ---------------------------------------------------------------------------------------
// scopes --add  (pick up a newly consented scope via refresh, no re-login)
// ---------------------------------------------------------------------------------------

async function addScopes(): Promise<number> {
  const acct = store.getAccount(args.account ?? firstAccountKey());
  const add = (args.add ?? []).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
  if (!add.length) throw new UsageError(`--add <scope> required (e.g. --add ${CHANNEL_SCOPE})`);
  const wanted = [...new Set([...acct.scopes, ...add])];
  try {
    const updated = await store.refreshAccount(acct.key, wanted);
    const granted = tokenScopes(updated.access_token!);
    const still = add.filter((s) => !granted.includes(s));
    if (still.length) {
      // Entra sometimes issues the token minus the un-consented scope instead of erroring.
      log(`Token issued but WITHOUT: ${still.join(' ')} — admin consent still missing: ${adminConsentUrl(acct.tenant_id, acct.client_id)}`);
      await store.refreshAccount(acct.key, acct.scopes); // roll the stored list back
      return 2;
    }
    log(`OK — ${acct.key} now refreshes with: ${updated.scopes.join(' ')}`);
    return 0;
  } catch (e) {
    if (e instanceof TokenError) {
      log(explainTokenError(e, acct.tenant_id, acct.client_id));
      return 2;
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------------------
// check — run this FROM THE SERVER: proves the refresh path works from its IP without CA blocks
// ---------------------------------------------------------------------------------------

async function check(): Promise<number> {
  const keys = args.account ? [store.getAccount(args.account).key] : Object.keys(store.read().accounts);
  if (!keys.length) throw new Error(`no accounts in ${store.path}`);
  let failed = false;
  for (const key of keys) {
    log(`== ${key}`);
    try {
      const acct = await store.refreshAccount(key); // forced refresh: the thing that must work headlessly
      log(`refresh OK (#${acct.refresh_count}); scp = ${tokenScopes(acct.access_token!).join(' ')}`);
    } catch (e) {
      failed = true;
      log(e instanceof TokenError ? explainTokenError(e, store.getAccount(key).tenant_id, store.getAccount(key).client_id) : String(e));
      continue;
    }
    const g = new GraphClient(store, key, { minIntervalMs: 200 });
    const probes: Array<[string, string, string]> = [
      ['User.Read', 'identity', '/me?$select=userPrincipalName'],
      ['Mail.Read', 'mail', '/me/mailFolders?$top=1&$select=displayName'],
      ['Calendars.Read', 'calendar', '/me/calendarView?startDateTime=2026-01-01T00:00:00Z&endDateTime=2026-01-02T00:00:00Z&$top=1&$select=subject'],
      ['Chat.Read', 'chats', '/me/chats?$top=1&$select=id'],
      ['Team.ReadBasic.All', 'teams', '/me/joinedTeams?$select=id'],
      ['Files.Read.All', 'onedrive', '/me/drive?$select=id'],
      ['Sites.Read.All', 'sites', '/sites?search=*&$select=id&$top=1'],
      [CHANNEL_SCOPE, 'channel posts', '__channels__'],
    ];
    for (const [scope, label, path] of probes) {
      try {
        if (path === '__channels__') {
          const teams = await g.all<{ id: string }>('/me/joinedTeams?$select=id');
          if (!teams.length) {
            log(`  ${label.padEnd(14)} skip (no joined teams)`);
            continue;
          }
          const chans = await g.all<{ id: string }>(`/teams/${teams[0]!.id}/channels?$select=id`);
          if (!chans.length) continue;
          await g.get(`/teams/${teams[0]!.id}/channels/${chans[0]!.id}/messages?$top=1`);
        } else await g.get(path);
        log(`  ${label.padEnd(14)} OK   (${scope})`);
      } catch (e) {
        const msg = e instanceof GraphError ? `${e.status} ${e.code}` : (e as Error).message;
        const hint = e instanceof GraphError && e.status === 403 ? `  ← scope ${scope} not consented; admin link: ${adminConsentUrl(store.getAccount(key).tenant_id, store.getAccount(key).client_id)}` : '';
        log(`  ${label.padEnd(14)} FAIL ${msg}${hint}`);
        if (scope !== CHANNEL_SCOPE) failed = true;
      }
    }
  }
  return failed ? 3 : 0;
}

function firstAccountKey(): string {
  const keys = Object.keys(store.read().accounts);
  if (keys.length !== 1) throw new UsageError(`--account required (known: ${keys.join(', ') || 'none'})`);
  return keys[0]!;
}

/** Dispatch one auth action; returns the process exit code (0 ok, 2 refused/usage, 3 health-check failure). */
export async function runMsgraphAuth(context: AuthContext, argv: string[]): Promise<number> {
  ctx = context;
  store = new MsTokenStore(ctx.tokenPath);
  const parsed = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
  args = parsed.values;
  const cmd = parsed.positionals[0] ?? 'help';
  switch (cmd) {
    case 'login':
      return login();
    case 'scopes':
      return addScopes();
    case 'check':
      return check();
    case 'list': {
      for (const a of Object.values(store.read().accounts)) {
        log(`${a.key}\n  client ${a.client_id} via ${a.obtained_via} at ${a.obtained_at}; refreshed ${a.refresh_count ?? 0}× (last ${a.last_refresh_at ?? 'never'})\n  scopes ${a.scopes.join(' ')}`);
      }
      return 0;
    }
    case 'remove': {
      const key = store.getAccount(args.account ?? firstAccountKey()).key;
      await store.withLock(async () => {
        const st = store.read();
        delete st.accounts[key];
        store.write(st);
      });
      log(`removed ${key} locally (the grant still exists in Entra: revoke under https://myapps.microsoft.com → app → "Revoke permissions" if wanted)`);
      return 0;
    }
    case 'admin-consent-url':
      process.stdout.write(`${adminConsentUrl(need('tenant', 'MSGRAPH_TENANT_ID'), need('client', 'MSGRAPH_CLIENT_ID'))}\n`);
      return 0;
    default:
      throw new UsageError('usage: msgraph login|scopes|check|list|remove|admin-consent-url [--tenant] [--client] [--account] [--scopes a,b|+X] [--add X] [--device] [--port N] [--no-browser]');
  }
}
