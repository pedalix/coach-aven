# Spec Delta

## ADDED Requirements

### Requirement: The bench never ships
`src/lab/` SHALL be imported by nothing outside it, and only `src/lab/llm.ts` SHALL spawn a model; a winning variant reaches production only by being ported into the deterministic layer or a sandbox routine behind a tenant opt-in or a flag.

#### Scenario: A runtime module imports the lab
- **WHEN** a file outside `src/lab/` imports from it
- **THEN** `src/lab/imports.test.ts` fails

### Requirement: Real data stays outside the repo
Datasets exported from real stores, their silver labels and their run results SHALL live under `LAB_DIR` (default `data/lab`, gitignored), and reports of real runs SHALL contain counts and label pairs only, never unit text; the committed synthetic tenant SHALL be fictional and pass `scripts/public-guard.sh`.

#### Scenario: A report of a real run
- **WHEN** `npm run lab -- report` renders a run over a real dataset
- **THEN** it holds numbers and label ids, and no subject, text or unit id

### Requirement: One headline, honestly split
The bench SHALL report, per dataset × task × variant, the share of test units decided automatically at the threshold chosen on dev where precision stays at or above 95%, with the Wilson interval, a conservative variant (the lower bound must hold), the share at the fixed cut τ, umbrella- and minutes-weighted views, cost, and a paired bootstrap against the first variant; the dev/test split SHALL go by case (a call's copies and topics, a ticket, a thread).

#### Scenario: A call judged once
- **WHEN** a person labelled a call and the bench scores its topics
- **THEN** all topics and copies of that call land on the same side of the split

### Requirement: The replay of the loop
`--mode replay` SHALL decide the window day by day with memory of earlier days only, answer each day's questions from gold within an effort budget (a group is one question; a right confirm costs half, a wrong one 1.5), spend a share of the budget on random audits of auto-decided units, keep the pipeline's pre-answer guess on every memory row, run the variant's nightly pass, and report frozen errors, audit-estimated precision, effort per day and the weekly curve.

#### Scenario: The poisoning test
- **WHEN** a replay runs with `--memory loop` and a variant that counts its own decisions as evidence
- **THEN** the report shows its frozen errors and weekly precision next to the same variant that does not
