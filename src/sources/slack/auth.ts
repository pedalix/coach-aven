/**
 * One-time bootstrap for the Slack source. Runs on the operator's machine, once per workspace.
 * Entry point `runSlackAuth(ctx, argv)`, exposed as `orch sources auth <slug> slack <action> …`:
 *
 *   add [--xapp] [--backfill-days 365] [--probe]   # paste xoxp (+xapp) → verify → store
 *   add --bot | --from-install <team_id>            # a BOT token (pasted, or the CoachAven installation's) → the puller
 *                                                   # reads what the bot is a member of and joins listed public channels
 *   check [--probe]                                 # auth.test every workspace (+ throttle probe)
 *   list
 *   remove <team_id> [--revoke]
 *   exchange --client-id … --client-secret … --redirect-uri … [--code …]
 *
 * Why "paste a token" instead of an OAuth dance: Slack has no device-code flow, redirect URIs
 * must be HTTPS (no plain loopback), and for an app that is only ever installed in the
 * workspace it was created in, the app settings page runs the OAuth flow itself and shows
 * the User OAuth Token — no redirect handler needed. We always *verify* the pasted token with
 * auth.test + users.conversations rather than trust it. Without token rotation the xoxp never
 * expires, so there is no refresh token to store:
 * https://docs.slack.dev/authentication/using-token-rotation
 *
 * `exchange` is the fallback for the rotation-enabled case (12 h access tokens + single-use
 * refresh tokens): it builds the authorize URL, takes the `code` the operator copies from the
 * redirect's address bar (valid 10 min), and stores access + refresh + client credentials.
 */
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { loadStore, saveStore, SlackClient, SlackAuthError, extractUserTokens, redact, type WorkspaceRecord, type TokenStore, type SlackResponse } from './client.js';
import type { AuthContext } from '../types.js';
import { UsageError } from '../errors.js';

interface AuthTest extends SlackResponse {
  team_id: string;
  team: string;
  url: string;
  user_id: string;
  user: string;
}

const USER_SCOPES = ['channels:read', 'groups:read', 'im:read', 'mpim:read', 'channels:history', 'groups:history', 'im:history', 'mpim:history', 'users:read'];

// ---------------------------------------------------------------------------------------
// tiny argv parser: `--k v`, `--flag`, positionals
// ---------------------------------------------------------------------------------------
function parseArgs(argv: string[]): { cmd: string; pos: string[]; flags: Record<string, string | true> } {
  const [cmd = 'help', ...rest] = argv;
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith('--')) {
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[a.slice(2)] = next;
        i++;
      } else flags[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { cmd, pos, flags };
}

/** Masked prompt: tokens must never land in shell history, so we read them interactively (or from env for scripted use). */
async function promptSecret(label: string, envName: string): Promise<string> {
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv.trim();
  const muted = new Writable({ write: (_c, _e, cb) => cb() });
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
  process.stderr.write(`${label} (input hidden; or set ${envName}): `);
  const value = await new Promise<string>((resolve) => rl.question('', resolve));
  rl.close();
  process.stderr.write('\n');
  return value.trim();
}

async function prompt(label: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const value = await new Promise<string>((resolve) => rl.question(`${label}: `, resolve));
  rl.close();
  return value.trim();
}

/** Set per run by runSlackAuth — this module is CLI-only and single-run per process. */
let ctx!: AuthContext;
const log = (m: string): void => ctx.log(m);

function clientFor(store: TokenStore, ws: WorkspaceRecord): SlackClient {
  return new SlackClient(ws, async (updated) => {
    store.workspaces[updated.team_id] = updated;
    await saveStore(store, ctx.tokenPath);
  }, log);
}

/** Pure: which identity a token is — a bot's auth.test carries `bot_id`. */
export function tokenKind(me: { bot_id?: string }): 'user' | 'bot' {
  return me.bot_id ? 'bot' : 'user';
}

/** auth.test proves the token and tells us team/user/url — everything the puller needs to label records. */
async function identify(ws: WorkspaceRecord, store: TokenStore): Promise<WorkspaceRecord> {
  const client = clientFor(store, ws);
  const me = await client.call<AuthTest & { bot_id?: string }>('auth.test');
  return { ...ws, team_id: me.team_id, team: me.team, url: me.url, user_id: me.user_id, user: me.user, kind: tokenKind(me), ...(me.bot_id ? { bot_id: me.bot_id } : {}) };
}

// ---------------------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------------------

async function cmdAdd(flags: Record<string, string | true>): Promise<void> {
  const store = await loadStore(ctx.tokenPath);
  let xoxp: string;
  if (flags['from-install']) {
    // The CoachAven installation of that workspace already holds a bot token (state.json): one
    // install serves chat and ingest — the tenant decides the scope by inviting the bot.
    const teamId = String(flags['from-install']);
    const { Store } = await import('../../state.js');
    const install = new Store().getInstallation(teamId) as { bot?: { token?: string } } | undefined;
    if (!install?.bot?.token) throw new Error(`no CoachAven installation with a bot token for team ${teamId} — install the app there first (bot.aven.guru/slack/install)`);
    xoxp = install.bot.token;
  } else if (flags.bot) {
    xoxp = await promptSecret('Bot User OAuth Token (xoxb-…)', 'SLACK_XOXB');
    if (!xoxp.startsWith('xoxb-')) throw new Error('expected a bot token starting with xoxb- (the "Bot User OAuth Token" on OAuth & Permissions)');
  } else {
    xoxp = await promptSecret('User OAuth Token (xoxp-…)', 'SLACK_XOXP');
    if (!xoxp.startsWith('xoxp-')) throw new Error('expected a user token starting with xoxp- (the "User OAuth Token" on OAuth & Permissions, not the Bot token; use --bot for a bot token)');
  }
  let xapp: string | undefined;
  if (flags.xapp) {
    xapp = await promptSecret('App-Level Token (xapp-…)', 'SLACK_XAPP');
    if (!xapp.startsWith('xapp-')) throw new Error('expected an app-level token starting with xapp-');
  }
  const draft: WorkspaceRecord = {
    team_id: '?', team: '?', url: '?', user_id: '?', user: '?',
    xoxp, xapp,
    backfill_days: Number(flags['backfill-days'] ?? 365),
    added_at: new Date().toISOString(),
  };
  const ws = await identify(draft, store);
  if (store.workspaces[ws.team_id]) log(`replacing existing record for ${ws.team} (${ws.team_id})`);
  store.workspaces[ws.team_id] = ws;
  await saveStore(store, ctx.tokenPath);
  log(`stored ${ws.team} (${ws.team_id}) as ${ws.user} (${ws.user_id}, ${ws.kind ?? 'user'} token) in ${ctx.tokenPath}`);
  await verify(clientFor(store, ws), Boolean(flags.probe));
}

/**
 * Proves the token can actually see conversations and (optionally) that history is not on
 * the 1 req/min / 15-object leash for distributed non-Marketplace apps. Slack never documents
 * what makes an app "internal customer-built", so this empirical check is the only way to
 * know before building a backfill on it
 * (https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps).
 */
async function verify(client: SlackClient, probe: boolean): Promise<void> {
  const convs = await client.call<SlackResponse & { channels: Array<{ id: string; name?: string; is_im?: boolean; is_mpim?: boolean; is_private?: boolean }> }>(
    'users.conversations',
    { types: 'public_channel,private_channel,mpim,im', exclude_archived: true, limit: 999 },
  );
  const n = { pub: 0, priv: 0, mpim: 0, im: 0 };
  for (const c of convs.channels) {
    if (c.is_im) n.im++;
    else if (c.is_mpim) n.mpim++;
    else if (c.is_private) n.priv++;
    else n.pub++;
  }
  log(`  sees ${n.pub} public, ${n.priv} private channels, ${n.mpim} group DMs, ${n.im} DMs (first page)`);
  if (!probe) return;

  const target = convs.channels.find((c) => !c.is_im && !c.is_mpim && c.name === 'general') ?? convs.channels.find((c) => !c.is_im && !c.is_mpim) ?? convs.channels[0];
  if (!target) return log('  probe: no conversation to test on');
  const t0 = Date.now();
  const first = await client.call<SlackResponse & { messages: unknown[]; has_more?: boolean }>('conversations.history', { channel: target.id, limit: 999 });
  // Three more quick calls: a throttled app would 429 on the second within the same minute.
  for (let i = 0; i < 3; i++) await client.call('conversations.history', { channel: target.id, limit: 20 });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const got = first.messages.length;
  const throttled = got <= 15 && first.has_more;
  log(`  probe on ${target.name ?? target.id}: ${got} messages in one call, 4 calls in ${secs}s → ${throttled ? 'THROTTLED (non-Marketplace distributed limits — do NOT build on this app; see README)' : 'full internal-app limits'}`);
}

async function cmdCheck(flags: Record<string, string | true>): Promise<number> {
  const store = await loadStore(ctx.tokenPath);
  const ids = Object.keys(store.workspaces);
  if (!ids.length) { log(`no workspaces in ${ctx.tokenPath} — run: orch sources auth ${ctx.slug} slack add`); return 0; }
  let failures = 0;
  for (const id of ids) {
    const ws = store.workspaces[id]!;
    try {
      const fresh = await identify(ws, store);
      log(`OK  ${fresh.team} (${fresh.team_id}) as ${fresh.user} (${fresh.kind ?? 'user'} token) — token ${redact(ws.xoxp)}${ws.xapp ? `, xapp ${redact(ws.xapp)}` : ''}${ws.rotation ? `, rotation on (expires ${ws.rotation.expires_at})` : ''}`);
      if (fresh.kind !== (ws.kind ?? 'user')) { store.workspaces[id] = fresh; await saveStore(store, ctx.tokenPath); }
      await verify(clientFor(store, fresh), Boolean(flags.probe));
    } catch (err) {
      failures++;
      log(`DEAD ${ws.team} (${id}): ${err instanceof SlackAuthError ? err.code : String(err)} — re-run: orch sources auth ${ctx.slug} slack add`);
    }
  }
  return failures ? 3 : 0;
}

async function cmdList(): Promise<void> {
  const store = await loadStore(ctx.tokenPath);
  for (const ws of Object.values(store.workspaces)) {
    log(`${ws.team_id}  ${ws.team.padEnd(20)} ${ws.user.padEnd(12)} ${(ws.kind ?? 'user').padEnd(4)} backfill ${ws.backfill_days}d  token ${redact(ws.xoxp)}  xapp ${ws.xapp ? 'yes' : 'no'}  rotation ${ws.rotation ? 'yes' : 'no'}  added ${ws.added_at}`);
  }
  log(`(${ctx.tokenPath})`);
}

async function cmdRemove(pos: string[], flags: Record<string, string | true>): Promise<void> {
  const store = await loadStore(ctx.tokenPath);
  const id = pos[0];
  const ws = id ? store.workspaces[id] : undefined;
  if (!id || !ws) throw new UsageError('usage: slack remove <team_id> [--revoke]');
  if (flags.revoke) {
    // auth.revoke invalidates the token server-side — the only "write" this connector ever does, and it is against itself.
    await clientFor(store, ws).call('auth.revoke').catch((e: unknown) => log(`revoke failed (token may already be dead): ${String(e)}`));
  }
  delete store.workspaces[id];
  await saveStore(store, ctx.tokenPath);
  log(`removed ${ws.team} (${id})${flags.revoke ? ', token revoked' : ' (token still valid at Slack; remove the app from the workspace or use --revoke)'}`);
}

/**
 * Rotation fallback. Needs the app's client_id/secret (Basic Information) and an HTTPS
 * redirect URI registered on OAuth & Permissions. The URI does not have to serve anything:
 * Owen copies the `code` query param from the address bar within ten minutes
 * (https://docs.slack.dev/authentication/installing-with-oauth).
 */
async function cmdExchange(flags: Record<string, string | true>): Promise<void> {
  const clientId = String(flags['client-id'] ?? process.env.SLACK_CLIENT_ID ?? '');
  const redirectUri = String(flags['redirect-uri'] ?? '');
  if (!clientId || !redirectUri) throw new UsageError('usage: slack exchange --client-id … --client-secret … --redirect-uri https://… [--code …]');
  const clientSecret = flags['client-secret'] ? String(flags['client-secret']) : await promptSecret('Client secret', 'SLACK_CLIENT_SECRET');
  let code = flags.code ? String(flags.code) : '';
  if (!code) {
    const url = new URL('https://slack.com/oauth/v2/authorize');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('user_scope', USER_SCOPES.join(','));
    url.searchParams.set('redirect_uri', redirectUri);
    log(`open in the browser signed into the target workspace:\n  ${url}\nthen paste the code=… value from the redirect URL (valid 10 minutes)`);
    code = await prompt('code');
  }
  const store = await loadStore(ctx.tokenPath);
  const draft: WorkspaceRecord = { team_id: '?', team: '?', url: '?', user_id: '?', user: '?', xoxp: '', backfill_days: Number(flags['backfill-days'] ?? 365), added_at: new Date().toISOString() };
  const body = await clientFor(store, draft).call('oauth.v2.access', { client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }, { post: true, noAuth: true });
  const au = body.authed_user as { access_token?: string; refresh_token?: string; expires_in?: number } | undefined;
  if (!au?.access_token) throw new Error('oauth.v2.access returned no authed_user.access_token — the app must request user scopes (user_scope), not bot scopes');
  let ws: WorkspaceRecord = { ...draft, xoxp: au.access_token };
  if (au.refresh_token) {
    const t = extractUserTokens(body);
    ws.rotation = { client_id: clientId, client_secret: clientSecret, refresh_token: t.refresh_token, expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString() };
    log('token rotation is ON for this app: access token lives 12 h, refresh token is single-use — the puller refreshes and persists automatically; never run two pulls concurrently');
  }
  ws = await identify(ws, store);
  store.workspaces[ws.team_id] = ws;
  await saveStore(store, ctx.tokenPath);
  log(`stored ${ws.team} (${ws.team_id}) as ${ws.user}`);
  await verify(clientFor(store, ws), Boolean(flags.probe));
}

/** Dispatch one auth action; returns the process exit code (0 ok, 3 = a workspace token is dead). */
export async function runSlackAuth(context: AuthContext, argv: string[]): Promise<number> {
  ctx = context;
  const { cmd, pos, flags } = parseArgs(argv);
  switch (cmd) {
    case 'add': await cmdAdd(flags); return 0;
    case 'check': return cmdCheck(flags);
    case 'list': await cmdList(); return 0;
    case 'remove': await cmdRemove(pos, flags); return 0;
    case 'exchange': await cmdExchange(flags); return 0;
    default:
      throw new UsageError('usage: slack add [--bot | --from-install <team_id>] [--xapp] [--backfill-days N] [--probe] | check [--probe] | list | remove <team_id> [--revoke] | exchange --client-id … --redirect-uri … [--code …]');
  }
}
