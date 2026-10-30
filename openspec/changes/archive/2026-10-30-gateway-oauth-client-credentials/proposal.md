## Why

A project behind the MCP gateway (`mcp` entry with `auth: "gateway-m2m"`) gets its bot token from Auth0 only: `src/gwtoken.ts` posts Auth0's JSON body with an `audience` and reads `AUTH0_M2M_*` from the env. An installation whose identity provider is another OAuth server, Amazon Cognito first, cannot use the gateway at all: Cognito's token endpoint takes the standard RFC 6749 §4.4 request (form body, HTTP Basic client authentication, `scope`), and its client-credentials tokens carry no `aud` claim. The next installation that puts a gateway in front of its tools uses Cognito, so the bot needs a provider-neutral way to mint, without touching the installations that use Auth0 today.

## What Changes

- An `mcp` entry with `auth: "gateway-m2m"` MAY carry an `oauth` object: `tokenUrl`, and optionally `scope`, `audience`, `resource` and `clientAuth` (`basic`, the default, or `post`). No secret goes into it; the client id and secret come from `GATEWAY_OAUTH_<SLUG>_ID` / `_SECRET` in the env.
- With `oauth`, the bot mints with a standard client-credentials request: `application/x-www-form-urlencoded` body, `grant_type=client_credentials`, client authentication by HTTP Basic (RFC 6749 §2.3.1) or in the body, and `scope` / `audience` / `resource` only when configured.
- Without `oauth`, nothing changes: the same env names, the same JSON body with `audience` = the entry's URL, the same cache key, byte for byte.
- The token cache refreshes before expiry by the smaller of one hour and half the token's lifetime, so a provider that issues one-hour tokens does not mint on every turn. For today's 24-hour tokens the refresh point is the same as now.
- The cache key covers the whole token request (token URL, scope, audience, resource), so two entries asking for different tokens never share one.
- `projects.config.json` validation: `oauth` only on a `gateway-m2m` entry, an `https` `tokenUrl`, string fields, a known `clientAuth`. A bad entry fails the load and names the project, as the existing `gateway-m2m` checks do.
- Docs: `docs/runtime-config.md` (*MCP gateway*: another OAuth provider, with the Cognito notes), both `.env.example` files, the `CLAUDE.md` pointer for `src/gwtoken.ts`, a ledger row.

## Out of scope

- The gateway side. A token without `aud` must be authorized by the gateway's route policy on `client_id` or `scope` (agentgateway: no `audiences` in the route's authentication, a CEL rule on `jwt.scope` / `jwt.client_id`). That is installation wiring and lives in the installation's ops repo.
- Creating the identity provider's clients, resource servers or scopes (installation Terraform).
- Moving today's Auth0 installations to the `oauth` object, or retiring the `AUTH0_M2M_*` path.
- People signing in to the gateway (OAuth for humans); this change covers the bot's machine identity only.
- Token exchange, mTLS or `private_key_jwt` client authentication, DPoP.

## Capabilities

### New Capabilities

- `gateway-auth`: how the bot obtains and hands out its machine token for a project's MCP gateway entry, with the Auth0-compatible default and the provider-neutral client-credentials path.

### Modified Capabilities

None.

## Impact

- Code: `src/gwtoken.ts` (the client-credentials mint, env names, cache key, relative refresh margin), `src/projects.ts` (`oauth` on `McpServerSpec` and its validation), `src/project.ts` (`seedGatewayAuth` passes the entry, not only its URL), their tests. `src/mcp.ts` and the sandbox side (token file, `headersHelper`, `x-aven-session`) stay as they are.
- Config: an optional `oauth` object per gateway entry; new env names `GATEWAY_OAUTH_<SLUG>_ID` / `_SECRET` read only for entries that have it.
- **Rollout bucket 2 (default-preserving)**, gate: the `oauth` object on a project's gateway entry. No installation sets it today, so the home bot and prod mint exactly as before; a test pins today's request shape (URL, headers, JSON body, env names, cache key). Canary: the first installation that configures a Cognito-backed gateway, after its own ops plan wires the gateway route.
- No new dependency (`fetch`, `URLSearchParams` and `Buffer` cover the request).
