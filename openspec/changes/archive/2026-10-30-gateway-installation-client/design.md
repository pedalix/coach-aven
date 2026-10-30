## Context

The state after `gateway-oauth-client-credentials` (see its design for the details):

- `src/gwtoken.ts` `createGatewayTokens(env)` picks the mint per entry. Without `oauth`: `auth0Mint` (JSON body, `audience` = the entry's `url`, `AUTH0_M2M_TOKEN_URL` + `AUTH0_M2M_<SLUG>_ID/_SECRET`), cache key `${slug}|${url}`. With `oauth`: `oauthMint` (RFC 6749 §4.4 form body, Basic or `post`, `scope` / `audience` / `resource` when set), credentials `GATEWAY_OAUTH_<SLUG>_ID/_SECRET`, cache key `${slug}|oauth|<canonical request>`. Credentials are read from the env at first use; a missing pair fails that project only (logged, Sentry, the turn goes on without gateway tools).
- `src/projects.ts` `loadProjects(path)` validates the `oauth` object (`validateGatewayOAuth`) and already logs load-time warnings (the retired `dispatch` block). It runs after `.env` is loaded into `process.env` (`src/config.ts`), at boot and on `/aven reload`; a failed reload keeps the previous registry.
- `src/project.ts` `seedGatewayAuth` and the sandbox side do not care which path minted the token.

Facts checked on 2026-10-30 that shape the decisions:

- A live Auth0 tenant answers the standard request: form body + HTTP Basic + `audience` → 200, a bearer token with `aud` = the route and the tenant's claims; form body + `post` → the same. Form body + RFC 8707 `resource` → 400 `invalid_request` (the tenant's "compatibility" resource profile applies to the authorization flow, not to client credentials).
- One Auth0 client with a grant per route API and a claims Action that reads the project from the requested audience gives per-route tokens equivalent to a client per project: own route 200, any other route 401. That is prod's shape now, with the same pair copied under every `AUTH0_M2M_<SLUG>_*`.
- The Cognito staging installation has one gateway project, its own app client and scope, and a route rule that checks `client_id` AND `scope`.

## Goals / Non-Goals

**Goals:**

- One credential pair for the whole installation, with the per-project pair as the override.
- One code path every installation can use, Auth0 included, so the Auth0-specific mint can be retired later.
- Keep the per-route isolation a property the code checks, now that the identity provider no longer stops one client from getting every route's token.

**Non-Goals:**

- Retiring `auth0Mint` and `AUTH0_M2M_*` (a later change).
- Defaults inside the `oauth` object (e.g. "`audience` = the entry's `url`"): every field stays explicit in the versioned config.
- Any change to the token cache, the refresh rule, the sandbox side or the gateway.

## Decisions

### D1. The installation pair is `GATEWAY_OAUTH_ID` / `GATEWAY_OAUTH_SECRET`, on the `oauth` path only

Resolution per project (one pure function, used by both the mint registry and the load check, D3):

1. `GATEWAY_OAUTH_<SLUG>_ID` and `_SECRET` both set → that pair (`source: project`), exactly today's behaviour.
2. Exactly one of them set → error naming both: a half-rotated pair must not silently fall back to another client.
3. Neither set, `GATEWAY_OAUTH_ID` and `GATEWAY_OAUTH_SECRET` both set → the installation pair (`source: installation`).
4. Otherwise → error naming all four names (the half-set installation pair included).

Why these names: a per-project name is `GATEWAY_OAUTH_<S>_ID` with a non-empty `<S>`, so `GATEWAY_OAUTH_ID` can never be one. `GATEWAY_OAUTH_CLIENT_ID` would be project `client`'s name.

Alternatives considered:

- *`clientIdEnv` / `clientSecretEnv` on the `oauth` object* (the earlier change's open question): every entry repeats two names to say "the installation's client". The override covers the mixed case (one project on another provider). Rejected for now; still additive later.
- *An `AUTH0_M2M_ID` / `_SECRET` fallback on the Auth0-specific path*: a new feature on a path this change deprecates. Rejected: an installation that wants one pair moves to `oauth`, which is the point.

### D2. Auth0 is a recipe, not a code path

The documented Auth0 entry is `oauth: { "tokenUrl": "https://<tenant>/oauth/token", "audience": "<the route URL>" }`, HTTP Basic by default (Auth0 also takes `post`). `audience` rather than `resource`, because Auth0 refuses `resource` on client credentials. The cache key changes from `${slug}|${url}` to the `oauth` key when an installation moves, so the first turn after the move mints once per route; nothing else differs (the request is form-encoded instead of JSON, which Auth0 accepts equally).

### D3. The shared-request check runs at load and fails it

When the installation pair is set, `loadProjects` groups the `oauth` entries whose project resolves to `source: installation` (D1) by the token they ask for — token URL, scope, audience, resource. Not the client authentication, unlike the cache key: `basic` or `post`, one client asking the same thing gets interchangeable tokens. A group with entries of two or more projects fails the load, naming the projects, the token URL's origin and the shared scope / audience / resource (no secret is part of a token request).

Why at load: the result is deterministic and appears where config mistakes appear today — the deploy's wait for the driver's line goes red at boot, and `/aven reload` keeps the running registry and answers with the error. A check at mint time would let whichever project minted first keep working, and the order changes with every restart.

Why fail rather than warn: two routes reachable with one token is a security property gone silently, the same class as a secret in the config, which also fails the load. Two entries of the *same* project asking the same request are fine (one token, one cache entry).

Why only with the installation pair: without it, every project has its own client, the gateway can tell them apart by client id, and an installation that never sets the pair loads exactly as today (bucket 2).

### D4. The Auth0-specific path is deprecated by a load-time warning

A pure helper lists the projects with a `gateway-m2m` entry without `oauth`; `loadProjects` logs one `warn` line when the list is not empty, like the retired `dispatch` warning: the projects, and the replacement (`oauth` with `tokenUrl` + `audience`, `docs/runtime-config.md`). The mint stays byte for byte (the existing test). No flag: the old path stays the behaviour for entries without `oauth` until the removal change, which turns the warning into a load error with the same hint once no known installation uses it. For third-party installations that removal is the **BREAKING** step, announced in that release's notes; this change only warns.

### D5. What the gateway must check when one client serves every route

Documented with the recipes, not enforced here (the bot never reads the token):

- Auth0 (and any server that puts the requested audience into `aud`): the route's authentication pins `audiences` to the route URL — prod's routes already do.
- Cognito (no `aud`): the route rule must check the route's own scope (`jwt.scope` contains `<resource-server>/<slug>`). `client_id` alone no longer tells projects apart when they share the installation client. The staging installation's rule checks both and keeps working either way.

### D6. Set aside: the bot as its own token issuer

Recorded so a later change can start from it. Instead of an identity provider, coach-aven would sign the bot's JWTs (`aud` = route, `<slug>:bot`), with the public key pinned at the gateway: no application cap, no mint quota, no provider at all for the bot. Checked on agentgateway 1.5 (local lab, 2026-10-30): `mcpAuthentication` takes one issuer; `jwtAuth.providers[]` takes several and `jwt.iss` is readable in `mcpAuthorization`, but `jwtAuth` beside `mcpAuthentication` drops the `WWW-Authenticate: … resource_metadata` header and answers 401 on the protected-resource metadata path, so people's MCP OAuth discovery breaks; with `jwtAuth` optional or permissive, a request without a token gets through. So the bot would need its own route per project, and the gateway's helper services that verify the caller's JWT themselves would need a second issuer. A bot key could also sign people's roles unless the gateway restricts what that issuer may claim. Today's cost — one client per installation, ~1 mint per route per day — does not justify that.

## Risks / Trade-offs

- [With one client, the identity provider will mint any granted route's token for it, so a wrong token request in project A's entry yields project B's token] → The token request comes from A's own entry; D3 refuses identical requests across projects; the gateway checks `aud` (Auth0) or scope (Cognito, D5); a test pins one request per project.
- [A copied entry stops the whole bot at boot] → Deliberate (D3). The message names both projects; `/aven reload` refuses it without touching the running config; the deploy goes red and is rolled back like any bad config.
- [One leaked secret opens every route] → Already true: every project's pair sits in the same `.env`. Rotation becomes one secret instead of one per project.
- [The deprecation warning is noise until an installation moves] → One line per load. Prod moves right after the tag that carries this change.
- [Moving an installation re-mints every route once] → One token per route on the first turn after the move, against Auth0 Free's 1000 a month.

## Migration Plan

1. Merge (bucket 2): the home bot has no gateway entries; prod has entries without `oauth` (it logs the warning from the tag on, nothing else changes); the Cognito staging installation has a complete per-project pair, which wins.
2. Optional canary on staging: replace its `GATEWAY_OAUTH_<SLUG>_*` with `GATEWAY_OAUTH_ID/_SECRET` (the same client), restart, and check the first turn's mint and the gateway's tools.
3. After the tag is deployed to prod, as one ops step: every gateway entry gets `oauth: { tokenUrl, audience: <its route URL> }`, the `.env` gets `GATEWAY_OAUTH_ID/_SECRET` (the installation's bot client), `export`, restart. The `AUTH0_M2M_*` lines stay until each project's first turn has minted without a gateway error and the boot logged no deprecation warning; then they go.
4. Rollback: remove the `oauth` objects (the `AUTH0_M2M_*` lines are still there), `export`, restart.
5. Later: the change that removes the Auth0-specific path.
