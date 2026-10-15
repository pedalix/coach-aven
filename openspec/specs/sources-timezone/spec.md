# sources-timezone Specification

## Purpose
One presentation zone per tenant over UTC storage.

## Requirements

### Requirement: Storage is UTC
Every instant the sources stack persists — raw records, store rows, the attribution tables, ledgers — SHALL be UTC, and no table SHALL persist a value that depends on a time zone.

#### Scenario: The zone changes
- **WHEN** a tenant's `sources.timezone` changes
- **THEN** no stored row has to be rewritten for the answers to follow the new zone

### Requirement: The tenant's zone in presentation
Every sources tool SHALL read bare dates, zone-less datetimes and `today` in the zone of the store it answers from — the project's `sources.timezone`, else the bot's `AVEN_TZ` — and SHALL report it as `stats.tz`.

#### Scenario: Two tenants on one bot
- **WHEN** a Zurich tenant and a Moscow tenant are asked for `since: 2026-10-15` on the same bot
- **THEN** each answer covers that whole day in its own tenant's zone
