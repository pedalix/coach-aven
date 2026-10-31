# Design: timesheets

## Where it sits

```
store (fragments, attributions) → timelog evidence (fragmentsToEvidence) ─┬─→ buildTimelog → reconcile        (today)
                                                                           └─→ sheetEvidence → buildTimelog → layout → rows   (new)
annotations/sheets.json (tenant) ─────────────── project rules, unit, layout ─┘
ledger/submitted.jsonl (tenant) ─→ reconcile(submitted) and timesheet(… already submitted days …)
```

The sheet reuses the timelog's merge rules unchanged (calls in full, coding unioned per key minus call time, the
wall-clock policy): before `buildTimelog` runs, each evidence item's route is re-keyed from its initiative to
`sheet:<project>` by the sheet's rules. The wall-clock scaling then happens between sheet projects exactly as it does
between initiatives, so a sheet's minutes never exceed the day.

## `annotations/sheets.json`

```jsonc
{
  "sheets": [
    {
      "id": "northwind",                     // what the person and the tool call it
      "umbrella": "northwind",               // only evidence routed to this umbrella enters the sheet
      "unit": "hour",                         // "hour" | "half_day" (half_day = 240 min unless unitMinutes says otherwise)
      "round": { "step": 1, "mode": "nearest", "minUnits": 1 },   // per row, after layout
      "columns": ["date", "project", "units", "comment"],
      "comment": { "language": "en", "style": "one line, what was done, no ticket noise" },
      "layout": { "weekends": "keep", "maxUnitsPerDay": null },
      "projects": [                            // first match wins; evidence of the umbrella no rule matches is `unmapped`
        { "project": "shop-north",  "initiative": "northwind/shop/shop", "match": { "keys": ["NS"] } },
        { "project": "shop-south",  "initiative": "northwind/shop/shop", "match": { "keys": ["SS"] } },
        { "project": "shop-general","initiative": "northwind/shop/shop" },
        { "project": "Internal",    "initiative": "northwind/infra/infra" },
        { "project": "Internal",    "initiative": "northwind/internal/internal" }
      ]
    }
  ]
}
```

`match` (all optional, AND-ed): `keys` — tracker key prefixes in the evidence (`NS-12`); `repos` — the work block's
repository; `containers` — a channel or folder; `title` — a regular expression over the evidence title. A rule without
`initiative` matches any initiative of the umbrella. Validated at build: unknown keys, a project not in a `projects`
rule, a rule after a catch-all for the same initiative (unreachable) — all fail with the sheet and rule named.

## The readout

`timesheet({sheet, since, until, layout: true})` →

```jsonc
{ "sheet": "northwind", "since": "2026-10-01", "until": "2026-10-31", "unit": "hour", "layout": "kept",
  "rows": [ { "date": "2026-10-01", "project": "shop-north", "minutes": 112, "units": 2,
              "source_days": ["2026-10-01"], "evidence": [ { "title": "…", "ref": "…", "kind": "work" } ] } ],
  "totals": { "units": 19, "minutes": 1140, "by_project": { … } },
  "unmapped": [ { "date": "…", "minutes": 7, "initiative": "…", "evidence": [ … ] } ],
  "submitted": [ { "since": "2026-10-01", "until": "2026-10-20", "units": 19, "submitted_at": "…" } ],
  "open_days": { "since": "2026-10-21", "until": "2026-10-31" },
  "cap": { "units": 70, "used_submitted": 19, "left": 51 } }
```

`rows` cover only the days not already in a submitted period (the person asked for "the rest of October"), unless
`include_submitted: true`. The agent writes each row's comment from `evidence` in the sheet's language and style; the
readout's `columns` order is how it lays the table out for pasting.

## Layout (pure, `src/sources/attribution/sheetlayout.ts`)

1. Weekends (`"weekends": "shift"`): Saturday and Sunday minutes move to the nearest weekday of the same ISO week
   (Saturday → Friday, Sunday → Monday of the next week only when the period continues there, else Friday); the row
   keeps `source_days`.
2. Per-day cap (`maxUnitsPerDay`): units above the cap move to the closest weekday with room, the same project first.
3. Rounding per row (`round`), then the rounding remainder is carried to keep the period total equal to the
   rounded period total per project (largest-remainder), so rounding never invents or loses a unit over the period.
A sheet with any shift says `layout: "shifted"`; the rows' dates are then a layout of the work, `source_days` the
facts. Never applied unless the sheet opts in.

## `ledger/submitted.jsonl`

One line per handed-in sheet: `{id, sheet, since, until, submitted_at, rows: [{date, project, units, comment}],
totals: {units, by_project}, by: <person>}`; append-only, last line per id wins (a corrected resubmission replaces).
Written by the tenant's tooling when the person confirms ("сдал", "submitted") — the platform only reads it. The
month's `reconcile` adds per budget: `submitted` (units of periods inside the month) and `open` (the computed units of
the days after them), so "over the cap" is judged on submitted + open, not on a recount of billed days.

## Not doing

No comment writing in the platform, no spreadsheet API, no new attribution rules from sheet answers (a mapping the
person corrects becomes a `projects` rule in `sheets.json`, committed by the tenant's tooling).
