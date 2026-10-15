# Design

## Context

#176–#181 moved attribution and the timelog into the store build and the sources table; the owen-ops review records judgments by fragment id. Two steps still read the store file through the tenant's loader (`src/review/load.ts`): the identity collector (`identities --write`: observations → `collect` → merges into people.json + questions) and the commitment extractor (`commitments extract`: calls with every recorder copy's `next_steps` → proposed ledger rows). Both are deterministic and already generic in substance; only the subject's own names were hard-coded in the extractor.

## Goals / Non-Goals

**Goals:** both steps without any store file in the sandbox; the same ids as the tenant code, so nothing already asked or recorded comes back; the subject's names from the people file, not from code.

**Non-Goals:** writing the tenant's files (people.json, escalations, the commitments ledger stay tenant-written, through its CLI); staleness and chase (pure ledger arithmetic, tenant-side); an LLM anywhere.

## Decisions

- **Computed in the store build, served as stored rows.** Next to the attribution plan (same trigger: store, tenant files or the hour moved): `att:identities` (one JSON value in `sync_state`: merges, questions, counts) and the table `att_commitments` (one row per proposed step of a call in the horizon). The `.mjs` only filters and returns them; no matching logic in two languages.
- **Observations** = the tenant collector's: message authors (not bots) per container/thread with "talked with the subject" (the subject wrote in the thread, or a direct chat the subject wrote in), event attendees and organizers, meeting attendees (crowds of more than 20 are never "with the subject"), task assignees and reporters.
- **Matching** = the tenant's `normalise`/`match`/`collect`, ported: certain (same full name, a mailbox that is the name or the glued name) → merge; a unique first name → merge only when seen together or under the person's domain/company; otherwise a yes/no with the guesses once the identity talked with the subject (≥ 2 times or in a direct chat); an unknown only at ≥ 5 times with the subject. System senders (no-reply, bots, known SaaS senders) and opaque ids are counted, never asked. The readout returns all questions most-seen first (capped at 50); the tenant asks at most 15 new ones a run and dedupes by id against its own escalations.
- **Commitments** = the tenant's `parseNextSteps` + `extractCommitments`, ported; the owner is the subject when it equals (normalised) the subject's full or first name, one of their identities, or "me"; `to` is the single other attendee when the subject owns the step. Ids `c-<hash(call_id|normalised text)>` with the platform's fragment hash (the same function as the tenant's). The tenant's migration guard (calls mined by hand) stays tenant-side.

## Risks / Trade-offs

- [The subject writes under a name the people file does not list] → their steps get `owner` = that name's slug instead of the subject, visible in the readout; the fix is a people-file identity, not code.
- [Readout size through a command line] → questions are capped, a day's commitments are a handful; both are copied as-is into one CLI call.

## Migration Plan

Bucket 2 (tenants with attribution.json only). Merge; the home bot computes both on its next build; compare with the tenant's `identities` (dry run) and `commitments extract` (dry run) on the same day; switch the owen-ops prompt and CLI; delete its loader; recreate `proj-owen-ops` without the mount.
