# Proposal

## Why

The learning loop (`ingest-learning-loop`, in shadow on the canary) learns from people only: a ledger line a person
decided, saying which question it answers (`answer`), what the machine proposed before (`guess`, `conf`, `rung`) and
whether it was an audit. Exactly one path writes such lines today — the tenant's own tooling: the review session asks
its own escalations in the chat, a CLI in the sandbox appends the lines and commits (path (a) of `docs/attribution.md`
→ *Evidence in answers*). That path presumes a tenant with tooling of its own, a sandbox clone that commits, and a person
who answers in the form that tooling parses. The loop's own questions — the ranked groups and the seeded audits — still
reach nobody: the readout lists them, the session has no way to record an answer to *them*, and a tenant without tooling
cannot run the loop at all.

Two known limitations of the shadow loop sit on the same path. The fragment ledger keeps its last-line-per-id rule, so
a `model` line written after a person's answer replaces that answer for the plan and the loop alike. And a platform that
only reads the tenant repo can never say *who* answered — a `human:<id>` in a line is whatever the writer claimed.

Decided with the owner on 2026-10-16: build path (b), the **platform writer** — the generic path for tenants without
tooling — beside (a), which stays valid.

## What Changes

- **Two sources tools, `ask` and `answer`** (sources MCP 1.12.0, additive), served where the tenant checkout lives —
  the daemon, or the bot's poller when a project has no daemon — and never by the read-only faces (`orch sources
  serve`, the stdio server):
  - `ask` takes the loop's question ids and/or `audits: true` (and a `max`), numbers them, persists the numbered post
    **outside the tenant repo** (`data/<slug>/attribution/asks.jsonl`, beside the pins: a day's posts survive a lost
    session) and returns the list for the agent to post — ids, form, guess, the units' titles or subjects and days,
    never message text.
  - `answer` takes the person's reply verbatim against a post (`{post, text}`, resolved mechanically; whatever needs
    judgement comes back unresolved) or the agent's structured reading (`items: [{question, label | confirm}]`),
    validates every label against the label space, appends the evidence lines into the tenant checkout
    (`fragments.jsonl`: one decided line per covered unit with `answer`/`guess`/`conf`/`rung`/`audit`; `labels.jsonl`
    for items), recomputes the attribution tables in the same call (read-your-writes: the next readout already carries
    the answer), returns the effect (units decided, calibration moved, questions left) and commits and pushes the tenant
    repo — one commit per call; a failed push is retried at the next pull, the checkout stays the truth meanwhile.
- **The decider is attested by the platform.** The person is the author of the chat message the turn answers, mapped
  to a person id through the tenant's people file (the platform user id, else the e-mail). The agent passes no `by`; a
  `by` in the input is ignored; without a mapping the answer is refused and nothing is written.
- **One writer for the ledger files, and a person's line is final.** While a tenant's answers go through the platform,
  its own tooling must not write `fragments.jsonl` / `labels.jsonl` (a documented contract; the platform refuses
  nothing). Whatever is written, a later machine line for a fragment a person decided no longer replaces it — the fix
  for the known limitation "a later ledger line still replaces a person's".
- **Idempotent** by answer id × unit: the same answer sent twice yields one line.
- **The tenant checkout becomes a writer's clone** where the installation opts in: `fetch` + rebase of local commits
  (today: `fetch` + hard reset) and a push with a per-push GitHub App token (`contents: write`, the tenant repo only);
  a conflict on the append-only ledgers is resolved mechanically, anything else leaves the checkout at the remote and
  logs.

## Capabilities

### New Capabilities
- none

### Modified Capabilities
- `attribution-learning`: the numbered post, the platform writer, attestation, idempotence, read-your-writes, the
  one-writer contract and the two opt-in gates. The capability itself is introduced by `ingest-learning-loop` (still in
  flight); this change is archived after it, so its delta lands on that spec.
- `attribution`: the ledger's last-line rule stops at a person's line.
- `sources-daemon`: the tenant checkout may carry the platform's commits — fetch + rebase, push, the write credential.

## Impact

- Code: `src/sources/attribution/{asks,reply,answer}.ts` (new; the pure parts with tests beside them),
  `src/sources/annotations.ts` (a person's line is final), `src/sources/attribution/config.ts` (`learn.writer`),
  `src/sources/tenant.ts` (rebase, commit, push), `src/sources/{daemon,sync,daemonclient}.ts` and
  `src/hostrouter.ts` / `src/hosttools.ts` / `src/turn.ts` (the turn's actor rides with every sources call),
  `snapshot/plain/sources-mcp.mjs` 1.12.0 (two tools, a writer hook). The sandbox image is untouched: since
  `host-tools` the server runs in the bot and in the daemon, not in the sandbox.
- **Rollout: bucket 2**, opt-in twice — per tenant (`annotations/attribution.json` → `learn: {…, "writer":
  "platform"}`; absent = `"tenant"`, today's path) and per installation (`SOURCES_TENANT_WRITE=1` in the ingest
  process's env — the daemon's, or the bot's; absent = today's `fetch` + hard reset, the git invocations byte-identical
  and test-pinned). Prod is untouched: no prod tenant has `learn` in its attribution.json and no prod `.env` has the
  flag; the tool table grows by two tools that answer "not configured" there, exactly as `attribution` answers for a
  tenant without attribution.json; the base system prompt does not change (golden fixtures byte-identical). The
  "person's line is final" parse rule is **bucket 1** (a bug fix — the documented contract already said a writer must
  not re-decide a judged fragment), measured on the frozen corpora before merge. Ledger row in `docs/rollout.md`.
  Canary on the home tenant after the tenant-tooling path has run for a few days.
- **Out of scope:** live mode of the loop (its own change: live-hold first, then live-decide); the model step of the
  review (judge → hinter); the review routine's prompt that posts the questions and calls the tools (tenant data);
  identity questions (`identities()` answers edit people.json, another ledger); a per-tenant list of who may answer
  (today: anyone the people file knows, inside a turn that passed the drive gate); the second pre-live contract
  (answers outside the units' window keep teaching).
