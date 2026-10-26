// The web surface (OpenSpec web-chat-driver, multi-driver-installation D2): a plugin of the chat
// composition root (`src/chat/root.ts`), which owns the engine, the pollers and the messaging runtime.
// `prepare` reads the settings and builds the history store, the driver and the login; `wire` builds this
// surface's core handlers and the HTTP server; `start` reaches the identity provider once (discovery —
// a wrong issuer fails the boot, loudly) and opens the loopback listener. `orch web` makes it the
// installation's default surface, `CHAT_SURFACES=web` adds it beside Slack or Teams.
//
// One organization per surface (design D6): `WEB_ORG` is the tenant id of every web actor and the
// surface's home, so the core's gates see one open tenant — everyone who logged in may drive, the
// operators (`WEB_OPERATORS`) get the operator verbs. Rooms and private conversations bind by
// construction (keys.ts): the channel directory of this surface maps them to their project.

import { join } from 'node:path';
import type { Config } from '../../config.js';
import type { PreparedSurface, SharedDeps, SurfacePlugin, WiredSurface } from '../root.js';
import type { Store } from '../../state.js';
import { resolveBySlug, type RegistryRef } from '../../projects.js';
import { createActorGate } from '../core/gates.js';
import { createInteractions } from '../core/interactions.js';
import { createMessages } from '../core/messages.js';
import { createCommands } from '../core/commands.js';
import { dataRoot } from '../../sources/paths.js';
import { log } from '../../log.js';
import { History } from './history.js';
import { webDriver } from './driver.js';
import { createOidc } from './oidc.js';
import { isOperatorOf, type Oidc } from './auth.js';
import { projectOfConv, roomConv } from './keys.js';
import { createWebServer } from './server.js';

export const webSurface: SurfacePlugin = {
  name: 'web',
  async prepare(cfg: Config, store: Store, reg: RegistryRef): Promise<PreparedSurface> {
    const web = cfg.web;
    if (!web) {
      throw new Error('Set WEB_OIDC_ISSUER, WEB_OIDC_CLIENT_ID, WEB_OIDC_CLIENT_SECRET, WEB_BASE_URL and WEB_SESSION_SECRET to run the web chat (or WEB_AUTH=none on a loopback listener, for local use).');
    }
    const history = new History(join(dataRoot(), 'web'));
    const nameOf = (id: string) => store.getWebUser(id)?.name;
    const driver = webDriver({ history, baseUrl: web.baseUrl, nameOf });
    const oidc: (Oidc & { warmup(): Promise<void> }) | undefined = web.auth === 'oidc' && web.oidc ? createOidc(web.oidc) : undefined;
    const org = web.org;

    return {
      name: 'web',
      homeTenantId: () => org,
      driverFor: () => driver, // one organization: every record resolves to the same driver
      // Rooms and private conversations name their project; nothing else is a web conversation.
      channelsOptions: {
        projectOf: (conv) => {
          const slug = projectOfConv(conv);
          const p = slug ? resolveBySlug(reg.current, slug) : undefined;
          return p && p.webRoom !== false ? p.slug : undefined;
        },
        conversationFor: (p) => (p.webRoom === false ? undefined : roomConv(p.slug)),
        boundOnly: () => true,
      },
      hasHome: true,
      async wire({ cfg, store, reg, engine, channels, pollers, messaging, surface }: SharedDeps): Promise<WiredSurface> {
        const actor = createActorGate(store, org);
        const servedTenant = (t: string | undefined) => t === org;
        const isOperator = (user: string | undefined) => !!user && isOperatorOf(web.operators, { user, email: store.getWebUser(user)?.email });
        const core = createInteractions({ cfg, store, reg, engine, homeTeamId: org, servedTenant, actor, prefixFor: () => '', messaging: messaging.messaging, ...(surface ? { surface } : {}) });
        const messages = createMessages({ store, reg, engine, channels, homeTeamId: org, actor, parkDmPick: core.parkDmPick, ...(surface ? { surface } : {}) });
        const commands = createCommands({ cfg, store, reg, engine, channels, pollers, homeTeamId: org, isOperator, home: core.home, onReload: () => messaging.reload(), asks: messaging.asks, ...(surface ? { surface } : {}) });
        const server = createWebServer({ cfg: web, store, reg, history, driver, core, messages, commands, ...(oidc ? { oidc } : {}) });
        return {
          async start() {
            if (oidc) await oidc.warmup(); // a wrong issuer or an unreachable one fails the boot here, by name
            else log.warn(`web: WEB_AUTH=none — no login, a fixed local user; loopback listener only (${web.bind}:${web.port})`);
            const { port } = await server.listen();
            const rooms = reg.current.projects.filter((p) => p.webRoom !== false).length;
            log.info(`Web chat running (${web.baseUrl} ← ${web.bind}:${port}) — ${reg.current.projects.length} project(s), ${rooms} room(s)`);
          },
          stop: () => server.close(),
          closing: 'the web listener',
        };
      },
    };
  },
};
