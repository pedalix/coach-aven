# Design

## Context

The attribution layer (#176–#182) decides with a deterministic ladder and leaves the rest to the evening review agent.
Owen asked (2026-10-15/16) for a bench to optimise the ingest pipeline — attribution, repeat detection, people, record
kind and addressee — in three iterations, and for an answer to "do my answers reach the daemon or only the agent's turn,
and is a dreaming-like recalibration needed?". This change is the bench, the three iterations' evidence, and the parts of
the winner that are deterministic enough to run in the daemon today.

## The bench, in one paragraph

Three datasets: owen-ops (390 fragments, 7,272 items, 402 mentions, 30 days), bluefin-ops (3,275 items), and `bench-agency`, a
synthetic agency tenant with exact truth whose given registry is as imperfect as real ones (a tracker project and a client
channel shared by sibling initiatives, a stale rule, broad title patterns, a rename, unregistered topics). Gold tiers: Owen's
answers, synthetic truth, an Opus silver reference (two passes in different orders + adjudication; 77% initiative / 97%
umbrella agreement with Owen on fragments, 18/18 on identities), the review agent's own labels, the ladder's. Headline:
auto-share at precision ≥ 95% (threshold on dev, measured on test, split by case). The replay decides day by day, a person
answers Q questions a day (grouped, with an effort model) and audits a random 15% share, and every memory row keeps the
pipeline's pre-answer guess.

## Findings that shaped the decisions

| | |
|---|---|
| Today's model step | The review agent's recorded decisions agree with the Opus reference on 49% of fragments at initiative level (79% umbrella). |
| Today's ladder | Single call-title hits wrong on 12/32 fragments, admin keywords on 4/5; repo routes 3/166, markers 0/23. |
| Stage 0 | Dedup pairs P/R 78/20 → 100/83 (owen-ops), 65/33 → 100/89 (bluefin-ops); identities auto@95 31 → 73; kind 0 → 39; addressee 0 → 87; bluefin-ops items 0 → 85; Gemini copies with a counterpart 3/107 → 107/107. |
| Iteration 1 | K "Earned Keys" vs J "Case Judge": a tie on the headline (0 / 0 / 77.8), K wins by the pre-registered rule. Nobody holds 95% on the synthetic tenant: the floor maps a key or channel to ONE initiative while the client has siblings (VN 52% right, BKR 54%); 85–91 errors froze in 4 weeks. J is far more accurate overall (items 82% vs 40%, kind macro-F1 .76 vs .21) but cannot be trusted at 95% yet. |
| Iteration 2 | Two variants of K: **K2a trust repair** (a structural rung decides the client; the initiative only with own cues and no sibling cues, or an earned key; umbrella-first questions) → items 32.7% at P 98.1%, **7 frozen errors**; K2b model veto → 0%, 36 frozen, and 79% false vetoes on a clean registry. |
| Iteration 3 | The hybrid (K2a spine, J residue) adds coverage (items umbrella 47.9%, fragments 23.7%, bluefin-ops 95.9% at P 99.5%) but J's own auto-decisions froze 39 errors: its confidence cells crossed τ on answers that were not a random sample of what they then decided. Iteration 3b guards it (below). |
| The loop | Machine output as evidence: 152 vs 84 frozen errors and weekly precision 87% → 71%. More questions help slowly (Q=10: 48 frozen); 15% audits at Q=3 keep the estimate honest but are too sparse to repair a rule; the nightly recalibration is a modest real gain (85 vs 95). The timelog as a per-unit signal (the subject's work block next to a call) is weak: 1/24, 4/13 — parallel work is the norm. |

## Decisions

- **Stage 0 ships as bug fixes inside the attribution layer** (bucket 1, prod-inert): it is the shared floor of every
  variant and its gains are measured on real data; the ladder's decide/stop semantics stay, only ordering and matching are
  fixed, so ledger decisions and pins keep attaching.
- **Item mode** carries the floor to items, for team tenants (no subject needed) and for the subject's incoming stream.
- **The learning loop ships in shadow, deterministic, in the daemon**: K2a's spine (calibration per rung instance, earned
  keys, sibling-aware trust, umbrella-first questions, seeded audits). The production learner replayed on the bench
  (`prodlearn`) reproduces K2a: fragments 8.2% vs 8.5%, bluefin-ops 84.9 vs 85.7, items 7 frozen errors with its own question
  order.
- **The model step stays in the sandbox and out of this change.** The bench says it must earn its right to decide on
  random checks of its own decisions (iteration 3b); until then its label is the question's guess — a right confirm costs
  Owen half a question.
- **People's answers are the only evidence.** Never the floor's, the loop's or a model's output.

## The loop: answers, the daemon, and "dreaming"

- An answer is tenant data: a ledger line by a person (`human:<id>`, with the machine's `guess`, `conf`, `rung` and an
  `audit` flag), or a line of `annotations/labels.jsonl` for items. The daemon fetches the tenant before every build and
  re-derives everything from it: the decisions, the key tables, the calibration of every rung instance, the trust in
  structural routes, the ranked questions and the audit sample. The agent's turn reads the result; nothing is learned
  inside a model or in agent memory, and a rebuild from raw plus the tenant reproduces the same state (pins excepted, by
  design).
- **Recalibration is needed, and it is deterministic**: it runs in every build, not as a nightly agent. `src/dream.ts`
  stays memory-only: pipeline knowledge there would be unversioned, invisible to the daemon and lost on reset.
- The language part of a "dream" belongs in the evening review as a reflect step: read the cases where the answer differed
  from the guess and the calibration readout, word at most a few typed proposals (a rule, an alias, a host or app, a new
  initiative for an `unregistered` cluster) as questions, and spend the audit share. A follow-up change.

## Risks / Trade-offs

- [Silver gold has the labeller's biases] → the headline on real data is scored on Owen's answers or at umbrella level;
  synthetic truth carries the iteration decisions.
- [Rung confidences of stage 0 were set against the same datasets] → in-sample for T2–T4; production moves them only by
  answers and audits (the loop), never by the bench.
- [A wrong pin froze before this change] → the two known "private" admin pins stay until `orch sources attribution redo`.
- [Item mode costs ~1 s per build on 7k items] → only for tenants that opt in; loading items once for both passes is a
  follow-up.

## Migration Plan

Merge; prod is untouched (no prod tenant has attribution.json). Home canary: owen-ops picks up the ladder fixes on the
next build — on the frozen corpus, with the ledger and the pins, no decision changes and no pin is written; what does move
is listed in the rollout row (zero-length Gemini copies become twins of their calls; a merged call lasts until its last
copy ends, so two closed calls gained 4 and 18 minutes); switch on `items` and `learn: {mode: "shadow"}` and read
`attribution({learn: true})` after two evening reviews. Live mode, the model step in the review and the tenant CLI's audit
questions are follow-up changes, each with its own ledger row.
