> **Status: decided 2026-10-30; the code is in the same pull request**, as the follow-up `gateway-installation-client` named.

## Why

A gateway entry without `oauth` mints with an Auth0-specific JSON request and reads `AUTH0_M2M_*` — a second code path beside the standard RFC 6749 one, kept only so installations could move at their own pace. They have: every installation we operate is on `oauth` since 2026-10-30 (prod moved with v0.44.0, its first real turn on the new path answered with all gateway tools; the Cognito staging installation always was; home has no gateway entry). What is left is a path nobody runs, a deprecation warning, a test that pins a request no installation sends, and docs that still explain two ways.

## What Changes

- **Removed:** the Auth0-specific mint (`auth0Mint`), its env names (`AUTH0_M2M_TOKEN_URL`, `AUTH0_M2M_<SLUG>_ID/_SECRET`) and their helpers, the `${slug}|${url}` cache key, the deprecation warning, and their tests.
- **A gateway entry needs `oauth`.** Loading a project config with a `gateway-m2m` entry without `oauth` fails at boot and at `/aven reload`, naming every such project and the replacement (`"oauth": { "tokenUrl": …, "audience": "<the route URL>" }` for Auth0, `"scope"` for Cognito). **BREAKING** for an installation still on the old entry: it does not start until the entries are moved (the steps stay in the docs).
- Leftover `AUTH0_M2M_*` lines in an `.env` are ignored.
- Docs: `docs/runtime-config.md` → *MCP gateway* describes one path, with a short *Upgrading from an entry without `oauth`* note; both `.env.example` files lose the `AUTH0_M2M_*` block; the `manage-project` skill, `docs/sources.md`'s gateway example, the `CLAUDE.md` pointer, the ledger.

## Out of scope

- Anything about the `oauth` path itself (credentials, the shared-request check, caching): unchanged.
- An automatic migration of old entries (inferring `oauth` from `AUTH0_M2M_TOKEN_URL`): the load error names the fix, and an operator moves the entries once.
- A *Breaking* release category: the PR title says what was removed, as the Daytona removal's did.
- The identity provider and the gateway: installation wiring.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `gateway-auth`: the Auth0-compatible request and the deprecation warning are removed; a gateway entry without `oauth` fails the load; the credential and cache requirements lose their clauses about entries without `oauth`.
- `sources-remote-access`: the remote-sources example entry carries the `oauth` object a gateway entry now needs.

## Impact

- Code: `src/gwtoken.ts` (the Auth0 mint, its env names and key go; `GatewayTarget.oauth` is required), `src/projects.ts` (the warning becomes a load error), `src/project.ts` (`seedGatewayAuth` hands over the entry's `oauth`), their tests; test fixtures with gateway entries get an `oauth` object.
- Config: `AUTH0_M2M_*` no longer read. No new setting.
- **Rollout: bucket 1, no gate** — dead code on every installation we operate (each gateway entry has `oauth`, checked 2026-10-30 across home, staging and prod), like the Daytona driver's removal. A third-party installation still on the old entry gets a load error that names the projects and the fix; the release notes say so in the PR title.
- No new dependency; no Slack surface, Home tab or prompt change.
