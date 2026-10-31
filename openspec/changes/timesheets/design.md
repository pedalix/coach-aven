# Design: timesheets

## Where it sits

```
store (att_fragments) → fragmentsToEvidence (+ rule facets) → co-activity per day ─┬─→ buildTimelog → reconcile (+ submitted)   (timelog)
                                                                                    └─→ sheetEvidence → buildTimelog → layoutSheet  (timesheet)
annotations/sheets.json ─┐  read at build (sheets.ts: validated)  → sync_state att:sheets    ─→ the rules, unit, layout
ledger/submitted.jsonl  ─┘                                         → sync_state att:submitted ─→ days left out, cap, reconcile
```

The MCP reads only the store, so both tenant files are read by the build beside `attribution.json` and stored as meta
keys — written when the file exists, deleted when it no longer does. A tenant without them keeps its build fingerprint.
A broken `sheets.json` never fails the build: it is stored as `{error}` and the readout says it, naming the sheet and
the rule (the plan, the pins and the timelog never read either file).

The sheet reuses the timelog's merge unchanged (calls in full, coding unioned per key minus call time, the wall-clock
policy): the co-activity rule runs first over real initiative ids, then each evidence item's billable parts of the
sheet's umbrella are re-keyed to `sheet:<project>` (or `unmapped:<initiative>`); every other route stays as it is, so
the day's wall-clock scaling is exactly the timelog's and a sheet's minutes never exceed the day.

## `annotations/sheets.json`

```jsonc
{
  "sheets": [
    {
      "id": "northwind",                     // what the person and the tool call it
      "umbrella": "northwind",               // only billable evidence routed to this umbrella enters the sheet
      "unit": "hour",                         // "hour" | "half_day" (unitMinutes: 60 | 240 unless given)
      "step": 1,                              // rounding step in units (default 0.1 hour, 0.5 half-day)
      "columns": ["date", "comment", "project", "who", "units"],   // paste order; "skip" = a formula column
      "who": "Jane", "dateFormat": "DD/MM/YYYY",
      "comment": { "language": "en", "style": "one line, what was done" },
      "layout": { "weekends": "shift", "maxUnitsPerDay": 2 },
      "projects": [                            // first match wins
        { "initiative": "northwind/shop", "match": { "keys": ["NS"] }, "project": "shop-north" },
        { "initiative": "northwind/shop", "match": { "keys": ["SS"] }, "project": "shop-south" },
        { "initiative": "northwind/shop", "sameDay": true },
        { "initiative": "northwind/shop", "project": "shop-general" },
        { "initiative": "northwind/cms",  "match": { "repos": ["north-cms-sync"] }, "project": "cms-north" },
        { "initiative": ["northwind/infra", "northwind/internal"], "project": "Internal" },
        { "project": "tbd" }
      ]
    },
    { "id": "acme", "umbrella": "acme", "unit": "half_day", "step": 0.5,
      "columns": ["date", "comment", "project", "skip", "who", "units"], "who": "Jane",
      "layout": { "weekends": "shift", "maxUnitsPerDay": 2 }, "projects": [{ "projectFrom": "billing_code" }] }
  ]
}
```

A rule is exactly one of `project`, `projectFrom: "billing_code"` (a sheet whose projects are the codes) or
`sameDay: true` — the project an earlier explicit rule gave the same initiative's evidence that day (most minutes);
none that day → the next rule. `initiative` (an id or a list, of the umbrella) and `match` narrow it, AND-ed: `keys`
(the fragment's tracker key prefixes), `repos` (the work block's repository, on its tail, `*` within a segment),
`containers` (a channel or folder, exact), `title` (a case-insensitive regular expression). Validated at build:
unknown keys, an initiative outside the umbrella, a bad expression, a `who` column without `who`, a cap that is not a
multiple of the step, a rule a catch-all before it makes unreachable — each fails with the sheet and the rule named.

Non-billable initiatives (no billing code) never enter a sheet; a split across umbrellas keeps its other parts.

## The readout

`timesheet({sheet, since, until, include_submitted})` →

```jsonc
{ "sheet": "northwind", "umbrella": "northwind", "unit": "hour", "step": 1, "since": "…", "until": "…", "layout": "kept",
  "columns": [ … ], "who": "Jane", "date_format": "DD/MM/YYYY", "comment": { "language": "en", … },
  "rows": [ { "date": "2026-10-12", "project": "shop-north", "units": 3, "minutes": 190,
              "source_days": [ … ], "moved_in": [ … ], "moved_out": 1,           // only when the layout moved something
              "evidence": [ { "kind": "work", "title": "…", "minutes": 150, "keys": ["NS"], "container": "…" } ] } ],
  "totals": { "units": 5, "minutes": 310, "by_project": { … } },
  "folded": [ … ], "unmapped": [ … ], "undecided": [ … ], "over_cap_days": [ … ],
  "submitted": [ { "id": "nw-1", "since": "…", "until": "…", "units": 30 } ],
  "cap": { "month": "2026-10", "cap": 70, "submitted": 30, "rows": 5, "left": 35 } }
```

Days inside a submitted period of the sheet are left out of the rows (and are never a layout target) unless
`include_submitted` — the person asked for "the rest of the month". `cap` is the month of `until` against the
umbrella's budget when its unit is the sheet's. The agent writes each row's comment from `evidence` in the sheet's
language and style and lays the table out in `columns` order.

## Layout (pure, `layoutSheet` in the sources MCP)

1. Weekends (`"weekends": "shift"`): Saturday → Friday, Sunday → Monday; the other one when the first is outside the
   window or a submitted day; rows keep `source_days`.
2. Rounding per row to `step`: each project's period total is its rounded total, spread over its rows by largest
   remainder (ties: the bigger row, then the earlier day) — rounding never invents or loses a unit over the period. A
   day's project time too small for a step is `folded`: counted in the total, carried by the project's other rows.
3. Per-day cap (`maxUnitsPerDay`), after rounding so whole steps move: units above it move one step at a time to the
   nearest weekday with room (outside the window, submitted days and — when shifting — weekends are no targets),
   preferring a day the same project already has; a row made by the cap carries the evidence it came from. No room
   anywhere → `over_cap_days`, never dropped.
A sheet with any move says `layout: "shifted"`; the rows' dates are then a layout of the work, `source_days` the facts.

## `ledger/submitted.jsonl`

One line per handed-in sheet period: `{id, sheet, since, until, submitted_at?, by?, rows: [{date, project, units,
comment?}]}`; append-only, the last line per id wins (a corrected resubmission replaces), a malformed line is named
(`submitted_errors`) and skipped. Written by the tenant's tooling when the person confirms ("сдал", "submitted") —
the platform only reads it. The month's `reconcile` adds, per budget whose umbrella has a sheet with a period in the
month: `submitted` (the units of its rows dated in the month), `open` (the budget's own rounding over the month's days
no period covers) and `committed` = submitted + open; `remaining` is then cap − committed. `used` and `by` stay the
computed month, so the person sees computed against billed. Without a period the budget object is untouched.

## Not doing

No comment writing in the platform, no spreadsheet API, no new attribution rules from sheet answers (a mapping the
person corrects becomes a `projects` rule in `sheets.json`, committed by the tenant's tooling), no monthly cap applied
to the rows (`cap` reports; the person decides what to bill).
