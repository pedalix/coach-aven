# Proposal

## Why

A scheduled routine fires whether or not anything happened: today's manual 09:04 brief spent a full turn to say "almost nothing new since 08:31". Gideon's suggestion service shows the cheap fix — fingerprint the inputs and skip the model when nothing changed. For us the fingerprint is exact: new store records since the routine's last delivered run, plus whether anything is due in the tenant ledgers.

## What Changes

- Before firing a scheduled or late routine of a project with `sources`, the host computes `delta` = raw lines ingested since the routine's last delivered fire and `due` = open escalations or commitments due today from the tenant checkout (`data/<slug>/tenant/annotations/*`).
- When `delta = 0` and `due` is empty, the host posts the routine's parent message with `nothing new since <last delivered run>` and records the outcome `skipped-empty`; no turn, no sandbox call, no cost.
- Flag `ROUTINE_SKIP_EMPTY=1` (bucket 3, off by default); a routine can opt out with `skipEmpty: false` in its state record.
- `/aven routines` and the guard preamble show skipped runs so the next real run still knows when the last delivered one was.

## Capabilities

### New Capabilities
- `routine-delivery`: what a scheduled routine run does when its slot comes (this change adds the empty-skip rule; the existing guard behaviour — catch-up, retry, preamble — is back-filled into this spec by an onboarding pass).

### Modified Capabilities
- (none)

## Impact

- `src/routineguard.ts` (decision), `src/pollers.ts` (fire path), `src/sources/store.ts` (a cheap "lines since" query by `raw_records` rowid or `sync_state`), tenant checkout readers in `src/sources/tenant.ts`, `src/blocks.ts` (routine list label), `docs/runtime-config.md`, `docs/rollout.md` row.
- Prod unaffected until the flag is set; prod projects have no sources, so the rule never applies there even when flipped.
