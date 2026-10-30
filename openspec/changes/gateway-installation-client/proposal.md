## Why

The bot's gateway credentials are one client per project: `AUTH0_M2M_<SLUG>_*` or `GATEWAY_OAUTH_<SLUG>_*`, a new pair in the installation's identity provider and `.env` for every project. That buys no isolation — every pair lives in the one orchestrator `.env` — while the isolation that does hold is the per-route token (only that project's token enters its sandbox, the gateway checks it against the route). It costs a client per project, and a free Auth0 tenant caps applications at 10, M2M clients included: prod hit that cap on its seventh project and now runs every project on one client, with the same pair copied under each slug. On top of that, the public core carries two mint paths that do the same thing — an Auth0-specific JSON request and the standard RFC 6749 one — and the second path's own design left both questions open ("several projects sharing one client", "should the Auth0 installations move to `oauth`"). This change answers both.

## What Changes

- **One client pair per installation.** `GATEWAY_OAUTH_ID` / `GATEWAY_OAUTH_SECRET` serve every `oauth` gateway entry whose project has no pair of its own. A complete `GATEWAY_OAUTH_<SLUG>_*` pair still wins; a half-set pair (either side) fails that project instead of being mixed with the installation pair.
- **The token request must tell projects apart.** When two projects get their token from the installation pair with the same token request (token URL, scope, audience, resource), a token minted for one would be valid on the other's route. The bot refuses the second project's mint, naming both projects, so a missing per-route `audience` / `scope` shows up as an error, not as a silent loss of isolation.
- **Auth0 through the standard path.** An `oauth` entry with `tokenUrl` = the tenant's `/oauth/token` and `audience` = the route URL mints from Auth0 (form body, HTTP Basic or `post`; checked against a live tenant on 2026-10-30 — Auth0 refuses RFC 8707 `resource` for client credentials, so `audience` it is). The docs make this the Auth0 recipe.
- **The Auth0-specific path is deprecated, not removed.** A gateway entry without `oauth` mints exactly as today (byte for byte, pinned by the existing test), and loading such a config logs one warning naming the projects still on it. Removal is a later change, once no known installation uses it.
- Docs: `docs/runtime-config.md` (*MCP gateway* rewritten around the one path: the installation pair, the Auth0 and Cognito recipes, what the gateway rule must check when one client serves every route, the migration from the deprecated path), both `.env.example` files, the public `manage-project` skill, the `CLAUDE.md` pointer, a ledger row.

## Out of scope

- Removing the deprecated Auth0 path (`auth0Mint`, `AUTH0_M2M_*`): a follow-up change — **BREAKING** for any installation still on it, so not here.
- The bot signing its own tokens (coach-aven as a token issuer, no identity provider for the bot). Evaluated and set aside on 2026-10-30: agentgateway 1.5 accepts one issuer per route in `mcpAuthentication`, and `jwtAuth` beside it breaks MCP OAuth discovery for people (or, optional/permissive, lets a request without a token through), so it would need a second route per project; the bot's key could also mint people's roles. Recorded in design.md so a later change can start from it.
- The identity-provider side (clients, grants, scopes, the claims Action) and the gateway's routes and rules: installation wiring in its ops repo.
- Naming the env variables per entry (`clientIdEnv` / `clientSecretEnv`); the installation pair plus the per-slug override covers the cases known today.
- People signing in to the gateway.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `gateway-auth`: credentials can come from one installation-level pair; projects that share it must ask distinct token requests; a gateway entry without `oauth` is deprecated (a load-time warning). The capability is introduced by the in-flight change `gateway-oauth-client-credentials`, which is archived first.

## Impact

- Code: `src/gwtoken.ts` (credential resolution for `oauth` entries, the shared-request guard), the config loader in `src/projects.ts` (the deprecation warning, from a pure helper), their tests. `src/project.ts`, `src/mcp.ts` and the sandbox side do not change.
- Config: two new optional env names, `GATEWAY_OAUTH_ID` / `GATEWAY_OAUTH_SECRET`. No config key changes; the `oauth` object is the one from `gateway-oauth-client-credentials`.
- **Rollout bucket 2 (default-preserving)**, gate: `GATEWAY_OAUTH_ID` / `GATEWAY_OAUTH_SECRET` in an installation's `.env` (no installation sets them). Today's shapes are proven unchanged by tests: an entry without `oauth` sends the same Auth0 request with the same env names; an `oauth` entry with a complete `GATEWAY_OAUTH_<SLUG>_*` pair reads that pair even when the installation pair is set. The only visible difference without the gate is a log line: the deprecation warning at load on an installation whose gateway entries have no `oauth` (prod today), and a longer "missing credentials" message naming the installation pair too.
- After the tag reaches prod, prod moves to the standard path as an ops step (its gateway entries get `oauth`, its `.env` one pair instead of fourteen lines), which also makes it the canary for the installation pair.
- No new dependency.
