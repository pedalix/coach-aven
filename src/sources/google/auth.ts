/**
 * One-time bootstrap for the Google source. Runs on the OPERATOR's machine with a browser
 * (laptop, WSL2 + Windows Chrome), never in a sandbox. Entry point `runGoogleAuth(ctx, argv)`,
 * exposed as `orch sources auth <slug> google <action> …`:
 *
 *   client add --name pedalix --json ~/Downloads/client_secret_….json [--audience internal|external]
 *   login  --client pedalix [--account owen@example.com]
 *   dwd    --key ~/Downloads/sa-key.json --account owen@example.com   # primary address, never an alias
 *   check                  # mint a token per account, verify identity + scopes (the daily health check)
 *   list | remove --account <email>
 *
 * Why the loopback flow and not device code: Google's limited-input-device flow only allows a
 * short list of scopes (Calendar, Drive, YouTube, …) and gmail.readonly is not on it —
 * https://developers.google.com/identity/protocols/oauth2/limited-input-device#allowedscopes.
 * For a "Desktop app" client the documented redirect method is the loopback IP address
 * (http://127.0.0.1:port); the OOB copy/paste flow is gone and custom URI schemes exist only for
 * iOS/macOS/UWP client types — https://developers.google.com/identity/protocols/oauth2/native-app.
 *
 * WSL2 detail: in NAT mode a Windows browser reaches a WSL listener via localhost, so Chrome's
 * redirect to http://127.0.0.1:<port>/ lands here (https://learn.microsoft.com/en-us/windows/wsl/networking).
 * If it does not (mirrored-mode quirks, port blocked), Chrome shows "connection refused" with the
 * full redirect URL in the address bar — paste that URL into the terminal and we finish anyway.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import {
  AUTH_URL,
  SCOPES,
  loadStore,
  mintToken,
  missingScopes,
  saveStore,
  tokenInfo,
  tokenPost,
  whoAmI,
  ReauthRequired,
  type DwdAccount,
  type Store,
} from './client.js';
import type { AuthContext } from '../types.js';
import { UsageError } from '../errors.js';

type Args = Record<string, string | true>;
function parseArgs(argv: string[]): { cmd: string[]; opts: Args } {
  const cmd: string[] = [];
  const opts: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { opts[a.slice(2)] = next; i++; }
      else opts[a.slice(2)] = true;
    } else cmd.push(a);
  }
  return { cmd, opts };
}
function need(opts: Args, k: string): string {
  const v = opts[k];
  if (typeof v !== 'string' || !v) throw new UsageError(`missing --${k}`);
  return v;
}
/** Set per run by runGoogleAuth — this module is CLI-only and single-run per process. */
let ctx!: AuthContext;
const log = (...a: unknown[]) => ctx.log(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

// ---------------------------------------------------------------------------------------
// client add — import the JSON downloaded from Google Auth Platform > Clients (Desktop app).
// The secret is visible ONLY at creation time (https://support.google.com/cloud/answer/6158849),
// which is why we import the file rather than ask for the secret interactively.
// ---------------------------------------------------------------------------------------
function clientAdd(store: Store, opts: Args): void {
  const name = need(opts, 'name');
  const raw = JSON.parse(readFileSync(need(opts, 'json'), 'utf8')) as { installed?: { client_id: string; client_secret: string }; web?: unknown };
  if (!raw.installed) {
    throw new UsageError('expected a "Desktop app" client JSON (top-level key "installed"); a "web" client cannot use the loopback redirect');
  }
  const audience = opts.audience === 'external' ? 'external' : 'internal';
  store.clients[name] = { client_id: raw.installed.client_id, client_secret: raw.installed.client_secret, audience, added_at: new Date().toISOString() };
  saveStore(store, ctx.tokenPath);
  log(`stored client '${name}' (${audience}) in ${ctx.tokenPath} — now delete the downloaded JSON`);
}

// ---------------------------------------------------------------------------------------
// login — installed-app authorization-code flow with PKCE over a loopback listener.
// ---------------------------------------------------------------------------------------
async function login(store: Store, opts: Args): Promise<void> {
  const clientName = need(opts, 'client');
  const client = store.clients[clientName];
  if (!client) throw new UsageError(`unknown client '${clientName}' — run: orch sources auth ${ctx.slug} google client add --name ${clientName} --json <file>`);
  const expected = typeof opts.account === 'string' ? opts.account.toLowerCase() : undefined;

  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');

  // Port 0 = any free port; Desktop-app clients accept any port on 127.0.0.1 without pre-registration.
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const redirectUri = `http://127.0.0.1:${port}`;

  const authUrl = new URL(AUTH_URL);
  const q = authUrl.searchParams;
  q.set('client_id', client.client_id);
  q.set('redirect_uri', redirectUri);
  q.set('response_type', 'code');
  q.set('scope', SCOPES.join(' '));
  // offline + consent: installed apps always get a refresh token, but re-running login for an
  // account that already consented must mint a NEW refresh token rather than reuse the old grant.
  q.set('access_type', 'offline');
  q.set('prompt', 'consent');
  q.set('code_challenge', challenge);
  q.set('code_challenge_method', 'S256');
  q.set('state', state);
  if (expected) q.set('login_hint', expected);

  log('\nOpen this URL in Windows Chrome — use an Incognito window and sign in as the EXACT account:');
  log(`\n${authUrl.toString()}\n`);
  log(`Waiting for the redirect on ${redirectUri}/ … (or paste the final http://127.0.0.1:${port}/?code=… URL here and press Enter)`);

  // Race: the browser hits the listener, or the human pastes the redirect URL. Either yields the code.
  const redirect = await new Promise<URL>((resolve, reject) => {
    server.on('request', (req, res) => {
      const u = new URL(req.url ?? '/', redirectUri);
      if (u.pathname !== '/') { res.statusCode = 404; res.end(); return; }
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (u.searchParams.get('error')) {
        res.end('<p>Authorization failed; you can close this tab.</p>');
        reject(new Error(`consent error: ${u.searchParams.get('error')}`));
      } else {
        res.end('<p>CoachAven sources: authorized. You can close this tab and return to the terminal.</p>');
        resolve(u);
      }
    });
    const rl = createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const t = line.trim();
      if (!t) return;
      try { resolve(new URL(t)); } catch { log('not a URL, ignoring'); }
    });
    server.on('close', () => rl.close());
  }).finally(() => server.close());

  if (redirect.searchParams.get('state') !== state) throw new Error('state mismatch — the redirect did not come from this run');
  const code = redirect.searchParams.get('code');
  if (!code) throw new Error('redirect carried no code');

  const tok = await tokenPost(
    { grant_type: 'authorization_code', code, client_id: client.client_id, client_secret: client.client_secret, redirect_uri: redirectUri, code_verifier: verifier },
    expected ?? clientName,
  );
  const refresh = (tok as { refresh_token?: string }).refresh_token;
  if (!refresh) throw new Error('no refresh_token in the response (installed apps always get one — is this really a Desktop-app client?)');

  // The consent screen has per-scope checkboxes; a partial grant would surface as 403s weeks later.
  const missing = missingScopes(tok.scope ?? '');
  if (missing.length) throw new Error(`consent is missing scopes (tick every box and re-run):\n  ${missing.join('\n  ')}`);

  // Tenant hygiene: the token is for whoever was signed in, not for whoever we hoped.
  const me = await whoAmI(tok.access_token);
  if (expected && me.email !== expected) throw new Error(`signed in as ${me.email}, expected ${expected} — token NOT stored. Use an incognito window.`);

  store.accounts[me.email] = { kind: 'oauth', client: clientName, refresh_token: refresh, scopes: tok.scope!.split(' '), granted_at: new Date().toISOString() };
  saveStore(store, ctx.tokenPath);
  log(`stored refresh token for ${me.email} (client '${clientName}', ${client.audience}) in ${ctx.tokenPath}`);
  if (client.audience === 'external') {
    log('NOTE: external client — make sure its publishing status is "In production", otherwise this token dies in 7 days.');
  }
}

// ---------------------------------------------------------------------------------------
// dwd — register a service-account key for an account whose Workspace admin granted
// domain-wide delegation to that SA's client id for exactly our three scopes.
// ---------------------------------------------------------------------------------------
async function dwd(store: Store, opts: Args): Promise<void> {
  const account = need(opts, 'account').toLowerCase();
  const key = JSON.parse(readFileSync(need(opts, 'key'), 'utf8')) as { type?: string; client_email?: string; private_key?: string; private_key_id?: string; client_id?: string };
  if (key.type !== 'service_account' || !key.client_email || !key.private_key) throw new UsageError('not a service-account key JSON');
  const acct: DwdAccount = { kind: 'dwd', client_email: key.client_email, private_key: key.private_key, ...(key.private_key_id ? { private_key_id: key.private_key_id } : {}), scopes: [...SCOPES], granted_at: new Date().toISOString() };
  // Verify before storing: unauthorized_client here means the Admin-console grant is missing,
  // has different scopes, or has not propagated yet (up to 24h).
  const tok = await mintToken(acct, account, store);
  const me = await whoAmI(tok.access_token);
  if (me.email !== account) throw new Error(`token resolved to ${me.email}, expected ${account}`);
  store.accounts[account] = acct;
  saveStore(store, ctx.tokenPath);
  log(`stored DWD credential for ${account} (SA ${key.client_email}, client id ${key.client_id ?? '?'}) — delete the downloaded key file`);
}

// ---------------------------------------------------------------------------------------
// check — the daily health check: every account must still mint, resolve to itself, and hold all scopes.
// ---------------------------------------------------------------------------------------
async function check(store: Store): Promise<number> {
  let bad = 0;
  for (const [account, acct] of Object.entries(store.accounts)) {
    try {
      const tok = await mintToken(acct, account, store);
      const me = await whoAmI(tok.access_token);
      const info = await tokenInfo(tok.access_token);
      const missing = missingScopes(info.scope);
      const problems = [me.email !== account ? `identity=${me.email}` : '', missing.length ? `missing ${missing.length} scope(s)` : ''].filter(Boolean);
      if (problems.length) bad++;
      log(`${problems.length ? 'FAIL' : 'ok  '} ${account} (${acct.kind}${acct.kind === 'oauth' ? `/${acct.client}` : ''}) ${problems.join(', ')}`);
    } catch (e) {
      bad++;
      log(`FAIL ${account}: ${e instanceof ReauthRequired ? 'REAUTH REQUIRED — ' : ''}${(e as Error).message}`);
    }
  }
  return bad ? 3 : 0;
}

/** Dispatch one auth action; returns the process exit code (0 ok, 2 usage, 3 health-check failure). */
export async function runGoogleAuth(context: AuthContext, argv: string[]): Promise<number> {
  ctx = context;
  const { cmd, opts } = parseArgs(argv);
  const store = loadStore(ctx.tokenPath);
  const [c0, c1] = cmd;
  if (c0 === 'client' && c1 === 'add') { clientAdd(store, opts); return 0; }
  if (c0 === 'login') { await login(store, opts); return 0; }
  if (c0 === 'dwd') { await dwd(store, opts); return 0; }
  if (c0 === 'check') return check(store);
  if (c0 === 'list') {
    log(`store: ${ctx.tokenPath}`);
    for (const [n, c] of Object.entries(store.clients)) log(`client ${n}: ${c.client_id} (${c.audience})`);
    for (const [a, x] of Object.entries(store.accounts)) log(`account ${a}: ${x.kind}${x.kind === 'oauth' ? ` via ${x.client}` : ` via ${x.client_email}`}, granted ${x.granted_at}`);
    return 0;
  }
  if (c0 === 'remove') {
    const a = need(opts, 'account').toLowerCase();
    delete store.accounts[a];
    saveStore(store, ctx.tokenPath);
    log(`removed ${a} (revoke the grant at https://myaccount.google.com/permissions as well)`);
    return 0;
  }
  throw new UsageError('usage: google client add --name N --json FILE [--audience internal|external] | login --client N [--account EMAIL] | dwd --key FILE --account EMAIL | check | list | remove --account EMAIL');
}
