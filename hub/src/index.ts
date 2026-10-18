// The Worker in front of the hub (design D3; `hub-open-network`, N2): `wss://<hub>/connect?as=<name>`
// goes to the Durable Object; nothing else is served. Both are wrapped for Sentry: uncaught errors and
// the hub's warnings reach it when the Worker has a SENTRY_DSN secret (report.ts); without one the
// wrappers do nothing.
import { instrumentDurableObjectWithSentry, withSentry } from '@sentry/cloudflare';
import { INSTALLATION_RE } from '../../src/messaging/protocol.js';
import { Hub as HubObject, type Env } from './hub.js';
import { sentryOptions } from './report.js';

export const Hub = instrumentDurableObjectWithSentry((env: Env) => sentryOptions(env), HubObject);

export default withSentry((env: Env) => sentryOptions(env), {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/connect') {
      // The name a connection claims. Checked here; a missing one goes on, so that a version-1 bot meets
      // `unsupported version` at its `auth` instead of an HTTP error it cannot explain.
      const as = url.searchParams.get('as');
      if (as !== null && !INSTALLATION_RE.test(as)) return new Response('bad name', { status: 400 });
      // One object for every installation today; `idFromName(as)` gives each its own when the hub needs it.
      return env.HUB.get(env.HUB.idFromName('hub')).fetch(request);
    }
    if (url.pathname === '/health') return new Response('ok');
    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>);
