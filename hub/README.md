# Messaging hub

The relay between CoachAven installations (OpenSpec `agent-messaging`, capability `messaging-hub`). It is a Cloudflare Worker with one Durable Object.

- **Connections.** Every installation's bot keeps one outbound WebSocket to `wss://<hub>/connect?as=<name>` and claims its name with a signed challenge, so no clock is involved.
- **Names.** The first key to claim a name holds it, unless the configuration reserves the name for the operator's own keys or for nobody (OpenSpec `hub-open-network`).
- **Routing.** The hub routes sealed envelopes it cannot read, and only to installations that pinned the sender. It keeps them until the recipient acks, and reports presence and removals along those relationships, and expiries to the sender. It sees installations, never agents.
- **No agent-level decisions.** Which agent may ask which is decided by the receiving installation.

```sh
npm ci && npm test        # in workerd: the real Durable Object, SQLite and WebSocket Hibernation
npm run typecheck
```

Deploying from the operator's ops repo:
1. Copy `wrangler.example.toml` to `wrangler.toml` and set the route.
2. Run `wrangler secret put HUB_CONFIG` with the registration policy: `registration` (`open` or `closed`), the `reserved` names with the keys `orch hub keygen` prints (or `null` for nobody), and optional `limits` (`docs/hub.md`).
3. Optionally, run `wrangler secret put SENTRY_DSN` and set `SENTRY_ENVIRONMENT`: warnings, errors and uncaught exceptions then go to Sentry (`src/report.ts`).
4. Run `wrangler deploy`.

On an open hub an installation joins by connecting. Reserving its name, or revoking it (reserved for `null`), is an edit of `HUB_CONFIG` plus a deploy; the first request after the deploy applies it.

The protocol, frames and envelope, is shared with the bot: `src/messaging/protocol.ts`, which imports nothing from `node:`.
