# Proposal

## Why

The attribution layer (#176) decides what its ladder can and leaves the rest to the evening review agent, which decides
"by content" when it feels ≥ 0.75 sure. Nobody measured either half. Tonight's bench did, on a frozen copy of owen-ops,
bluefin-ops and a synthetic agency tenant with exact truth:

- the review agent's recorded decisions agree with a two-pass Opus reference on only **49%** of fragments at initiative
  level (79% at umbrella level); two full runs of it agree on 57% of P-codes;
- the ladder's single title hits are wrong on 12 of 32 fragments, its admin keywords on 4 of 5 (`vat` in "private");
- on a tenant whose registry is as imperfect as real ones are (a tracker project or a client channel shared by sibling
  initiatives), the ladder's "certain" decisions are right only ~79% of the time, and with today's loop those errors are
  never noticed: 85–91 wrong decisions froze in four weeks of replay;
- answers do not generalise (one answer, one fragment), audits do not exist, so the precision of what is auto-decided is
  unknowable in production;
- the store drops Gemini/Wispr name-only attendees (3 of 107 Gemini copies have a counterpart), keeps no repeat families
  (integration traffic is 74–97% of messages), and has no record kind or addressee.

Owen asked for a bench, two concepts, the better one in two variants, and a third, improved pipeline — plus an answer to
"do my answers reach the daemon or only the agent's turn, and is a dreaming-like recalibration needed?".

## What Changes

- **Lab bench** `src/lab/` (bench-only; nothing outside it may import it): datasets (frozen real stores outside the repo,
  a committed synthetic tenant rebuilt through the real `buildStore`), silver labelling, the replay of the loop (questions
  by group with an effort model, random audits, memory of people's answers only), metrics (auto-share at precision ≥ 95%,
  frozen errors, audit-estimated precision), and every variant of the three iterations. `docs/lab.md`.
- **Stage-0 floor in the attribution layer** (bug fixes): admin keywords match whole words and run after exclusive markers
  and registry routing; short title patterns are word-bounded; `{id, name}` channel entries; a channel shared by
  initiatives gives candidates; `sources.hosts` / `sources.apps`; the narrow rung ignores broad people; graded rung
  confidence; calls keyed by `call_id`; call participants from attendee names, glued-name splits, the linked calendar event
  and transcript speakers; thread recipients; `mpim` as direct; tracker keys route work blocks.
- **Item mode** (`attribution.json` `items`): the stage-0 floor over the stream's items — sender class, repeat clusters and
  families, item attribution, record kind and addressee — in `att_items`, read with `attribution({unit: 'item'})`.
- **Learning loop, shadow** (`attribution.json` `learn: {mode: "shadow"}`): from people's answers and audits only — never
  from the machine's own output — the build derives rung-instance calibration, earned keys, sibling-aware trust, a ranked
  question queue and a seeded audit sample, in `att_learn`, read with `attribution({learn: true})`. Shadow changes nothing
  the plan, the pins or the timelog use.
- **Evidence contract** (tenant data): a person's ledger line may carry `decided_by: human:<id>`, the machine's `guess`,
  `conf`, `rung` and an `audit` flag; items get `annotations/labels.jsonl`.

## Capabilities

### New Capabilities
- `ingest-lab`: the bench — datasets, gold tiers, the replay of the loop, the headline metric, the import boundary.
- `attribution-items`: the item floor and its readout.
- `attribution-learning`: the shadow learning loop and its evidence contract.

### Modified Capabilities
- `attribution`: the ladder's order and keyword matching, channel objects, graded confidence, call identity and call
  participants.

## Impact

- Code: `src/lab/**` (new); `src/sources/attribution/{ladder,registry,fragment,build,config,participants,items*,learn*}.ts`;
  `src/sources/{annotations,commitments,store}.ts` (additive: new tables `att_items`, `att_learn` via
  `CREATE TABLE IF NOT EXISTS`, no `SCHEMA_VERSION` bump), `src/sources/identities/{observations,collect,attendees}.ts`,
  `src/sources/{sender,fingerprint}.ts` (new pure modules); `snapshot/plain/sources-mcp.mjs` 1.11.0 (additive params).
- **Rollout:** bucket 1 for the ladder/participant fixes and bucket 2 for item mode and the loop — all of it runs only for a
  tenant with `annotations/attribution.json`, and no prod tenant has one, so prod (bluefin-ops' daemon) builds byte-identically
  apart from two new empty tables. Home canary: owen-ops' open days may change (closed days are pinned); `items` and
  `learn` are switched on in its attribution.json by hand. `docs/rollout.md` rows; the stale "no prod project has
  `sources`" note is corrected.
- **Out of scope:** the model step of the winning hybrid in production (J judging the residue inside the evening review;
  its queue readout and two-pass protocol), the tenant CLI's support for audit questions and `guess` fields (owen-ops repo),
  store-level adoption of the sender class / attendee parser (readouts such as `unanswered` would change for prod bluefin-ops:
  a flag of its own), merging the two attendee resolvers, `pinAfterDays` for item mode.
