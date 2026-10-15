# Proposal

## Why

The owen-ops review session runs tenant code inside the sandbox that reads the store file with SQL: a fragmenter that cuts the owner's day into calls, message runs and work blocks, a deterministic attribution ladder over rules, people markers and the initiative registry, and rule proposals from recorded judgments. With no mounts and no exceptions (Owen, 2026-10-15) that code has no store. None of it is specific to owen-ops: the data it runs on — `initiatives.json` routing keys, `annotations/rules.json`, people markers, `annotations/fragments.jsonl` — is the same contract bluefin-ops already ships, and bluefin-ops' brief maps tickets to initiatives by having the model read `rules.json`. As a platform layer of the store build the logic runs where the data is, the sandbox needs no file, and interpretation moves out of the model: rules decide about half of owen-ops' fragments today (163 of 300 live decisions), and every tenant gets the same ladder for free.

## What Changes

- **Attribution layer in the store build** (`src/sources/attribution/`): for a tenant that ships `annotations/attribution.json`, cut the subject's days into fragments (calls, with one sub-fragment per summary topic; runs of the subject's own messages; work blocks from `activity`), drop or attach greeting-only runs, run every fragment through the ladder (tenant rules, admin bucket, exclusive markers, registry routing, narrow and broad markers) and derive rule proposals from the recorded judgments. Ported from the owen-ops CLI with the same constants and the same fragment ids, so every existing ledger decision attaches unchanged.
- **Derived tables** `att_fragments`, `att_decisions`, `att_proposals`, recomputed at every build in which the store or a tenant file changed. A fragment the ledger already decides keeps its ledger decision; the ladder only decides the rest.
- **Readout tool** `attribution({since, until, state})` in the sources table (1.5.0): the window's fragments with their effective decision — `ledger`, `rule` or `open` with candidates and a hint — and the rule proposals. It replaces the plan the CLI printed from the file.
- **Tenant contract, data only**: `initiatives.json` (repo root), `annotations/rules.json`, `annotations/people.json`, and the new `annotations/attribution.json` (subject person, horizon, time zone, thread gap, substance filter, the admin bucket per umbrella). No tenant code runs on the host.
- **Out of scope** (follow-up changes): whether rule decisions are pinned by the platform or recorded in the tenant ledger (Owen to decide); the timelog readout; identity and commitment readouts; switching the owen-ops review session to the tool and deleting its loader; an item mode for organisational tenants (bluefin-ops: tickets and channel threads straight to initiatives).

## Capabilities

### New Capabilities
- `attribution`: deterministic attribution of a subject's calls, message runs and work blocks to the tenant's initiatives, computed in the store build from tenant data and served as a readout.

### Modified Capabilities
- (none)

## Impact

- New `src/sources/attribution/` (registry, fragment, substance, ladder, plan, config, build) with tests ported from the owen-ops CLI (names anonymised for the public repo); `src/sources/store.ts` schema v7 (new tables; a v6 store rebuilds from raw once); `src/sources/run.ts` passes the tenant files; `snapshot/plain/sources-mcp.mjs` gains `attribution` (1.5.0); `docs/sources.md` → *Attribution*; `docs/rollout.md` row.
- Bucket 2: the layer runs only for a project whose tenant ships `annotations/attribution.json`, and the tool answers "not configured" otherwise. No prod project has a `sources` block.
