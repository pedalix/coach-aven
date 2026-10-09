// `orch sources auth <slug> meetings <granola|wispr|gmeet> <action>`
//   granola add [--token-env NAME]   store the Personal API key (verified first)
//   granola check                    one list call
//   wispr login [--device]           browser OAuth (PKCE, loopback 127.0.0.1:53682); --device = device code
//   wispr check                      refresh + MCP initialize
//   gmeet check                      uses the google token; nothing of its own to store
// `check` with no provider checks every configured provider (what the daily poller check runs).
import { existsSync, rmSync } from 'node:fs';
import { UsageError } from '../errors.js';
import { loadStore } from '../google/client.js';
import { parseFlags, readSecret } from '../trackers/auth.js';
import { writeTokenFile } from '../trackers/writer.js';
import { tokenPath } from '../tokens.js';
import type { AuthContext, MeetingsSourcesConfig } from '../types.js';
import { checkGranola } from './granola.js';
import { granolaTokenPath, wisprTokenPath } from './pull.js';
import { WisprMcp, accessToken, browserLogin, deviceLogin } from './wispr.js';

async function checkWispr(slug: string): Promise<{ ok: boolean; line: string }> {
  const p = wisprTokenPath(slug);
  if (!existsSync(p)) return { ok: false, line: `wispr: no credentials in ${p} — run: orch sources auth ${slug} meetings wispr login` };
  try {
    const mcp = new WisprMcp(await accessToken(p));
    await mcp.init();
    return { ok: true, line: 'wispr: ok (MCP session established)' };
  } catch (e) {
    return { ok: false, line: `wispr: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function checkGmeet(slug: string, cfg?: MeetingsSourcesConfig): { ok: boolean; line: string } {
  const accounts = cfg?.gmeet?.accounts ?? [];
  const store = loadStore(tokenPath(slug, 'google'));
  const missing = accounts.filter((a) => !store.accounts[a]);
  return missing.length ? { ok: false, line: `gmeet: no google credentials for ${missing.join(', ')}` } : { ok: true, line: `gmeet: ok (google token covers ${accounts.join(', ') || 'no accounts'})` };
}

export async function runMeetingsAuth(ctx: AuthContext, argv: string[], cfg?: MeetingsSourcesConfig): Promise<number> {
  const { pos, flags } = parseFlags(argv);
  const [provider, action = 'check'] = pos;
  if (!provider || provider === 'check') {
    const results: { ok: boolean; line: string }[] = [];
    if (cfg?.granola) results.push(await checkGranola(granolaTokenPath(ctx.slug)));
    if (cfg?.gmeet) results.push(checkGmeet(ctx.slug, cfg));
    if (cfg?.wispr) results.push(await checkWispr(ctx.slug));
    for (const r of results) ctx.log(r.line);
    return results.every((r) => r.ok) ? 0 : 3;
  }
  if (provider === 'granola') {
    if (action === 'add') {
      const secret = await readSecret(flags);
      const path = granolaTokenPath(ctx.slug);
      writeTokenFile(`${path}.candidate`, { token: secret });
      const r = await checkGranola(`${path}.candidate`);
      rmSync(`${path}.candidate`, { force: true });
      if (!r.ok) {
        ctx.log(`${r.line} — not stored`);
        return 3;
      }
      writeTokenFile(path, { token: secret });
      ctx.log('granola: stored');
      return 0;
    }
    if (action === 'check') {
      const r = await checkGranola(granolaTokenPath(ctx.slug));
      ctx.log(r.line);
      return r.ok ? 0 : 3;
    }
  } else if (provider === 'wispr') {
    if (action === 'login') {
      // Browser (PKCE loopback) by default: Wispr's login page rejects device-code approvals
      // with "Missing external_auth_id". `--device` keeps the device flow for a headless box.
      if (flags.device) await deviceLogin(wisprTokenPath(ctx.slug), ctx.log);
      else await browserLogin(wisprTokenPath(ctx.slug), ctx.log);
      const r = await checkWispr(ctx.slug);
      ctx.log(r.line);
      return r.ok ? 0 : 3;
    }
    if (action === 'check') {
      const r = await checkWispr(ctx.slug);
      ctx.log(r.line);
      return r.ok ? 0 : 3;
    }
  } else if (provider === 'gmeet') {
    const r = checkGmeet(ctx.slug, cfg);
    ctx.log(r.line);
    return r.ok ? 0 : 3;
  }
  throw new UsageError('meetings: usage — granola add|check · wispr login|check · gmeet check · check');
}
