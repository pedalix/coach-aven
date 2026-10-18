// The Worker in front of the hub (design D3): `wss://<hub>/connect` goes to the one Durable Object
// instance; nothing else is served. Both are wrapped for Sentry: uncaught errors and the hub's warnings
// reach it when the Worker has a SENTRY_DSN secret (report.ts); without one the wrappers do nothing.
import { instrumentDurableObjectWithSentry, withSentry } from '@sentry/cloudflare';
import { Hub as HubObject, type Env } from './hub.js';
import { sentryOptions } from './report.js';

export const Hub = instrumentDurableObjectWithSentry((env: Env) => sentryOptions(env), HubObject);

export default withSentry((env: Env) => sentryOptions(env), {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/connect') return env.HUB.get(env.HUB.idFromName('hub')).fetch(request);
    if (url.pathname === '/health') return new Response('ok');
    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>);
