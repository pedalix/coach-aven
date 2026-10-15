# Proposal

## Why

The attribution layer (#176) decides by rule but does not keep the decision: rule decisions follow the current rules, and only the owen-ops CLI, reading the store file, records them in the tenant ledger so that billed hours do not move. With no files in sandboxes that CLI goes, so the platform must keep rule decisions itself (Owen, 2026-10-15: decided once, with the rule and the rules version; re-decided only by an explicit command; the tenant ledger keeps only judgments). And the timelog — minutes per day and initiative, the basis of billing — is computed by the same CLI from the ledger; it becomes a readout over the platform's own fragments.

## What Changes

- **Pins.** A `rule` decision for a fragment whose local day ended at least `pinAfterDays` (attribution.json, default 1) days ago is pinned: appended to `data/<slug>/attribution/pins.jsonl` on the bot host (outside the store, which is rebuilt from raw) with the attributions, the rule id, the rules version (hash of rules, registry and people markers) and the time. A pinned fragment is `decided` (by `rule`, `pinned`) and the ladder does not decide it again. The ledger still wins over a pin. `orch sources attribution redo <slug> --since D --until D` unpins a window; the next build decides it with the current rules.
- **Timelog readout** `timelog({since, until})` in the sources table: per local day (the tenant's zone, computed at query time) and initiative, the minutes of the subject's calls, message runs and work blocks under their effective decisions — calls count in full (topic shares by weight), runs and work are unioned per initiative minus call time, split aliases distribute by weight, a shared repo's ambiguity is broken by same-day activity, unattributed time is its own row with candidates. Ported from the owen-ops CLI's merge rules. Policy `parallelSessions: sum | wallclock` in attribution.json.
- **Budgets.** `budgets` in attribution.json (per umbrella: unit hour or half-day, cap per month, month overrides, breakdown by initiative or billing code). Every `timelog` answer then carries the month-to-date `reconciliation` the CLI's `status --month` printed: units used, cap, what is left, non-billable and unrouted time. The billing frames become tenant data instead of CLI code.
- **No local value stored**: pins and fragments carry UTC instants; days are cut when answering.
- Out of scope: identity and commitment readouts; switching the owen-ops session (its prompt and CLI change in the tenant repo, after this lands); retainer reconciliation (stays tenant-side, over the readout).

## Capabilities

### New Capabilities
- (none)

### Modified Capabilities
- `attribution`: rule decisions are pinned once their day has closed; a timelog readout over the fragments.

## Impact

- `src/sources/attribution/{pins,plan,build,config}.ts`, `src/sources/cli.ts` (`attribution redo`), `snapshot/plain/sources-mcp.mjs` (`timelog`, 1.7.0), tests, `docs/sources.md`, `docs/rollout.md`. Bucket 2: only tenants with attribution.json; prod has none.
