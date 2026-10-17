// The Worker in front of the hub (design D3): `wss://<hub>/connect` goes to the one Durable Object
// instance; nothing else is served.
import { Hub, type Env } from './hub.js';

export { Hub };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/connect') return env.HUB.get(env.HUB.idFromName('hub')).fetch(request);
    if (url.pathname === '/health') return new Response('ok');
    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
