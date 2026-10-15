# Tasks

- [x] 1.1 `pins.ts`: read/append the pins file, which fragments to pin (closed days), rules version; verify with unit tests.
- [x] 1.2 Plan precedence ledger > pin > ladder; `pinned` in the readout; `pinAfterDays` in attribution.json; verify with plan tests.
- [x] 1.3 Build: pin closed rule decisions each build; write `att:splits` / `att:policy`; verify with the build test.
- [x] 1.4 `orch sources attribution redo <slug> --since --until`; verify with a CLI test.
- [x] 2.1 `timelog` in the `.mjs` (1.7.0): the CLI's merge rules over att_fragments, days at query time; verify with ported timelog cases.
- [x] 2.2 Docs (`docs/sources.md` → Attribution: pins, timelog), ledger row.
- [x] 2.3 `budgets` in attribution.json and `reconciliation` in the `timelog` answer (1.8.0); verify with the CLI's summarize cases and an end-to-end month test.
- [ ] 3.1 Home: compare `timelog` with `owen-ops timelog` for October; explain differences; the reconciliation equals the CLI's `status --month`.
