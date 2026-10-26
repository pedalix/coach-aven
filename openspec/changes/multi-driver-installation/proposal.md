# Proposal

## Why

An installation runs exactly one chat driver today, so a project that should be reachable from a second surface — the newsletter agent's users want a web chat while its developers and the platform project stay in Teams — needs a second installation: another `state.json`, another set of sandboxes, another checkout of the same repos. The core already resolves a driver per tenant and keys every conversation by its tenant; lifting the rule to "one driver per *surface*" lets one installation serve its projects on Slack, Teams and the web at once, with one sandbox per project and sessions wherever they started.

## What Changes

- **Surfaces.** An installation has one *default* chat driver (its run mode, as today) and MAY run additional drivers, listed in its configuration. Each driver is a *surface*. The core composition root starts every configured surface over one turn engine, one set of pollers and one messaging runtime.
- **Conversation keys carry their surface.** Conversations of the default surface keep today's key shapes exactly (bare home keys, tenant-prefixed others). Conversations of an additional surface carry the surface in their key. Every record that names a tenant (routines, watches, investigations) names its surface the same way: absent = the default surface.
- **A project is reachable from every surface where it is bound** (`slackChannel`, `teamsChannel`, later a web room). Sessions live in the conversation that started them, whatever the surface; one sandbox per project serves them all.
- **Background deliveries have an address per project.** A routine delivers where it was created. Reviews, autofix notices, ticket investigations and alerts go to the project's default-surface channel unless the project names the surfaces to deliver to.
- **Driver-private things stay per surface**: identities and access gates, the command prefix, the Home surface, the operators list, the alert channel.
- **BREAKING for nothing today**: an installation with one driver and no additional surfaces behaves byte for byte as before — same keys, same calls, same unit file. Rollout bucket: the shared-code change is default-preserving and pinned by the recorded Slack and Teams scenarios; additional surfaces are bucket 3 behind `CHAT_SURFACES`, which no installation sets until its canary.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `chat-driver-interface`: "One chat driver per installation" becomes "one default driver, additional surfaces by configuration"; conversation keys and background deliveries gain a surface dimension; Slack installations stay unchanged.

## Impact

- Code: `src/chat/` (a shared composition root over the per-driver roots, a `surfaces` key module beside `teamkeys.ts`, `drivers.ts`), `src/state.ts` (the `surface` of records), `src/channels.ts` (binding per surface, `deliverTo`), `src/pollers.ts`, `src/turn.ts` (recovery by key), `src/messaging/` (`driverFor` by key), `src/cli.ts`, `src/config.ts` (`CHAT_SURFACES`), `src/projects.ts` (`deliverTo`).
- Gate: `CHAT_SURFACES` (absent = the run mode's driver only). Rollout bucket: default-preserving shared code (the Slack and Teams recorders must be byte-identical), additional surfaces bucket 3. Ledger row "Multi-surface installation".
- Deploy tooling unchanged: the unit still runs `orch <driver>`; surfaces are `.env`.
- Follow-up changes: `web-chat-driver` (the web surface, actualized after this), Teams in a Slack installation on prod when a client asks.

## Out of scope

- Moving a conversation between surfaces, or showing one thread on two surfaces.
- A second instance of the same driver in one installation (two Slack apps): Slack's multi-workspace support covers several workspaces of one app already.
- Changing what any driver renders.
