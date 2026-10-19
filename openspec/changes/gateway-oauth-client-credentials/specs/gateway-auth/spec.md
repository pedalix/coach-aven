## Purpose

How the bot obtains its machine token for a project's MCP gateway entry and hands only that token to the sandbox: the Auth0-compatible default, and a provider-neutral OAuth 2.0 client-credentials path selected per entry.

## ADDED Requirements

### Requirement: The client secret never leaves the bot host
For every `mcp` entry with `auth: "gateway-m2m"`, the bot SHALL obtain the project's access token itself, from credentials held in its own environment, and SHALL write only the access token into the sandbox. The client id and secret SHALL NOT appear in the sandbox, in the project config, in logs or in error messages.

#### Scenario: A turn on a gateway project
- **WHEN** a turn starts for a project whose `mcp` list has a `gateway-m2m` entry
- **THEN** the sandbox holds the current access token for that entry and no client id or secret

#### Scenario: The token endpoint refuses
- **WHEN** the token endpoint answers 401 with an `error` code and an `error_description` that repeats the client id
- **THEN** the reported error names the HTTP status, the `error` code and the project, and contains neither the description, the response body nor the client id
- **AND** the turn goes on without the gateway's tools

### Requirement: Without an `oauth` object the Auth0-compatible request is unchanged
A gateway entry without `oauth` SHALL be minted exactly as before this change: a JSON request with `grant_type=client_credentials`, the client id and secret from `AUTH0_M2M_<SLUG>_ID` / `AUTH0_M2M_<SLUG>_SECRET`, `audience` set to the entry's `url`, sent to `AUTH0_M2M_TOKEN_URL`.

#### Scenario: An existing gateway project
- **WHEN** a project's gateway entry is `{ "name": "gw", "url": "https://gw.example/gw/caldora/mcp", "auth": "gateway-m2m" }`
- **THEN** the token request is the same request (URL, headers, JSON body) the bot sent before this change, and it reads the same env names

#### Scenario: Missing Auth0 credentials
- **WHEN** `AUTH0_M2M_CALDORA_ID` is absent
- **THEN** that project's gateway fails with a message naming `AUTH0_M2M_CALDORA_ID`, `AUTH0_M2M_CALDORA_SECRET` and `AUTH0_M2M_TOKEN_URL`, and other projects are not affected

### Requirement: An `oauth` object selects a standard client-credentials request
A gateway entry MAY carry `oauth: { tokenUrl, scope?, audience?, resource?, clientAuth? }`. With it, the bot SHALL request the token from `tokenUrl` with an OAuth 2.0 client-credentials request (RFC 6749 §4.4): a form-encoded body with `grant_type=client_credentials`, `scope`, `audience` and `resource` included only when configured, and credentials from `GATEWAY_OAUTH_<SLUG>_ID` / `GATEWAY_OAUTH_<SLUG>_SECRET`. The client SHALL authenticate with HTTP Basic (RFC 6749 §2.3.1) unless `clientAuth` is `post`, in which case the client id and secret SHALL be sent in the body instead. The bot SHALL NOT require any particular claim in the token, an `aud` claim included.

#### Scenario: HTTP Basic with a scope
- **WHEN** an entry has `oauth: { "tokenUrl": "https://idp.example/oauth2/token", "scope": "https://gw.example/caldora/bot" }`
- **THEN** the bot posts `grant_type=client_credentials&scope=…` as `application/x-www-form-urlencoded` with an `Authorization: Basic` header built from the form-encoded client id and secret, and the body carries no secret

#### Scenario: Client authentication in the body
- **WHEN** the entry's `oauth` has `"clientAuth": "post"`
- **THEN** the form body carries `client_id` and `client_secret` and the request has no `Authorization` header

#### Scenario: A token without an audience
- **WHEN** the token endpoint returns an access token that has no `aud` claim
- **THEN** the bot writes it into the sandbox like any other token

#### Scenario: Not a bearer token
- **WHEN** the response's `token_type` is present and is not `Bearer` (in any case)
- **THEN** the mint fails for that project and nothing is written into the sandbox

#### Scenario: Missing client-credentials secrets
- **WHEN** the entry has `oauth` and `GATEWAY_OAUTH_CALDORA_SECRET` is absent
- **THEN** that project's gateway fails with a message naming `GATEWAY_OAUTH_CALDORA_ID` and `GATEWAY_OAUTH_CALDORA_SECRET`

### Requirement: The project config rejects a malformed `oauth` object
Loading the project config (at boot and on reload) SHALL fail, naming the config file and the project, when an `oauth` object sits on an entry without `auth: "gateway-m2m"`, lacks a `tokenUrl`, has a `tokenUrl` that is not an `https:` URL, has a non-string `scope`, `audience` or `resource`, or has a `clientAuth` other than `basic` or `post`.

#### Scenario: Plain-HTTP token endpoint
- **WHEN** a gateway entry has `oauth: { "tokenUrl": "http://idp.example/oauth2/token" }`
- **THEN** the load fails and the message names the project and `tokenUrl`

#### Scenario: `oauth` on a non-gateway entry
- **WHEN** an entry without `auth: "gateway-m2m"` carries an `oauth` object
- **THEN** the load fails and the message names the project

### Requirement: Tokens are cached per token request and refreshed before they expire
The bot SHALL keep one cached token per project and token request, where the token request is the entry's `url` for entries without `oauth`, and the token URL, scope, audience, resource and client authentication for entries with it. Concurrent turns SHALL share one in-flight request; a failed request SHALL NOT be cached. A cached token SHALL be replaced once the time left is less than the smaller of one hour and half the token's lifetime at issue.

#### Scenario: A 24-hour token
- **WHEN** a token issued with a 24-hour lifetime has 2 hours left
- **THEN** the cached token is reused, and it is replaced once less than 1 hour is left

#### Scenario: A one-hour token
- **WHEN** a token issued with a one-hour lifetime has 40 minutes left
- **THEN** the cached token is reused, and it is replaced once less than 30 minutes are left

#### Scenario: Two scopes in one project
- **WHEN** two gateway entries of one project ask the same token URL for different scopes
- **THEN** each gets its own token and neither request is answered from the other's cache

#### Scenario: A burst of turns
- **WHEN** several turns of one project need the token at once and none is cached
- **THEN** exactly one token request is sent and every turn receives its token
