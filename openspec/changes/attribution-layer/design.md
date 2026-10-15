# Design

## Context

owen-ops (`src/review/{fragment,substance,ladder,admin,plan,load}.ts`, `src/registry.ts`) plans a review window by reading the store file; the session then records rule decisions with `review --write`, decides the rest with `review decide` / `review escalate`, and the timelog sums minutes from `annotations/fragments.jsonl`. The bot's store build already reads the tenant checkout (`people.json`, `fragments.jsonl`), indexes recorded decisions into `fragments` / `attributions`, and recomputes everything derived from tenant files when their fingerprint changes (`recomputeDerived`, `derived_fingerprint`).

## Goals / Non-Goals

**Goals:**
- Same decisions as the owen-ops CLI for the same window, ids and all — a parity run proves it.
- Tenant-independent code; everything tenant-specific is data.
- Cheap enough to recompute on every build.

**Non-Goals:**
- Deciding where rule decisions are persisted (follow-up); the timelog; identities; commitments; an item mode; any model step.

## Decisions

- **Port, not reinvent.** Same algorithms and constants: 45-minute thread gap, the EN/RU/DE substance phrases and 12-letter threshold, topic split on H1/H2 minus structural headings, the ladder order, proposal purity 0.9 with three fragments and at most one competitor. Same ids (`frag-<UTC day>-call-<source>-<fnv>`, `…-thread-<fnv(container|first ref)>`, `…-work-<fnv(ref@start)>`), so ledger records attach. Days are local in the tenant's time zone for windows, UTC in ids — exactly as the CLI does.
- **Subject from config.** `attribution.json.subject` is a person id; the subject's messages are `author_person = subject`. The build resolves people with the current tenant file, so the CLI's re-resolution from raw authors is not needed. Participants of a run are everyone seen in its container within a day around the window plus the names encoded in DM/chat container ids, as in the CLI.
- **Registry without the legacy people map.** `initiatives.json` routing (repos, local paths, calendar title patterns, Slack/Teams channels, Jira keys, YouTrack prefixes, aliases and splits) is ported; person routing comes only from people markers (the CLI's ladder already ignores the legacy map). Owner mailboxes are not hard-coded.
- **Admin bucket as data.** The keyword set is a platform default; which initiative is an umbrella's admin bucket is `attribution.json.admin`. A tenant without the map gets no admin rung.
- **Ledger precedence.** A fragment with a live record in `fragments.jsonl` takes that decision whatever decided it; the ladder decides only fragments the ledger does not have (`state: rule`) or leaves them `open` with candidates and a hint. Rule decisions follow the current rules until the follow-up decides how they are kept; the CLI keeps recording them meanwhile, so nothing downstream changes.
- **Recompute per build.** The layer is recomputed for the horizon (`since` to today) whenever the build consumed new lines or the tenant fingerprint changed (now also over `rules.json`, `initiatives.json`, `attribution.json`): a few thousand messages and a few hundred calls and work blocks per tenant, milliseconds.
- **Tool = SELECT.** `attribution` filters the derived tables by window and state; the `.mjs` holds no attribution logic, so the stdio, HTTP and channel faces answer alike.

## Risks / Trade-offs

- [Parity drift between the port and the CLI] → ported tests, plus a parity run over the home store: the tool's decided/open sets against `owen-ops review --since D --until D` (no `--write`) for three past days.
- [Heuristics are language-bound (EN/RU/DE)] → they stay a platform default; a tenant can switch the substance filter off.
- [Schema v7 rebuilds every store from raw once] → minutes on the home bot; no prod store exists.

## Migration Plan

Bucket 2. Merge; the home bot's next build rebuilds the stores and fills the tables for owen-ops once `annotations/attribution.json` is committed in its repo; parity run; ledger row. The owen-ops switch and the persistence decision follow as their own changes.

## Open Questions

- Pinned by the platform or recorded in the tenant ledger: where rule decisions live once the CLI no longer records them (Owen).
