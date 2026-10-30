## 1. Code (`src/gwtoken.ts`, `src/projects.ts`, `src/project.ts`)

- [x] 1.1 `src/gwtoken.ts`: remove `auth0Mint`, `M2mConfig`, `m2mEnvNames` and the entry-without-`oauth` branch of `createGatewayTokens` (its `${slug}|${url}` key and the `AUTH0_M2M_*` reads); `GatewayTarget.oauth` becomes required; the header comment describes the one path. Verify: `npm run typecheck`; `src/gwtoken.test.ts` keeps every `oauth`, resolver, shared-request and cache test green, and a new test shows leftover `AUTH0_M2M_*` in the env change nothing about the request (spec *Leftover Auth0 variables*).
- [x] 1.2 `src/projects.ts`: the deprecation warning becomes a load error naming the config file, every project with a `gateway-m2m` entry without `oauth`, and the replacement; the `auth` / `oauth` comments on `McpServerSpec` say `oauth` is required. Verify: `src/projects.test.ts` — two projects on the old entry → one error naming both and the `oauth` replacement (spec *Two projects on the old entry*); the shared-request and per-route tests unchanged.
- [x] 1.3 `src/project.ts` `seedGatewayAuth`: hand over the entry's `oauth` (always present after the load). Verify: `src/project.test.ts` — its gateway tests use `oauth` entries; the mint-failure test unchanged.
- [x] 1.4 Tests and fixtures that build gateway entries without `oauth` (`src/mcp.test.ts`, `src/sources/*.test.ts`, …) get one where they go through the loader or the token registry; the ones that only exercise the sandbox side (`buildMcpServers`, `channelSourcesEnabled`) may keep the bare entry. Verify: `npm test` green.

## 2. Docs and rollout

- [x] 2.1 `docs/runtime-config.md` → *MCP gateway*: one path; *Deprecated: an entry without `oauth`* becomes *Upgrading from an entry without `oauth`* (the load error, the four steps without the keep-for-rollback detail). `docs/sources.md`: the gateway example entry gets `oauth`. Verify: read-through; no `AUTH0_M2M` left in `docs/` except the upgrade note.
- [x] 2.2 `.env.example` and `infra/deploy/ops.example/.env.example`: the `AUTH0_M2M_*` block goes. The public `manage-project` skill: "refused at load" instead of "deprecated". The `CLAUDE.md` pointer for `src/gwtoken.ts`. Verify: `grep -rn AUTH0_M2M` outside `openspec/` and `docs/runtime-config.md`'s upgrade note finds nothing.
- [x] 2.3 `openspec/specs/gateway-auth/spec.md` → *Purpose*: one standard request for every identity provider, one client pair per installation (edited in place, as Purpose changes are). Verify: `openspec validate --specs`.
- [x] 2.4 `docs/rollout.md`: a row for this change (bucket 1, no gate — no installation has an entry without `oauth`, checked 2026-10-30), and the `gateway-installation-client` row notes the first real prod turn (2026-10-30, every gateway tool listed) and that its warning became this change's load error. Verify: the rows in the PR diff.
- [ ] 2.5 `npm run typecheck && npm test`, `openspec validate retire-auth0-gateway-path --strict`, then the PR titled "Gateway entries need an `oauth` object — the Auth0-specific token request is removed", label `feature`, the body naming bucket 1 and the ledger row. Verify: CI green.

## Workflow follow-up

- After the merge: archive this change (`/opsx:archive`); prod and staging take it with their next version, with nothing to change in their config.
