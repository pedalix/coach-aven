## Context

Today's path, end to end (see proposal.md — *Why* for the motivation):

- `src/projects.ts`: an `mcp` entry with `auth: "gateway-m2m"` needs a `url` and a path-safe `name`; nothing else is configurable.
- `src/project.ts` `seedGatewayAuth`: every turn, for each gateway entry, `tokens.get(slug, s.url)` → the token is written to `/root/.aven/gw-token-<name>` (600) beside the helper script; a mint failure is logged and reported to Sentry, and the turn goes on without gateway tools.
- `src/gwtoken.ts`: `createGatewayTokens` keeps one cache per `${slug}|${audience}`, reads `AUTH0_M2M_TOKEN_URL` + `AUTH0_M2M_<SLUG>_ID/_SECRET` at first use, and mints with `auth0Mint`: `POST tokenUrl`, `content-type: application/json`, `{grant_type, client_id, client_secret, audience}`, 15 s timeout. `createTokenCache` is single-flight, does not cache failures, and refreshes when less than `REFRESH_BEFORE_MS` (1 h) is left of the token. Errors name the HTTP status and an `[a-z_]` error code, never the body.
- `src/mcp.ts`: the sandbox side (`headersHelper`, `Authorization: Bearer`, `x-aven-session`) does not care where the token came from.

Constraints:

- Bucket 2: an installation without the new config must send the same request, read the same env names and keep the same cache key — proven by a test, not by reading the diff.
- Secrets live only in the bot's env; the project config is versioned in the installation's ops repo and is read at boot and on `/aven reload`.
- Amazon Cognito's token endpoint accepts `application/x-www-form-urlencoded` only, authenticates a confidential client by HTTP Basic, scopes machine access by resource-server scopes, and lets an app client's access-token lifetime be set between 5 minutes and 1 day (default 1 hour). Its client-credentials tokens carry `client_id` and a space-delimited `scope`, and no `aud`.

## Goals / Non-Goals

**Goals:**

- One provider-neutral client-credentials mint (RFC 6749 §4.4) that a Cognito-backed gateway, or any standard OAuth server, can be reached with.
- The choice is explicit per gateway entry and visible in the versioned project config.
- Today's Auth0 path untouched, and the cache's guarantees (single-flight, failures not cached, refresh before expiry) carried over to the new path.

**Non-Goals:**

- Decoding or checking the token on the bot side (claims are the gateway's business).
- Supporting several bot identities per project, or per-entry secret names.
- Rewriting the Auth0 path on top of the new one.

## Decisions

### D1. The switch is an `oauth` object on the gateway entry; secrets stay in the env

```json
"mcp": [{
  "name": "gw",
  "url": "http://gw.internal.example:4600/gw/caldora/mcp",
  "auth": "gateway-m2m",
  "oauth": {
    "tokenUrl": "https://idp.example/oauth2/token",
    "scope": "https://gw.example/caldora/bot"
  }
}]
```

Fields: `tokenUrl` (required, `https:`), `scope` (optional, the RFC 6749 §3.3 space-delimited string, sent as is), `audience` (optional, for servers that take Auth0's parameter), `resource` (optional, RFC 8707), `clientAuth` (optional, `basic` default, or `post`). Credentials: `GATEWAY_OAUTH_<SLUG>_ID` / `GATEWAY_OAUTH_<SLUG>_SECRET`, the slug mapped like `m2mEnvNames` (upper-cased, other characters → `_`).

Why on the entry: the provider, its endpoint and the scope are wiring facts of that project's gateway, not secrets, and they differ per project (one scope per route). In the project config they are reviewed in the ops repo with the rest of the project and travel with it on `export`.

Alternatives considered:

- *Env only* (`GATEWAY_OAUTH_TOKEN_URL`, `GATEWAY_OAUTH_STYLE`, `GATEWAY_OAUTH_<SLUG>_SCOPE`): an installation-wide switch spread over unversioned env lines, so a project's gateway wiring would be split between two files. Rejected.
- *Reusing `AUTH0_M2M_<SLUG>_*` for the secrets*: fewer names, but a Cognito secret under an `AUTH0_` name misleads whoever rotates it. Rejected. The env names the entry's path reads are fixed by whether it has `oauth`, so an installation never needs both pairs for one project.
- *`clientIdEnv` / `clientSecretEnv` on the object* (as `sources.daemon.tokenEnv` does): only needed if two projects share one client. Deferred (Open Questions), additive later.

### D2. The mint: form body, HTTP Basic by default

`oauthMint(cfg)`: `POST tokenUrl`, `content-type: application/x-www-form-urlencoded`, `accept: application/json`, body `grant_type=client_credentials` plus `scope`, `audience` and `resource` only when set. With `clientAuth: "basic"` the client authenticates as RFC 6749 §2.3.1 says: `Authorization: Basic base64(urlencode(id) ":" urlencode(secret))`, and the body carries no secret. With `"post"`, `client_id` and `client_secret` go in the body. Same 15 s timeout as today.

Response: `access_token` required; `token_type`, when present, must be `bearer` (case-insensitive), so a DPoP or MAC token is never written into the sandbox as a bearer; `expires_in` as today (default 3600 s).

Errors as today: the HTTP status and the RFC 6749 §5.2 `error` code when it matches `^[a-z_]{1,64}$`, never `error_description` or the body. The message names the project and the token URL's origin, never the client id.

Why Basic by default: it is what RFC 6749 requires servers to support and what Cognito documents; `post` costs one branch and covers servers configured for it.

### D3. Cache key = the whole token request

Today's key `${slug}|${audience}` stays for entries without `oauth` (bucket 2). An `oauth` entry is keyed by `slug` plus the canonical request: `oauth|<tokenUrl>|<scope>|<audience>|<resource>|<clientAuth>`. Two entries of one project that ask for different scopes get different tokens; two that ask the same share one. The entry's `url` is not part of the key on this path: the token is not bound to the URL the sandbox connects to, which may be an internal address.

`seedGatewayAuth` passes the entry (`{ url, oauth? }`) instead of the URL alone; the `tokens` seam its tests inject changes shape accordingly.

### D4. Refresh margin relative to the token's lifetime

`createTokenCache` refreshes when the time left is under `min(REFRESH_BEFORE_MS, lifetime / 2)`, the lifetime measured at mint (`expiresAt - mintTime`). For a 24-hour token the margin is 1 hour, exactly as today. For Cognito's default 1-hour token it is 30 minutes, where today's rule would see "less than an hour left" on every call and mint on every turn (each request billed by the provider, and slower turns).

The installation can still set the bot's access-token lifetime to 1 day, which keeps one mint per day like Auth0; the docs recommend it. The relative margin is the safety net when it does not.

Alternative: a per-entry `refreshBefore` setting. Rejected: one more knob, while the relative rule is correct for every lifetime.

### D5. The bot never reads the token

The token is opaque to the bot on both paths: no decoding, no claim check. A Cognito token without `aud` is written to the sandbox like any other. Authorization is the gateway's: with Cognito, the route's authentication must not require an audience (agentgateway: omit `audiences`; a token is then checked for issuer, signature and expiry) and its policy must name `jwt.client_id` or a `jwt.scope` entry, so a token minted for another project's route is refused. This is written into `docs/runtime-config.md` as the gateway's half of the contract; configuring it is installation work.

### D6. Validation at load

In `src/projects.ts`, next to the existing `gateway-m2m` checks: `oauth` present without `auth: "gateway-m2m"` → error; `tokenUrl` missing or not an `https:` URL → error; `scope`, `audience`, `resource` not strings → error; `clientAuth` not `basic` | `post` → error. Each error names the config file and the project, and fails the load the same way (boot or `/aven reload`). The secrets are checked at first mint, as today, so a missing pair fails that project's gateway only, with the env names in the message.

## Risks / Trade-offs

- [The relative margin changes the refresh point for tokens shorter than 2 hours] → No installation mints such tokens today: the Auth0 installations get 24-hour tokens, so the default path is unchanged. A test pins the 24-hour refresh point.
- [A long turn outlives a short token: the file is re-written per turn, not mid-turn] → Same as today's 24-hour tokens beyond their margin. The docs recommend a 1-day lifetime, and the 30-minute margin covers a turn of normal length.
- [A misconfigured scope mints a token the gateway refuses] → The mint succeeds and the gateway answers 401/403. The agent sees no gateway tools for that session, as on any gateway outage. The canary checks the tools list after the first turn.
- [The per-turn secret lookup still reads the env at first use only] → Unchanged from today: rotating a secret needs a restart, as `AUTH0_M2M_*` does now.

## Migration Plan

1. Merge: nothing changes anywhere (no installation has `oauth`).
2. An installation that wants it: create the bot's client in its identity provider (installation Terraform), put `GATEWAY_OAUTH_<SLUG>_ID/_SECRET` in its ops repo `.env`, add `oauth` to the project's gateway entry, `npm run ops -- <slug> export`, `/aven reload` (new sessions) or a restart.
3. Rollback: remove the `oauth` object (or the whole gateway entry) and export again.

## Open Questions

- Should a project be able to name its secret env vars (`clientIdEnv` / `clientSecretEnv`) so that several projects can share one client? Additive later; nobody needs it yet.
- Should the Auth0 installations move to `oauth` (with `audience` and `clientAuth: "post"`) once it has run for a while, so that `auth0Mint` can go? A later change, after this path has a canary.
