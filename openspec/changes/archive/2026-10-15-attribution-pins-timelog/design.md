# Design

## Context

#176 computes `att_fragments` (state ledger/escalated/rule/open) at every build; #177 made storage UTC-only with the tenant zone at query time. The owen-ops CLI recorded rule decisions with `review --write` and summed minutes with `timelog` (`src/timelog.ts`: meetings authoritative and deduped, coding evidence unioned per initiative minus meetings, split aliases by weight, co-activity for shared repos, optional wall-clock scaling, every non-call fragment counted as an interval).

## Goals / Non-Goals

**Goals:** billed time never moves because a rule changed; the timelog without any tenant code or store file; days in the tenant's zone, nothing local stored.

**Non-Goals:** retainers and half-day reports (tenant-side arithmetic over the readout); identities; commitments.

## Decisions

- **Pins live outside the store** (`data/<slug>/attribution/pins.jsonl`, append-only, last line per fragment id wins, `{id, attributions, rule_id, rules_version, pinned_at}` or `{id, unpinned_at}`): the store is disposable (rebuilt from raw on a schema change), pins are not.
- **When to pin**: a `rule` fragment whose local end day is at least `pinAfterDays` before today. The evening review and the next morning still see live rule decisions (a rule Owen accepts in the morning still applies to yesterday); after that the day is closed. Same moment for every tenant, no tool call needed.
- **Precedence**: ledger > pin > ladder. A judgment recorded after a pin replaces it in effect (the readout shows the ledger); the pin stays in the file as history.
- **Rules version** = sha256 of rules.json + initiatives.json + the people markers, first 12 hex — enough to tell which rules decided, and to compare with the git history of the tenant repo.
- **Redo**: the CLI appends `unpinned` lines for the window's pinned ids; nothing else changes; the next build re-decides.
- **Timelog at query time in the `.mjs`**, from `att_fragments` (calls, runs, work with their effective decision) and a small registry digest the build writes into `sync_state` (`att:splits` — alias → weights; `att:policy`): no local value persisted, and every face of the server answers alike. Unattributed time is `initiative: null` with `state` (`open`/`escalated`) and the candidates.
- **Port fidelity**: the merge rules and their order are the CLI's; tests port its timelog cases.

## Risks / Trade-offs

- [Pins file lost with the data dir] → it is a few hundred lines a month; the data dir is the bot host's backup unit; a lost file means past rule decisions re-decided by today's rules (visible as a change, not silent: the readout marks `pinned` only on pinned rows).
- [Timelog differs from the CLI's on unreviewed raw evidence] → the platform has no "unreviewed raw remainder": every call and work block is a fragment; a garbled recording is not time in either.

## Migration Plan

Bucket 2. Merge; the home bot pins closed days of owen-ops on its next build; compare `timelog` with `owen-ops timelog` for the current month (the difference must be explained by the CLI's midnight gap or raw remainder); then the owen-ops prompt switches (tenant repo).
