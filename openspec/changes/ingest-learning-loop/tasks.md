# Tasks

## 1. The bench (`src/lab/`)
- [x] 1.1 Contract, dataset IO, metrics (auto-share at a precision floor, Wilson, risk–coverage, paired bootstrap, pairwise/B³), the bench-only model runner with a cache, the import boundary; verify: `node --import tsx --test src/lab/*.test.ts`.
- [x] 1.2 Runner (static, replay with grouped questions, the effort model, audits by credit, memory policies, nightly), scorer (split by case, auto at τ, loop metrics: frozen errors, audit-estimated precision, weekly curve), report, CLI (`npm run lab`); verify: `src/lab/run.test.ts`, `src/lab/score.test.ts`.
- [x] 1.3 Real-store exporter (the attribution loader exported read-only, `loadAttributionDrafts`, byte-identical recompute), call cases; silver labeller (two Opus passes + adjudication); verify: `src/lab/export.test.ts`, `src/lab/label.test.ts`, `src/sources/attribution/build.test.ts`.
- [x] 1.4 Synthetic `bench-agency` tenant: seeded plan with exact truth, Opus-rendered texts, raw records in the pullers' contracts, `buildStore`, committed fixture; verify: `src/lab/synth/*.test.ts` (determinism, contracts, fixture parity), `scripts/public-guard.sh`.
- [x] 1.5 Variants: `baseline` (main's ladder, frozen in `variants/frozen/`), `prod-today`, `stage0`, iteration 1 `keys`/`keys+g` and `judge`, iteration 2 `k2a`/`k2b`, iteration 3 `hybrid`, the parity check `prodlearn`; verify: `src/lab/variants/**/*.test.ts` (canned model outputs only).
- [x] 1.6 `docs/lab.md`.

## 2. Stage-0 floor in the attribution layer (bucket 1, prod-inert)
- [x] 2.1 Ladder/registry: whole-word Unicode admin keywords after exclusive markers and registry; word-bounded short titles; `{id,name}` channels (id first); shared channel → candidates; hosts/apps; narrow ignores broad; graded confidence; verify: `src/sources/attribution/{ladder,registry,attribution}.test.ts`; parity on the frozen owen-ops store: 6 ladder-alone changes, 0 after ledger and pins.
- [x] 2.2 Calls by `call_id` with a deterministic copy order; call participants (`participants.ts`: names as identities, glued splits, calendar link, speakers); run recipients; `mpim` direct; the identities collector keeps name-only attendees; tracker keys in work blocks; verify: `src/sources/attribution/{participants,build}.test.ts`, `src/sources/identities/identities.test.ts`.

## 3. Item mode (bucket 2: `attribution.json` `items`)
- [x] 3.1 `items.ts` (+ `items-load`, `items-text`, `items-people`, `items-dedup`): sender class, clusters, families, item attribution, kind, addressee → `att_items`; wired after the fragments in their own try/catch; verify: `src/sources/attribution/items*.test.ts`.
- [x] 3.2 `attribution({unit:'item'})` (sources MCP 1.10.0), byte-identical without `unit`; verify: `src/sources/mcp-server.test.ts`.

## 4. Learning loop in shadow (bucket 2: `attribution.json` `learn`)
- [x] 4.1 `learn.ts` (+ `learn-keys`, `learn-calib`, `learn-trust`, `learn-ask`): people's answers only, rung-instance calibration, earned keys, sibling-aware trust, questions (kinds take turns), seeded audits; verify: `src/sources/attribution/learn*.test.ts`.
- [x] 4.2 Evidence contract (`annotations.ts`: `human:<id>`, `guess/conf/rung/audit/answer`; `annotations/labels.jsonl`), `learn-load.ts`, `att_learn`, `attribution({learn:true})` (sources MCP 1.11.0); shadow identity of plan/index/pins/timelog; verify: `src/sources/attribution/learn-load.test.ts`, `src/sources/mcp-server.test.ts`.
- [x] 4.3 Parity: the production floor + learner replayed on the bench (`prodlearn`) against `k2a`; verify: `npm run lab -- run --dataset bench-agency --variant k2a,prodlearn --task t1-item --mode replay --q 3 --audit 0.15 --no-llm`.

## 5. Docs and rollout
- [x] 5.1 `docs/sources.md` → *Learning loop (shadow)*; `docs/lab.md`; `docs/rollout.md` rows and the corrected bucket note.
- [ ] 5.2 Canary (Owen): add `"items": {"days": 30}` and `"learn": {"mode": "shadow"}` to owen-ops' `annotations/attribution.json`; restart the daemon and the bot; read `attribution({learn:true})` after an evening review for two days.
- [ ] 5.3 Follow-ups (own changes): J in the evening review (queue readout, two passes, cells derived by the daemon); the tenant CLI writing `guess`/`audit` on answers and asking the audit sample; store-level adoption of the sender class and attendee parser behind a flag; one attendee resolver for `participants.ts` and `items-people.ts`.
