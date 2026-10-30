# Lab — a bench for the ingest pipeline

The sources store turns a tenant's stream (mail, chat, tickets, calls, calendars, work sessions) into derived layers:
attribution of work to initiatives, repeat families, people, record kind and addressee. Each of those is a classifier
with a cost when it is wrong — a mis-billed hour, a question Owen has to answer, a request nobody sees. The lab
(`src/lab/`) measures them: the same units, the same gold, every variant scored the same way, so a change to the pipeline
is argued with numbers instead of anecdotes.

The lab is **bench-only code**. Nothing outside `src/lab/` imports it (`src/lab/imports.test.ts`), and only
`src/lab/llm.ts` may call a model (`claude -p` on the owner's machine, cached) — production never calls a model on the
host. A variant that wins on the bench reaches production by being ported into the deterministic layer
(`src/sources/attribution/`) or into a sandbox routine, behind a tenant opt-in or a flag (`docs/rollout.md`).

## Datasets

A dataset is a directory (`src/lab/types.ts`):

| Path | What |
| --- | --- |
| `meta.json` | name, kind (`real`/`synthetic`), tenant zone, window, subject, the closed label space (initiatives, umbrellas, people) |
| `store.sqlite` | the frozen store the units come from (variants may query it read-only) |
| `tenant/` | the tenant data the pipeline is GIVEN (registry, rules, people, attribution.json) |
| `units/{fragment,item,mention}.jsonl` | features only, never labels |
| `gold/<task>.jsonl` | labels with a **tier**: `human` (the owner's answers), `synthetic` (exact by construction), `opus` (silver: two Opus passes in different orders + adjudication), `model` (the production review agent), `rule` (the production ladder — tautological, a no-regression set) |

**Real datasets never enter the repo.** They live under `LAB_DIR` (default `data/lab`, gitignored), exported from a
frozen copy of a store (`npm run lab -- export …`) and labelled with `npm run lab -- label …` (silver, Opus). Reports of
real runs contain counts and label pairs only, never unit text.

A fragment unit's `ladder` (what the `baseline` and `prod-today` read as today's production) is **main's** ladder and
registry parse (`variants/frozen/`), run over the drafts of **this branch's** fragmenter. The fragmenter changed on this
branch (recorder copies merged by call id, more participants resolved), so a re-export changes fragment ids and counts —
calls whose copies used to be separate fragments become one — and earlier runs and silver labels of the old export no
longer line up with the new units: re-export, re-label and re-run together. Main's ladder over these drafts is close to,
not exactly, main's production: with more participants resolved, its marker and admin rungs fire more often.

**Known limitation — the tenant is the freeze's, not the window start's.** `tenant/` is linked as given, and
`MentionUnit.production` is the store's resolution at the freeze. Answers given *inside* the window are therefore
visible from its first day: rules written from them (`created`), identity merges and the `people.json` they rewrote.
The ladder and `stage0` (whose `rulesAsOf` defaults to `all`) read those rules, the t3 baseline agrees with part of the
human gold by construction, and the silver labeller's context pack carries the same roster. No as-of tenant is rebuilt
yet; `export.json` → `warnings` counts the rules, merges and answered identity questions dated on or after `since`, so
read human-tier t1/t3 numbers of a real dataset with that count in mind.

**The synthetic tenant** (`bench-agency`) is committed: a fictional SMB agency with its own SaaS product, four weeks of
Slack, mail, tickets, calls (Granola/Gemini/Wispr copies, glued Gemini invitee lines), calendars and work sessions.
*Plan, then render*: a seeded plan fixes every item and its truth (initiative shares or `none`/`unregistered`, repeat
clusters, the identity behind every surface form, kind, addressee); Opus only writes the human texts; the raw records go
through the real `buildStore`. The tenant it is given is deliberately imperfect — a tracker project and a client channel
that span sibling initiatives, a stale channel rule, over-broad title patterns, a renamed project, unregistered topics —
because that is what real registries look like. `npm run lab -- synth build` rebuilds it from the committed fixture
(`src/lab/fixtures/bench-agency/`) without calling a model — or from `$LAB_DIR/synth/bench-agency` when a render lives
there (`--fixture` forces the fixture). Its people, companies and organisations are invented (the places are real);
`synth fixture` refuses a render of any other plan or world, and `scripts/public-guard.sh` reads inside the gzipped
fixture.

## Tasks and the headline

| Task | Unit → label |
| --- | --- |
| `t1-fragment` | the subject's fragment (call topic, message run, work block) → initiative \| `none` \| `unregistered` |
| `t1-item` | an item of the stream → initiative \| `none` \| `unregistered` |
| `t2-dedup` | an item → its repeat cluster (scored as a clustering: pairwise, B³, compression, human-item safety) |
| `t3-identity` | a raw participant mention → person(s) \| `system` \| `unknown` |
| `t4-kind` | an incoming item → request \| question \| commitment \| incident \| info \| noise |
| `t4-addressee` | an incoming item → who must act or answer (person ids) \| `none` |

**Headline: auto-share at precision ≥ 95%** — the share of units a variant may decide without a person while the decided
ones stay at least 95% right. The threshold is chosen on a dev split and the share reported on test; the split is by
**case** (`src/lab/cases.ts`: all topics and recorder copies of one call, a ticket and its comments, one thread), so an
answer Owen gave per call cannot leak across it. Also reported: the conservative variant (the Wilson lower bound must hold
the floor), the auto-share at the fixed cut τ = .95 (what production does; `--floor` renames the auto@ columns, never
τ), umbrella-level scoring, minutes-weighted scoring (what the timelog bills), cost per unit and per auto-decided unit, a
paired bootstrap against the first variant — resampling whole cases, since the units of one case move together.

## Replay: the loop

`--mode replay` decides the window day by day the way production meets the stream, and a person answers:

- **Questions** below τ go to a person, `--q` per day in *effort* units: a variant groups units into one question
  (`Prediction.ask.group` — a call, a client-day, a repeat family), a `confirm` with the right guess costs half a question,
  a wrong guess 1.5, every extra distinct gold label in the group one more. The person takes the groups in the variant's
  rank order while budget is left and pays each one's cost after answering it (the last may overrun the day by its own
  cost): that cost depends on the answer, so it must never decide which questions get asked.
- **Audits** (`--audit 0.15`): that share of the budget goes to random checks of auto-decided units (credit accrues across
  days; what a day carries over is capped at one day's share, at least one audit, so quiet days cannot bank audits that
  crowd out a later day's questions). They are the only unbiased sample of the machine's precision — questions are, by
  construction, the units it was unsure of.
- **Memory** (`--memory`): `none` = the person's answers only; `loop` adds the pipeline's own decisions (the poisoning
  test); `oracle` = every gold label of earlier days (an upper bound). Every memory row keeps what the pipeline said before
  the answer (`predicted`, `conf`, `rung`) — without that pair nothing can be calibrated.
- **Nightly**: after each day the variant's `nightly` pass runs (recalibration — the deterministic half of a "dream");
  `--opt nightly=off` is the ablation. Every `--opt key=value` of a run is saved in the result (`opts.opt`) and named in
  the report's run label; ablations under one `--run` still share a result path, so give each its own `--run`.

The loop section of a report shows what τ let through and at which precision, the **frozen errors** (wrong auto-decisions
no audit caught — production pins them after a day), what the audits would have told the owner about precision, the
person's effort per day and the weekly curve.

## Variants

| Name | What |
| --- | --- |
| `baseline` | today's production (main before this change): the ladder, exact repeats, the store's resolution, `is_bot`, `role='to'` — frozen copies in `variants/frozen/` |
| `prod-today` | the ladder plus the review agent's recorded model decisions — its last own line per fragment in the ledger history, the ones Owen later overrode included (owen-ops fragments, static) |
| `stage0` | the deterministic floor both concepts share — the fix pack ported to `src/sources/attribution/` |
| `keys`, `keys+g` | iteration 1, concept K "Earned Keys": answers label typed keys (thread, family, host, series…); a key type decides once it has earned τ on later answers; `+g` pre-fills question guesses with one cheap model call a day |
| `judge` | iteration 1, concept J "Case Judge": two model passes over cases against the full closed list; confidence = the measured precision of the agreement × cite cell, learned from answers and audits |
| `k2a`, `k2b` | iteration 2, two variants of the winner K: sibling-aware trust repair (deterministic) vs a model veto on structural decisions (never evidence) |
| `hybrid` | iteration 3: the K2a spine decides what it can prove; J judges the rest; people calibrate both |

## Running it

```bash
export LAB_DIR=~/lab LAB_ENV_FILE=/path/to/the/bot/.env   # LAB_ENV_FILE: where CLAUDE_CODE_OAUTH_TOKEN lives
npm run lab -- synth build                                 # the synthetic tenant from the committed fixture
npm run lab -- run --dataset bench-agency --variant baseline,stage0,k2a,hybrid --task t1-item \
                   --mode replay --q 3 --audit 0.15 --run my-run
npm run lab -- report --run my-run [--level umbrella] [--tiers human]
npm run lab -- export --name my-tenant --store <frozen store.sqlite> --tenant <tenant dir> --until 2026-10-15
npm run lab -- label --dataset my-tenant --task t1-fragment     # Opus silver (spends the token; cached)
```

Model calls are cached by (model, system, prompt) in `LAB_DIR/cache/`, so re-scoring and re-running are free; the cache
stores what a call cost, so a cached replay still reports the cost of the variant. The `claude -p` child runs in the
isolated config dir with CLAUDE.md loading off, so no checkout's `CLAUDE.md`/`CLAUDE.local.md`/`AGENTS.md` rides along;
calls cached before 2026-10-16 were made with the checkout's files in context.

The bench runs on a subscription token only (`LAB_CLAUDE_TOKEN`, else `CLAUDE_CODE_OAUTH_TOKEN` from `LAB_ENV_FILE`), even
for an installation whose bot runs on an API key: it reads no `ANTHROPIC_API_KEY`, and strips the shell's before the
child starts. The CLI probe is the tool that runs on a key (`CLI_PROBE_API_KEY`, [`cli-probe.md`](cli-probe.md)).
