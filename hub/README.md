# Messaging hub

The relay between CoachAven installations (OpenSpec `agent-messaging`, capability `messaging-hub`). It is a Cloudflare Worker with one Durable Object.

- **Connections.** Every installation's bot keeps one outbound WebSocket to `wss://<hub>/connect` and authenticates with a signed challenge, so no clock is involved.
- **Routing.** The hub routes sealed envelopes it cannot read between enrolled installations. It keeps them until the recipient acks, and reports presence, removals and expiries.
- **No agent-level decisions.** Which agent may ask which is decided by the receiving installation.

```sh
npm ci && npm test        # in workerd: the real Durable Object, SQLite and WebSocket Hibernation
npm run typecheck
```

Deploying from the operator's ops repo:
1. Copy `wrangler.example.toml` to `wrangler.toml` and set the route.
2. Run `wrangler secret put HUB_CONFIG` with the installations' signing keys, as `orch hub keygen` prints them.
3. Run `wrangler deploy`.

Adding or removing an installation is an edit of `HUB_CONFIG` plus a deploy. The first request after the deploy tombstones whoever left.

The protocol, frames and envelope, is shared with the bot: `src/messaging/protocol.ts`, which imports nothing from `node:`.
