# Design

## Context

- The core already has the two dimensions this change needs: a driver is resolved per tenant (`DriverForTenant`, five call sites: pollers, turn recovery, messaging), and every conversation key may carry a leading tenant segment (`teamkeys.ts`: bare = home, `T…:`/`E…:` = another Slack workspace). Routines, watches and investigations record their tenant (`teamId`, absent = home).
- Each driver has its own composition root (`src/chat/slack/app.ts`, `src/chat/teams/app.ts`): the same 18 `create*` / `register*` calls, once per driver, differing in the driver, the channels options, the gate and the prefix.
- Slack Socket Mode allows one connection per app; Teams listens on a port; the web driver will listen on another. Nothing stops them running in one process.
- `state.json`, `queue.jsonl` and `usage/*.jsonl` on prod hold keys in today's shapes; a migration is out of the question (CLAUDE.md: prod must not change as a side effect of a merge).
- See proposal.md — Why.

## Goals / Non-Goals

**Goals:**
- One process, N surfaces, one engine: no second installation to put a project on a second surface.
- A single-driver installation stays byte-identical in keys, calls and unit file.
- Every per-surface concern stays with the driver that owns it; the core learns one thing: a conversation's surface.

**Non-Goals:**
- Two instances of one driver in an installation.
- Merging or mirroring conversations across surfaces.
- Changing any driver's rendering.

## Decisions

### D1. The surface is a key segment, and the default surface has none
Keys of the default surface stay exactly as today (`thread:…`, `T0CLIENT1:thread:…`, `dm:…`, `a2a:…`). A conversation on an additional surface gets the driver's name as its first segment: `web:thread:7f3a`, `teams:thread:1792…`, `slack:T0CLIENT1:thread:171234.5678`. `src/chat/surfaces.ts` (pure, tested) owns `withSurface` / `splitSurface`, built over `teamkeys.ts`, and the driver names are the only words allowed there (`CHAT_DRIVERS`), so a key's head is never mistaken for a tenant (`TENANT_RE` admits `T…`/`E…` only).
*Alternatives*: a prefix on every key including the default surface (`slack:thread:…`) would need a migration of prod's records; a separate field beside the key would touch every record type and every lookup — the key already travels everywhere.

### D2. One shared composition root, drivers as plugins
`src/chat/root.ts` builds the engine, the channels directory, the pollers and the messaging runtime once, then starts each surface through a driver plugin: `{ name, start(deps): Promise<Surface> }` where a `Surface` exposes its `ChatDriver`, its tenant resolver (`driverFor(tenantId)` for Slack's workspaces, a constant for Teams), its channels options (`boundOnly`, prefix), its actor gate and its registered events. `orch slack` and `orch teams` become `root(cfg, 'slack' | 'teams')`; `CHAT_SURFACES` (comma-separated driver names, the default implied) adds the others. The per-driver `app.ts` files keep the SDK wiring and shrink to the plugin.
*Alternative*: keep two roots and add a third for the web: three copies of the same wiring, and still no way to run two drivers.

### D3. `driverFor` takes the key, not only the tenant
`DriverForTenant(tenantId)` becomes `driverFor({ surface?, tenantId? })`, with a helper `driverForKey(key)` that splits the surface and tenant off a key. The five call sites pass the key or the record. A record's `surface` (new optional field on routines, watches, investigations and the messaging ledgers, beside `teamId`) is written when the record is created from a conversation; absent means the default surface, so today's records read as before.
*Alternative*: encode the surface into `teamId` — breaks `TENANT_RE` and the installation store's key rule.

### D4. Project bindings and deliveries
`channelIdForSlug(dir, project, tenantId, surface)` picks the binding of the surface: `slackChannel` or the `aven-<slug>` name lookup on a Slack surface, `teamsChannel` on Teams, the project's room on the web. A new project field `deliverTo?: string[]` (driver names) says where conversation-less deliveries go; default `[default surface]`. The pollers iterate the project's delivery surfaces and resolve each surface's driver; a surface without a binding for the project is logged and skipped, as a tenant without a driver is today.

### D5. Per-surface core instances, one engine
`createMessages`, `createCommands`, `createInteractions` and `createActorGate` take the surface (name + tenant resolver + channels + prefix) and are instantiated per surface, exactly as each root instantiates them today; they share `engine`, `store`, `reg`, `pollers` and `messaging`. The surface's handlers build keys with `withSurface(surface, withTeam(...))`. The engine is surface-blind: it receives the driver with every call (as today) and resolves the driver by key only in recovery (D3).

### D6. Identity and access
`actor.tenant` already namespaces identities per driver (Slack team id, Teams tenant id, later the web's issuer). An additional surface's gate reads and writes access under its own tenant id, so nothing granted on one surface leaks to another; operators stay per driver (`TEAMS_OPERATORS`, Slack's workspace admins, later `WEB_OPERATORS`).

### D7. Boot and failure
All surfaces start, then the pollers and the recovery. A surface that cannot start fails the boot (the installation is misconfigured, not degraded): the operator sees one error naming the surface. Shutdown closes every surface, then exits; in-flight turns recover on the next boot per key, so a conversation of the surface that was removed from `CHAT_SURFACES` is logged as unreachable and left queued, as a tenant without a driver is today.

### D8. What proves "unchanged"
The recorded Slack and Teams scenarios (`events.record`, `commands.record`, `pollers.record`, `turn.record`) run through the shared root with one surface and must be byte-identical. A new recorder test runs the root with two fake transports (one surface per driver kind) through: a thread on each, a routine created on each, a review with `deliverTo` both, a restart with a turn on each, an allow on one surface.

## Risks / Trade-offs

- [A key's first segment is overloaded: driver name, tenant id or kind] → `surfaces.ts` is the one parser; driver names are a closed set that never matches `TENANT_RE` or a key kind; property test over the three shapes.
- [Two surfaces post into one project's sandbox at once] → nothing new: two Slack threads of one project already do; the sandbox lock serializes preparation.
- [An operator sets `CHAT_SURFACES` on prod by accident] → the surface fails to start without its settings (D7), the boot fails loudly, nothing half-starts.
- [Home tab texts mention Slack-only features] → unchanged by this change; the web change takes the shared cheat-sheet.

## Migration Plan

1. PR 1: `surfaces.ts`, `surface` on records, `driverFor` by key, the shared root with one surface — the recorders byte-identical; `CHAT_SURFACES` accepted but every value except the default refused ("not available yet"). Deployed to home and the Teams staging installation as the canary of "unchanged".
2. PR 2: additional surfaces for real — `channelIdForSlug` per surface, `deliverTo`, per-surface core instances, the two-transport recorder; canary on the Teams staging installation with a Slack surface (a second Slack app of the operator's workspace, `platform` bound on both).
3. `web-chat-driver` follows as the third surface.
Rollback: unset `CHAT_SURFACES`; the default surface's records are untouched by design.

## Open Questions

- None that change what is built. Whether prod ever names a second surface is an operator decision per client, recorded in the ledger when it happens.
