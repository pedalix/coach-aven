# Spec Delta

## Purpose
Gives a tenant the client's sheet — rows per date and sheet project, in the sheet's unit — computed from the timelog by
rules the tenant keeps as data, and records what was handed in so the month's reconciliation counts it.

## ADDED Requirements

### Requirement: Sheets are tenant data
A tenant MAY define sheets in `annotations/sheets.json`; each sheet SHALL name its umbrella, unit, rounding, columns,
comment language and layout rules, and an ordered list of project rules mapping evidence to the sheet's projects. The
file SHALL be validated at build and an invalid sheet SHALL be reported by name, never silently skipped.

#### Scenario: Two shops of one initiative
- **WHEN** a sheet maps evidence with tracker key `NS-` to `shop-north` and the rest of the same initiative to `shop-general`
- **THEN** a work block on `NS-41` lands on `shop-north` and a call about the shop without a key lands on `shop-general`

### Requirement: The timesheet readout
`timesheet({sheet, since, until})` SHALL return one row per date and sheet project with minutes, units and the
evidence behind them, computed with the timelog's merge rules after re-keying evidence to sheet projects; time of the
sheet's umbrella that no rule places SHALL be listed as `unmapped`, never dropped.

#### Scenario: Wall-clock holds across sheet projects
- **WHEN** two sheet projects' work blocks overlap on one day under the wall-clock policy
- **THEN** their minutes are scaled so the day's total does not exceed its wall-clock time

### Requirement: Opt-in layout
A sheet MAY shift weekend minutes to weekdays and cap units per day; rounding SHALL keep each project's period total
equal to its rounded period total. A laid-out sheet SHALL say so and keep each row's source days.

#### Scenario: A Saturday of work
- **WHEN** a sheet with `"weekends": "shift"` has 3 half-days of one code on a Saturday
- **THEN** they appear on the adjacent Friday (or the next weekdays with room under the cap) with `source_days` naming the Saturday

### Requirement: What was submitted counts
Periods recorded in `ledger/submitted.jsonl` SHALL be excluded from the readout's rows by default and SHALL be
reported by the month's reconciliation as `submitted`, with `open` computed only over the days after them.

#### Scenario: Half the month already billed
- **WHEN** 23 half-days were submitted for days 1–20 and the computed units for days 21–31 are 6
- **THEN** the reconciliation reports submitted 23, open 6, and the cap check uses 29

#### Scenario: No sheets
- **WHEN** a tenant has no `annotations/sheets.json` and no `ledger/submitted.jsonl`
- **THEN** `timesheet` answers "no sheets configured" and `reconcile`'s output is unchanged
