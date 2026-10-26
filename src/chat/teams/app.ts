// The Teams bot's composition root (OpenSpec teams-chat-driver): load config + registry, build
// the turn engine, channel resolver and pollers exactly as the Slack root does, bind the Teams
// SDK to the driver's API seam, register the activity routes, recover, listen. Mirrors
// src/chat/slack/app.ts; the two differ only where the platforms do:
//   - one tenant per installation: the home tenant IS the configured tenant, keys stay bare;
//   - no socket: Azure Bot Service POSTs to /api/messages on a loopback port behind nginx
//     (design D9); the public face and TLS are the host's reverse proxy's;
//   - no OAuth installs: the bot identity comes from the infra/teams module's outputs.

import express from 'express';
import { App, ExpressAdapter } from '@microsoft/teams.apps';
import type { Config, TeamsConfig } from '../../config.js';
import type { PreparedSurface, SharedDeps, SurfacePlugin, WiredSurface } from '../root.js';
import type { Store } from '../../state.js';
import { type RegistryRef, resolveByChannel } from '../../projects.js';
import { createActorGate } from '../core/gates.js';
import { createInteractions } from '../core/interactions.js';
import { createMessages } from '../core/messages.js';
import { createCommands } from '../core/commands.js';
import { setAlertSink, summary, type AlertLevel } from '../slack/blocks.js';
import { teamsDriver, type OutActivity, type TeamsApi } from './driver.js';
import { registerEvents, type TeamsAppLike } from './events.js';
import { activityShape } from './files.js';
import { hasReplyChains } from './keys.js';
import { scrubText } from '../../scrub.js';
import { withNetRetry } from '../../netretry.js';
import { log } from '../../log.js';

/**
 * The Teams surface (OpenSpec multi-driver-installation D2): prepared by the composition root
 * (`src/chat/root.ts`), which owns the engine, the pollers and the messaging runtime. `prepare`
 * builds the SDK app, the Connector seam and the driver; `wire` builds this surface's core handlers
 * and registers the activities; `start` opens the loopback listener. Exactly the sequence `runTeams` had.
 */
export const teamsSurface: SurfacePlugin = {
  name: 'teams',
  async prepare(cfg: Config, store: Store, reg: RegistryRef): Promise<PreparedSurface> {
    const teams = cfg.teams;
    if (!teams) {
      throw new Error('Set TEAMS_APP_ID, TEAMS_APP_PASSWORD and TEAMS_TENANT_ID (the infra/teams module outputs) to run the Teams bot.');
    }
    const tenantId = teams.tenantId;

    // ── the SDK app, on our own listener ──────────────────────────────────────
    // ExpressAdapter: the SDK registers /api/messages on an Express app we own, so the listener
    // binds to loopback (nginx is the public face) and nothing else is served.
    const server = express();
    const app = new App({
      clientId: teams.appId,
      clientSecret: teams.appPassword,
      tenantId,
      httpServerAdapter: new ExpressAdapter(server),
      logger: sdkLogger(teams.trace),
    });

    // TEAMS_TRACE=full: every Connector request and response in the journal (method, URL, body — scrubbed,
    // cut), and every Graph call the file path makes. The interceptor is registered once on the app's
    // client; clones (apiFor) inherit it. Errors stay the connector()'s to report.
    if (teams.trace === 'full') {
      (app.api.http as { use(i: unknown): unknown }).use({
        request: (ctx: { config: { method?: string; url?: string; data?: unknown } }) => {
          log.info(`teams-http → ${(ctx.config.method ?? 'get').toUpperCase()} ${ctx.config.url ?? ''}${ctx.config.data !== undefined ? ` ${traced(ctx.config.data, 4000)}` : ''}`);
          return ctx.config;
        },
        response: (ctx: { res: { status?: number; data?: unknown; config?: { method?: string; url?: string } } }) => {
          log.info(`teams-http ← ${ctx.res.status ?? '?'} ${(ctx.res.config?.method ?? 'get').toUpperCase()} ${ctx.res.config?.url ?? ''}${ctx.res.data !== undefined && ctx.res.data !== '' ? ` ${traced(ctx.res.data, 4000)}` : ''}`);
          return ctx.res;
        },
      });
    }
    const tracedFetch: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      const body = await res.clone().text().catch(() => '');
      log.info(`teams-graph ${(init?.method ?? 'GET').toUpperCase()} ${String(input)} ← ${res.status}${body ? ` ${traced(body, 4000)}` : ''}`);
      return res;
    };

    // ── the driver's API seam over the SDK's Connector client ─────────────────
    // Proactive sends (pollers, recovery) need the tenant's service URL; inbound activities carry
    // it and the store remembers the last one, so a fresh boot can post before any new message.
    let serviceUrl = store.getTeamsServiceUrl();
    const apiFor = () => (serviceUrl ? app.api.clone({ serviceUrl }) : app.api);
    const api: TeamsApi = {
      async send(conversationId, activity) {
        const sent = await connector('send', conversationId, () => apiFor().conversations.createActivity(conversationId, activity as never));
        return { id: (sent as { id?: string }).id ?? '' };
      },
      async sendTargeted(conversationId, activity) {
        const sent = await connector('sendTargeted', conversationId, () => apiFor().conversations.createTargetedActivity(conversationId, activity as never));
        return { id: (sent as { id?: string }).id ?? '' };
      },
      async update(conversationId, activityId, activity) {
        await connector('update', conversationId, () => apiFor().conversations.updateActivity(conversationId, activityId, activity as never));
      },
      async react(conversationId, activityId, type, op) {
        await connector(`react:${op}`, conversationId, () =>
          op === 'add'
            ? apiFor().conversations.addReaction(conversationId, activityId, type as never)
            : apiFor().conversations.deleteReaction(conversationId, activityId, type as never),
        );
      },
      async memberName(conversationId, userId) {
        const m = await connector('member', conversationId, () => apiFor().conversations.members(conversationId).getById(userId));
        return (m as { name?: string }).name;
      },
      async openPersonal(userId) {
        const res = await connector('openPersonal', userId, () =>
          apiFor().conversations.create({ tenantId, isGroup: false, bot: { id: `28:${teams.appId}` }, members: [{ id: userId }] } as never),
        );
        return (res as { id?: string }).id;
      },
    };
    const tokens = app as unknown as { getBotToken(): Promise<{ toString(): string } | null>; getAppGraphToken(t?: string): Promise<{ toString(): string } | null> };
    const driver = teamsDriver(api, { tenantId, statusMinMs: teams.statusMinMs, targeted: teams.targeted });
    // Operators (TEAMS_OPERATORS): Teams user ids (`29:…`, as `/users` lists them) or Entra object
    // ids — the latter matched through the `aadObjectId` every activity of that person carries.
    const operators = new Set(teams.operators);
    const aadOf = new Map<string, string>();
    const groupIds = new Map<string, string>(); // Teams team id → Microsoft 365 group id (files.groupIdOf)
    const isOperator = (user: string | undefined) => !!user && (operators.has(user) || operators.has(aadOf.get(user) ?? ''));

    // Operator error alerts → a Teams channel (AVEN_ALERT_CHANNEL = a channel id the app is in).
    const ALERT_CHANNEL = process.env.AVEN_ALERT_CHANNEL;
    const recentAlerts = new Map<string, number>();
    if (ALERT_CHANNEL) {
      const PREFIX: Record<AlertLevel, string> = { error: '🚨 CoachAven error:', warning: '⚠️ CoachAven:', info: '✅ CoachAven:' };
      setAlertSink((text, level) => {
        const now = Date.now();
        const last = recentAlerts.get(text);
        if (last && now - last < 60_000) return;
        recentAlerts.set(text, now);
        if (recentAlerts.size > 200) recentAlerts.clear();
        void driver.post({ conv: ALERT_CHANNEL }, { kind: 'text', text: `${PREFIX[level]} ${text}`.slice(0, 2000) }).catch(() => {});
      });
    }

    return {
      name: 'teams',
      homeTenantId: () => tenantId,
      driverFor: () => driver, // one tenant: every record resolves to the same driver
      // Team channels map by id only (teams-chat-driver): no single-project fallback there, 1:1 chats keep it.
      channelsOptions: { boundOnly: hasReplyChains },
      hasHome: true,
      async wire({ cfg, store, reg, engine, channels, pollers, messaging }: SharedDeps): Promise<WiredSurface> {
      const actor = createActorGate(store, tenantId);
      const servedTenant = (t: string | undefined) => t === tenantId;
      const core = createInteractions({ cfg, store, reg, engine, homeTeamId: tenantId, servedTenant, actor, prefixFor: () => '', messaging: messaging.messaging });
      const messages = createMessages({ store, reg, engine, channels, homeTeamId: tenantId, actor, parkDmPick: core.parkDmPick });
      const commands = createCommands({ cfg, store, reg, engine, channels, pollers, homeTeamId: tenantId, isOperator, home: core.home, onReload: () => messaging.reload(), asks: messaging.asks });

      registerEvents(app as unknown as TeamsAppLike, {
        tenantId,
        driver,
        messages,
        core,
        commands,
        onServiceUrl: (url) => {
          if (url === serviceUrl) return;
          serviceUrl = url;
          store.setTeamsServiceUrl(url);
        },
        onPerson: (id, name, aad) => {
          driver.knowPerson(id, name);
          if (aad) aadOf.set(id, aad);
        },
        boundProject: (conv) => resolveByChannel(reg.current, conv)?.slug,
        // The SDK keeps both tokens protected; they are the app's own (client credentials), fetched
        // and cached by its token manager. The Graph one is empty until the tenant consented
        // Files.Read.All (the module's `supports_files`).
        files: {
          botToken: async () => (await tokens.getBotToken())?.toString(),
          graphToken: async () => (await tokens.getAppGraphToken(tenantId))?.toString(),
          // The team's group id when the activity does not carry it: the Connector's team details, once per team.
          ...(teams.trace === 'full' ? { fetch: tracedFetch } : {}),
          groupIdOf: async (teamId) => {
            const cached = groupIds.get(teamId);
            if (cached) return cached;
            const details = (await connector('team', teamId, () => apiFor().teams.getById(teamId))) as { aadGroupId?: string };
            if (details.aadGroupId) groupIds.set(teamId, details.aadGroupId);
            return details.aadGroupId;
          },
        },
      });

        let listener: import('node:http').Server | undefined;
        return {
          async start() {
        await app.initialize();
        listener = await new Promise<import('node:http').Server>((resolve, reject) => {
          const l = server.listen(teams.port, '127.0.0.1', () => resolve(l));
          l.once('error', reject);
        });
        log.info(`Teams bot running (:${teams.port}) — ${summary(reg.current)}`);
          },
          // The listener is ours (ExpressAdapter), so it is ours to close — app.stop() would only
          // complain that the server lifecycle is managed externally.
          stop: () => new Promise<void>((resolve) => (listener ? listener.close(() => resolve()) : resolve())),
          closing: 'the Teams listener',
        };
      },
    };
  },
};

// A Connector call with its failure made legible: the SDK throws axios errors whose message is
// "Request failed with status code 400" and whose actual reason sits in the response body —
// which is what an operator (and the thread) needs to see.
// Retried: 429 (Retry-After honoured — Teams allows ~7 sends/s per thread), 412 (concurrent
// operations on one conversation) and 502/503/504, then transient socket errors; the SDK itself
// retries nothing. Anything else propagates with the body.
const RETRIED = new Set([412, 429, 502, 503, 504]);
async function connector<T>(call: string, target: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await withNetRetry(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await fn();
        } catch (e) {
          const r = (e as { response?: { status?: number; headers?: Record<string, string> } }).response;
          if (!r?.status || !RETRIED.has(r.status) || attempt >= 3) throw e;
          const after = Number(r.headers?.['retry-after']);
          const wait = Number.isFinite(after) && after > 0 ? after * 1000 : [1000, 3000, 8000][attempt];
          log.warn(`teams ${call}: HTTP ${r.status}, retrying in ${wait} ms (${attempt + 1}/3)`);
          await new Promise((res) => setTimeout(res, wait));
        }
      }
    });
  } catch (e) {
    const r = (e as { response?: { status?: number; data?: unknown } }).response;
    if (!r) throw e;
    const body = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    // What we sent, for the journal only: the thread gets the Connector's verdict, the operator
    // gets the payload that earned it.
    const sent = (e as { config?: { data?: unknown } }).config?.data;
    if (sent) log.error(`teams ${call} rejected payload: ${String(sent).slice(0, 1500)}`);
    throw new Error(`Teams ${call} → ${target}: HTTP ${r.status} ${body?.slice(0, 500) ?? ''}`.trim());
  }
}

// What a traced body looks like in the journal: JSON, secrets scrubbed, cut at `max` — the same
// scrubber the model boundary uses (scrub.ts), so a token in a payload never reaches the journal.
function traced(v: unknown, max = 16_000): string {
  const text = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v);
  const out = scrubText(text).text;
  return out.length > max ? `${out.slice(0, max)}… (${out.length} chars)` : out;
}

// The SDK logs through its own logger; route it into ours so the journal has one voice. Its debug
// stream is dropped — except, with TEAMS_TRACE: 'shape' logs the one line per inbound activity
// ("Handling activity", the body) as the activity's shape (files.ts activityShape); 'full' logs that
// body whole (scrubbed) and every other debug line, for a staging installation collecting what Teams
// really sends when a file or a message does not come through as expected.
function sdkLogger(trace: TeamsConfig['trace'] = 'off') {
  const debug =
    trace === 'full'
      ? (...a: unknown[]) => log.info(a[0] === 'Handling activity' ? `teams-trace: ${traced(a[1])}` : `teams-sdk-debug: ${a.map((x) => (typeof x === 'string' ? x : traced(x, 4000))).join(' ')}`)
      : trace === 'shape'
        ? (...a: unknown[]) => { if (a[0] === 'Handling activity') log.info(`teams-trace: ${activityShape(a[1])}`); }
        : () => {};
  const l = {
    debug,
    info: (...a: unknown[]) => log.info(`teams-sdk: ${a.map(String).join(' ')}`),
    warn: (...a: unknown[]) => log.warn(`teams-sdk: ${a.map(String).join(' ')}`),
    error: (...a: unknown[]) => log.error(`teams-sdk: ${a.map(String).join(' ')}`),
    log: (...a: unknown[]) => log.info(`teams-sdk: ${a.map(String).join(' ')}`),
    child: () => l,
    enabled: () => true,
    toString: () => 'teams',
  };
  return l as never;
}

export type { OutActivity };
