# Spec Delta

## ADDED Requirements

### Requirement: Item mode is opt-in by tenant data
The attribution layer SHALL compute the item floor only when the tenant's `annotations/attribution.json` has an `items` key (`{"days": N}`, the last N local days, default 30); without it the layer writes no item rows and the readout says item mode is off.

#### Scenario: A tenant without items
- **WHEN** attribution.json has no `items` key
- **THEN** `att_items` is empty and `attribution({unit: 'item'})` answers that item mode is off

### Requirement: The item floor
For every message, task, comment and meeting in the window the layer SHALL record, deterministically and from tenant data only: a sender class (human, bot, bulk, system), a repeat cluster with its weakest-edge confidence (exact repeats, alert episodes and flaps, companion posts, cross-posts, forwards, tracker mail ↔ ticket), a reuse family (sender + text template + host/app token), an initiative with its rung and graded confidence or candidates (own tracker key, reply to a decided root, host/app in the registry, unknown host on a closed list → `unregistered`, keys in the text, tenant rules, registry channels, a bulk sender → `none`), a record kind when structure decides it (bot, bulk or system senders, small talk → `noise`) and an addressee (explicit, vocative, implicit by reply, or `none` for integrations). A human item SHALL never join a bot or bulk cluster, and a scrub placeholder alone SHALL never make two items equal.

#### Scenario: A flapping alert
- **WHEN** a monitor posts warning, resolved and warning again for one rule and host within minutes
- **THEN** the posts share one cluster, and no human message joins it

### Requirement: The item readout
`attribution({unit: 'item', since, until})` SHALL return the window's item rows; the call without `unit` SHALL answer exactly as before.

#### Scenario: Old callers
- **WHEN** a routine calls `attribution({since, until})`
- **THEN** it receives fragments only, byte-identical to the previous version
