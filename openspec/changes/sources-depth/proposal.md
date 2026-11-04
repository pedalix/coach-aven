# Proposal — sources served by depth (v1)

Proposal only, 2026-11-04. The spec delta, design and tasks are to be generated from this once it is
accepted. The research behind it (the origin of the idea, seventeen implementations surveyed, what each
measures and what none does, the evaluation design and a step-by-step brief) lives in the maintainer's
notebook, not here; this file holds what has been decided.

## Why

The sources store already is the agent's context: an append-only, scrubbed raw archive per project; one
SQLite built from it deterministically; every row with its `raw_ref` and `permalink`; full-text search; and a
ladder of tools that goes snippet (`search`) → record (`get`) → transcript (`transcript`). What it cannot do
is answer at a coarser level than one record. An agent asked "what happened in support last week" or "what is
this thread about" has to search, open records one by one and hold them all in context — the cost is paid in
tokens on every question, and the rare decisive item is as likely to be dropped by the agent's own skimming as
found.

The idea borrowed is StrongDM's *Pyramid Summaries*: the same material at several sizes, an agent scans at the
smallest and expands only what it needs, through tool calls. The idea kept from our own store: every derived
text must lead back to raw, and raw is the only source of truth. Nothing in the surveyed systems does both over
mail, chat, tasks and calls with provenance; the ones that come closest (claude-mem's ladder with token cost,
Graphiti's "invalidated, not deleted", MemForest's refresh of dirty paths only) are borrowed as design, no code.

Two things this is **not**: an embedding index (the store has none, by decision) and a memory the agent writes
into. The agent's own experience is Dream's business and stays apart from the sources.

## What Changes

- **One new derived layer: summaries of groups of records.** Two kinds of key — a period × container (a week
  of a channel, a mailbox, a tracker project, a person) and a unit (a thread, a call, a task with its comments).
  Each summary has two lengths, a short one to scan (≈16 words) and a long one to decide on (≈120 words); not
  the 2/4/8/16-word pyramid, which is a display trick, not a reading need. Each carries `refs` — store refs,
  never free text — and the fingerprint of the raw lines those refs stood for when it was written.
- **Summaries are written by a routine into a ledger; the build indexes the ledger.** The store build stays
  deterministic, with no model and no network in it. A routine (the same mechanism as the nightly dream) writes
  one ledger line per key; `buildStore` reads the ledger into a `summaries` table with full-text search and
  computes `stale` by comparing the stored fingerprint with the current raw lines of the `refs`. A ref that no
  longer exists marks the summary stale. A ledger line whose refs are not in the store is rejected, not indexed.
- **Stale summaries stay readable and say so.** Nothing is deleted on a raw change; the row is flagged, the
  tools show the flag, and the routine re-summarises only stale and new keys. One level of refresh; no cascade.
- **The agent chooses the depth.** `search` gains `depth` — `index` (summary rows), `summary`, `record` — and a
  new tool `overview {since, until, container?, person?}` returns the period summaries for a window. Every
  summary row returned carries its `refs`, its `stale` flag and its token count, so the agent can see what a
  descent costs. No router decides for it; that is a later experiment, if the data asks for one.
- **The prompt says how to read it.** The sources paragraph of the system prompt tells the agent to start at
  `overview`, descend only for what it will cite, and cite `refs`, never a summary.
- **Dream stays apart; one rule crosses.** A dream entry that rests on source material lists the `ref`s it
  rests on (a prompt change), so a stale ref can be found from either side. Dream's storage does not change.
- **Behind a flag, off by default.** `SOURCES_DEPTH=1`. Off, every tool answers byte-for-byte as today and the
  routine does not run; a test pins it.

## Capabilities

### New Capabilities
- `sources-summaries`: the summary layer over the sources store — keys, two lengths, refs and fingerprint,
  the ledger-in / index-out rule, staleness, the routine that writes it and its budget.

### Modified Capabilities
- `sources-store` (or whichever spec names the MCP tools): `search.depth`, the `overview` tool, `refs` /
  `stale` / `tokens` on summary rows, the prompt paragraph.
- `memory` (Dream): entries derived from sources carry their refs.

## Impact

- **Rollout:** bucket 3, flag off by default; canary on the maintainer's personal installation, then one
  customer project. `docs/rollout.md` gets one row. The flag flips to default only if the evaluation below says
  so; otherwise the layer stays a scan aid and the flag is retired.
- **Evaluation, agreed before results are seen:** ~20 real cases from the canary installations, same sources,
  same model, the agent run with today's tools and with `overview` + `depth`. Counted: required evidence found;
  rare decisive items missed; unsupported conclusions; tokens and tool calls; human minutes. Two checks nobody
  in the survey runs: after a raw correction, how many summaries are marked stale versus silently wrong; and
  for a random sample of summaries, whether the `refs` support the text. Stop rule: evidence found drops or rare
  misses rise → the layer never becomes a source.
- **Code:** `src/sources/store.ts` (schema, ledger indexing, `stale`), `src/sources/mcp.ts` and the tools table
  (`depth`, `overview`, the prompt paragraph), `src/pollers.ts` (the routine kind), `src/dream.ts` (one prompt
  line), a lab runner in `src/lab/` for the evaluation. The cases and expected evidence live in the ops repos.
- **Not in this change:** embeddings; a graph; a depth router; a cascade of raw corrections through several
  layers; an agent-facing `remember`; any change to how Dream stores its memory; a separate service or
  database.
