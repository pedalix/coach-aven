# Design

## Context

The store already holds everything needed: `messages(ref, thread_id, ts, author_person, participants, container, is_bot)`, `threads(thread_id, first_ts, last_ts, n)`, `message_people(ref, person_id, role)`, `people(person_id, company)`, `tasks(status_category, updated, project, assignee_person)`. The MCP server is a dependency-free `.mjs` over `node:sqlite`, re-uploaded by sha at session prep. Zone handling for bare dates lives in `LOCAL_TZ` (the bot's `AVEN_TZ`). See proposal.md for motivation.

## Goals / Non-Goals

**Goals:**
- Two tools whose rows a routine can quote verbatim, with stable semantics documented in `docs/sources.md`.
- Same result for the same store: pure SQL plus a small JS pass for side membership; no model, no heuristics on text.

**Non-Goals:**
- Pattern/similarity detection across tickets (threshold parameter) — agent-side via fragments until Sentry is a source.
- Time-in-status; requires tracker transition history the pullers do not record yet.
- Host-side use of these readouts (the nothing-new skip reads counts, not these tools).

## Decisions

- **Side membership from the tenant people file, not from config.** `people.json` already carries `company`; the tenant's own companies are the ones in `initiatives.json` umbrellas marked internal (fallback: the account owner only). Alternative: a `sources.side` config list — rejected, it duplicates the people ledger and drifts.
- **Client container = tenant marker, not channel-name heuristics.** A container is a client container when the tenant's rules/initiatives route it to a client initiative (attributions table) or the people file marks its counterpart company external. Alternative: Slack Connect flag from the puller — kept as a later enrichment (`is_ext_shared`), not a dependency.
- **"Answered" = any later same-thread message by the side.** Simple, explainable, matches how Slack/mail threads read. Alternative: reaction-only acknowledgements — not stored; out of scope.
- **Compute in SQL with a window on `threads.last_ts`** to avoid scanning every thread: candidates are threads whose last message is not by the side and whose first inbound message is older than `hours`.
- **`stuck` reuses the `tasks` row shape** so `get` works on its refs unchanged.

## Risks / Trade-offs

- [Side membership wrong for a tenant with no people file] → default subject is the account owner; the tool says which subject it used in `meta`.
- [Large stores: `unanswered` over all containers is slow] → index `messages(thread_id, ts)` exists; cap `limit`; `container`/`since` filters documented as the fast path.
- [Agent keeps using `search` for the same question] → prompt paragraph names the tools; the twin fixture for the brief is updated when the home bot shows it working.

## Migration Plan

Ship the `.mjs` + test + docs in one PR (bucket 2). No schema change, no restart; the next session prep uploads the script. Rollback = revert the PR.
