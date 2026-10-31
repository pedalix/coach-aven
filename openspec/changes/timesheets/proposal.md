# Proposal: timesheets — the client's sheet from the timelog, and what was submitted

## Why

A contractor bills several clients, each on its own sheet: one counts half-days per billing code with columns
Date · Feature · Project · Who · Half-days, another counts hours per sheet project (its own list, e.g. `shop-north`,
`shop-south`, `cms-alpine`, `Internal`, `tbd`), a third counts hours with an English comment per day. The timelog
already knows the minutes per day and initiative, with evidence. Turning that into a sheet took an hour and a half of
chat on the canary (2026-10-20/21): mapping initiatives to the sheet's projects, rules said once in the chat and lost
(product work is not this client's, infra goes to `Internal` unless it serves one project, no split of one shop's
time, one row per date and project, weekend work moved to weekdays, at most two half-days a day), and nothing
recorded what was handed in — the month's reconciliation kept warning "over the cap" against numbers already billed.

## What changes

- **Sheets as tenant data**: `annotations/sheets.json` in the tenant repository — per sheet: the umbrella it bills,
  the unit (`half_day` / `hour`) and rounding, the columns, the language of the comment, the layout rules, and an
  ordered list of **project rules** that map evidence to the sheet's projects (by initiative, and inside an initiative
  by tracker key, repository, container or title pattern).
- **A `timesheet` readout** (sources MCP): `timesheet({sheet, since, until})` → one row per date and sheet project:
  minutes, units, the evidence (titles and refs) the agent writes the one-line comment from, and what the rules could
  not place (`unmapped`, with candidates). Deterministic; the platform never writes the comment (no model step).
- **Layout rules**, opt-in per sheet: weekend minutes moved to the nearest weekday, a per-day cap in units, rows below
  the rounding threshold merged into the day's largest row of the same project; a laid-out sheet says so (`layout:
  shifted`) and keeps each row's source days.
- **What was submitted**: `ledger/submitted.jsonl` in the tenant repository — per sheet and period, the rows as handed
  in (date, project, units, comment) and the totals; written by the tenant's tooling when the person says the sheet
  went out. The readout and the month's reconciliation read it: `submitted` per budget and period, and the open
  remainder computed only over days not submitted yet.

## Not in this change

- Writing to the client's spreadsheet (the person pastes; a Google Sheets writer is a later, separate change).
- Re-deciding attribution: the sheet maps what the timelog decided; a wrong initiative is fixed in the ledger first.

## Rollout

Bucket 2 by construction: only a tenant with `annotations/sheets.json` gets a `timesheet` answer other than "no
sheets configured"; `reconcile` adds `submitted` only when `ledger/submitted.jsonl` exists (golden test: today's
output byte-identical without it).
