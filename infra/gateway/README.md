# infra/gateway — an MCP gateway for an installation

One [agentgateway](https://agentgateway.dev) container between the agent and a project's production
tools (the error tracker, logs, your own MCP servers). The bot's config names one MCP server per
project, and the gateway decides the rest:

- **The upstream credentials stay on the gateway host.** The sandbox, where the agent runs code it
  wrote a minute ago, holds a key to one route, not the Sentry token behind it.
- **A route per project, a key per caller.** One project's key gets 401 on another project's route.
- **An allow-list of tools per route.** A tool no rule names is neither listed nor callable, so a
  read-only route stays read-only when the upstream gains a write tool.
- **One audit line per call:** who, which route, which target and tool, how it ended.

The example is two projects on Sentry's hosted MCP server: `shop` with one target per Sentry project
(the API, the storefront), `booking` with one target. Everything below was run on agentgateway
**v1.7.0**; where something was not run, the text says so.

| File | What it is |
|---|---|
| `compose.yaml` | the container: the pinned image, the config directory, the published address, log rotation |
| `config/config.yaml` | routes, keys (as hashes), tool rules, targets, the audit fields |
| `.env.example` | the upstream token and the session key: the only secrets the gateway holds |
| `check.mjs` | what a credential sees on a route, and one call if you name a tool (Node 18+, no dependencies) |

Keep your copy in the ops repo (`infra/<slug>/gateway/`) with the rest of the installation's
config. `.env` is the one file that is not committed (the ops repo's `.gitignore` already ignores
it). The deploy tooling does not move this directory: copy it to the host yourself.

## Start it

1. **Secrets.** `cp .env.example .env && chmod 600 .env`, and fill in both values.
2. **A key per route.** The gateway stores the hash; the key goes to the caller and nowhere else:

   ```bash
   key=$(openssl rand -hex 32)
   printf '%s' "$key" | sha256sum | cut -d' ' -f1   # the route's keyHash: "sha256:<this>"
   echo "$key"                                       # the bot's .env (see "Connect the bot")
   ```

   As shipped, each route carries a hash of zeros: the file loads and every request gets 401 until
   you put your own in. Keep a placeholder hex: the gateway refuses the whole file over a hash that
   is not.
3. **Your names.** In `config/config.yaml`: the Sentry organization and project slugs in the
   targets' URLs, the route paths, the instructions.
4. **Run and check.**

   ```bash
   docker compose up -d
   GW_BEARER=<the key> node check.mjs http://127.0.0.1:4600/gw/shop/mcp
   GW_BEARER=<the key> node check.mjs http://127.0.0.1:4600/gw/shop/mcp sentry_search_issues '{"query":"is:unresolved"}'
   ```

   The first prints the instructions and the tools that key sees. Run the second as well: Sentry's
   server listed its tools for a token it did not know, and only the call said so ("Sentry rejected
   the stored access token").

## Connect the bot

The project gets one MCP entry in the installation's `projects.config.json`, and the bot's `.env`
gets the key:

```json
"mcp": [{ "name": "gw", "url": "http://<gateway address>:4600/gw/shop/mcp",
          "headers": { "Authorization": "Bearer ${GATEWAY_KEY_SHOP}" } }]
```

- Name the entry `gw`. The tools reach the agent as `mcp__gw__<target>_<tool>` and the bot shows a
  call by its target (`🔌 sentry: search_issues`, `src/steps.ts`). Say in the project prompt what
  each target is for.
- The bot reads `.env` at boot, so a new key needs a restart. A changed entry needs `/aven reload`
  and reaches new conversations.
- **The key reaches the sandbox:** the bot resolves the header and writes it into the agent's MCP
  config. A key that leaks from a sandbox opens that project's route with its allowed tools and
  nothing else, and replacing one hash revokes it. The upstream token never leaves the gateway host.
- With an identity provider the bot can hold short-lived tokens instead of a key: an entry with
  `"auth": "gateway-m2m"` mints one per route, keeps the client secret on the bot host, and sends
  `x-aven-session` (the conversation), which the audit line records. See
  [`docs/runtime-config.md`](../../docs/runtime-config.md), *MCP gateway*. The route then
  authenticates as in *People, with their own identity* below.

## Where it listens

The MCP client is the agent's Claude Code process **inside the sandbox container**, so the URL in
the bot's config must be reachable from there, and `127.0.0.1` in a container is the container.
`compose.yaml` publishes on loopback, which is enough for `check.mjs` on the host. For real use,
publish on the private address the sandbox host reaches (`"10.0.0.5:4600:4600"`), never on
`0.0.0.0`. This was run with the sandboxes on a second host of the same private network; with the
sandboxes on the gateway's own host it was not.

Plain HTTP is acceptable on a private network between your own hosts. Anything wider needs TLS in
front of it (a reverse proxy; agentgateway can also terminate TLS itself, which was not run here).

## Recipes

### Another project

A backend (what the project may reach) and a route (who may reach it, and which tools), like
`booking` in the file, with its own key: the `shop` key gets 401 there.

A backend with one target differs from one with several in one way. With a single target the agent
is handed that server's own name and instructions, and a `server` block on the backend is not used.
From two targets on, the agent gets the block's text, followed by each target's own instructions
under `[<target>]`.

A target's name may contain a hyphen, not an underscore: tools are `<target>_<tool>`, and the bot
takes everything before the first underscore for the target.

### Fewer tools, or other tools

`mcpAuthorization.rules` are CEL expressions. A tool is listed and callable when one of them holds:

- by name, without the target's prefix: `mcp.tool.name in ["search_issues", "get_issue_details"]`
- by target: `mcp.tool.target == "sentry"`
- by caller: `apiKey.role == "support" && …`

A call to a tool that no rule allows answers `{"code":-32602,"message":"unknown resource"}`: to the
agent the tool does not exist. The gateway logs `authorization denied for tool: sentry_update_issue`.

### A second caller with fewer tools

A key is a caller. Give another consumer (a support tool, a script) its own key on the same route,
with a `role` in its metadata, and write the rules by role:

```yaml
    apiKey:
      mode: strict
      keys:
      - keyHash: "sha256:<hash of the bot's key>"
        metadata: { subject: "shop:bot", role: "bot" }
      - keyHash: "sha256:<hash of the second key>"
        metadata: { subject: "shop:support", role: "support" }
    mcpAuthorization:
      rules:
      - 'apiKey.role == "bot" && mcp.tool.name in ["search_issues", "get_issue_details", "search_logs"]'
      - 'apiKey.role == "support" && mcp.tool.target == "sentry" && mcp.tool.name in ["search_issues", "get_issue_details"]'
```

`subject` is what the audit line shows as `caller`. Any other metadata field is yours to name and
to use in rules.

### People, with their own identity

A person's MCP client (Claude Code on a laptop, an IDE) should not hold a shared key. Give people a
second route to the **same backend** that takes a token from your identity provider, and write its
rules over the token's claims:

```yaml
- name: shop-people
  gateways: [mcp]
  matches:
  - path: { exact: /people/shop/mcp }
  # Where an MCP client learns which authorization server to send the person to.
  - path: { exact: /.well-known/oauth-protected-resource/people/shop/mcp }
  policies:
    mcpAuthentication:
      mode: strict
      issuer: https://idp.example/
      audiences: ["https://gateway.example/people/shop/mcp"]
      jwks: { file: /config/jwks.json }
      resourceMetadata:
        resource: https://gateway.example/people/shop/mcp
        scopesSupported: [openid, offline_access]
        bearerMethodsSupported: [header]
    mcpAuthorization:
      rules:
      - '"shop:dev" in jwt["https://idp.example/groups"] && mcp.tool.name != "update_issue"'
      - '"shop:support" in jwt["https://idp.example/groups"] && mcp.tool.target == "sentry" && mcp.tool.name in ["search_issues", "get_issue_details"]'
  backends: [{ backend: /shop }]
```

What a run with tokens signed by a local key showed:

- No token: 401 with `www-authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/people/shop/mcp"`,
  and that URL answers with the authorization server.
- A `shop:dev` token lists everything but `update_issue`; a `shop:support` token lists two tools.
- A token for another audience gets 401. A key on this route gets 401, and a token on the key route
  gets 401.

Not run here: the browser sign-in itself, which needs a real provider (`jwks` is then the
provider's URL instead of a file), and `apiKey` together with `mcpAuthentication` on one route.

The bot can use the same kind of route. With `"auth": "gateway-m2m"` it is a machine client of the
provider, and its token carries what you grant it (a `shop:bot` group, for example).

### Tell your own MCP server who is calling

For an upstream you run yourself, the gateway can pass the caller on, so the server can scope or
log by it:

```yaml
    - name: orders
      mcp: { host: "http://orders-mcp:8080/mcp" }
      policies:
        transformations: { request: { set: { x-caller: "has(apiKey.subject) ? apiKey.subject : jwt.sub" } } }
```

The value is a CEL expression. The upstream received `x-caller: shop:bot` from the key route and
the token's `sub` from the people route. The header means something only when the upstream is
reachable through the gateway alone.

### Per-person credentials upstream

Everything above uses one upstream token per target: every caller reads Sentry as the same
integration. When each person should act upstream as themselves (their own tracker account, their
own permissions), that takes a service behind the gateway that keeps each person's upstream
credential and adds it to their calls. It is a service of its own, not a config recipe, and it is
not part of this example.

### The audit log

`docker compose logs agentgateway` prints one JSON line per request. A tool call, shortened:

```json
{"route":"default/shop","src.addr":"10.0.0.7:60970","http.path":"/gw/shop/mcp","http.status":200,"protocol":"mcp","mcp.method.name":"tools/call","mcp.target":"sentry","gen_ai.tool.name":"search_issues","duration":"802ms","caller":"shop:bot","aven_session":"","tool_is_error":false}
```

- `caller`, `aven_session` and `tool_is_error` are added by `frontendPolicies.accessLog` in the
  config. The line carries no arguments and no results.
- A refused call has `http.status` 400 and `"error":"mcp: authorization denied for tool: …"`.
- A call the upstream answered with an error (a rejected token, a bad query) has `http.status` 200
  and `tool_is_error: true`.
- A target that is down: with `failureMode: failOpen` its tools are left out of the list and the
  other targets work. The log says `upstream '<target>' failed during fanout, skipping`.

### Change it

Edit `config/config.yaml` on the host, or copy a new one over it. The gateway reloads it within
seconds (`loaded config from File(…)` in the log). A file it cannot accept (a malformed hash, a
variable that is not set) is refused with `Failed to reload config: …`, and **the running config
stays**. The same file at a cold start makes the container exit, so check a file before a restart:

```bash
docker run --rm --env-file .env -v "$PWD/config:/config:ro" \
  ghcr.io/agentgateway/agentgateway:v1.7.0 -f /config/config.yaml --validate-only
```

A changed `.env` needs `docker compose up -d`, which recreates the container.

### Rotate a key, remove a caller

Put the new key's hash beside the old one (a route takes several keys), move the caller to the new
key, then delete the old line: from that reload on the old key gets 401. Removing a caller is
deleting its line.

## What it does not do

- It does not look into tool results. What the upstream returns (names and e-mail addresses in an
  error event, for example) reaches the agent and the chat as it is. Limit that at the source: the
  integration's permissions, the upstream's own scrubbing.
- It does not make a leaked key harmless, only small: one route and its allowed tools, until you
  replace the hash.
- Rate limits exist in agentgateway (`localRateLimit` on a route). They are not configured here and
  were not run.

## Versions

`compose.yaml` pins v1.7.0, and the config format moves between releases: a config written for an
older one may keep the audit fields under `config.logging.fields` instead of
`frontendPolicies.accessLog`. Move the pin on purpose, and run `--validate-only` with the new image
first. agentgateway also has a `migrate` command for deprecated fields, which was not run here.
