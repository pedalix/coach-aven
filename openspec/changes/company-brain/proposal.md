## Why

The agent already keeps a brain of its own: on the production installation one project's auto memory held 103
records in November 2026 — 64 ticket investigations, 20 domain notes, 10 counting methods — and the agent read it in
170 of 287 turns. Nobody curates it. A read of all 103 records found:

- 99 cite evidence and 102 carry a date, so the raw material is good;
- only 2 of 64 investigations say what was actually answered, and none says whether there was a follow-up;
- there is no status field: one record opens with "live, unfixed" and says "fixed in production" far below;
- records contradict each other (a cancellation window stated two ways), and stale sentences are never retired;
- a counting method that overstated a figure by 17 % sits beside correct ones and looks the same;
- 6 records carry a guest's surname, against the memory's own rule.

A support person asked for the same question to get the same figure as the admin report, and could not tell a
checked answer from a guess. The memory is where that difference has to live.

Consumer: the production installation's support team (two people, non-developers), on the project measured above.
The home bot canaries it on its own project first.

## What Changes

All of it behind `BRAIN=1`; with the flag unset nothing below exists.

- **A record contract.** A memory record names its `kind` (`investigation`, `domain`, `method`, `decision`) and,
  for an investigation, its `ticket` and `status`. The agent is told the contract in the system prompt; the files
  stay Claude Code's own auto memory, in the sandbox, where they are today.
- **A host-side mirror, fresh after every turn.** Today the host copies memory only after a dream. With the flag
  the bot mirrors changed records at the end of a turn and keeps a deterministic index and lint report beside
  them (no model on the host).
- **An answer log.** For a turn that read or wrote an investigation record, the bot logs what was answered, where
  and to whom — from the turn it already ran, not from what the agent chose to write down. A host tool
  (`brain_history`) gives the agent a ticket's earlier answers and what followed in those threads.
- **Provenance the host derives.** Nobody is asked to mark anything: people will not. The bot keeps a use log
  (which turn read or changed which record, no text) and derives per record how many answers used it, when last,
  and whether it was revised after a person replied in the same conversation. The agent reads this through the
  host tool and is told to say when a figure or a rule rests on a record no person has corrected. Silence is
  never counted as a check.
- **A dream that tidies from the lint.** The nightly dream gets the lint report: records without a kind or status,
  investigations open for too long or open while the tracker has resolved the ticket, records about the same
  ticket, personal data patterns. It reconciles, retires and redacts; it still never touches code.
- **Reading it as a person.** `/aven memory open` and `/aven memory unchecked` list from the host index without
  waking the sandbox; the Home lists name them.

## Capabilities

### New Capabilities

- `company-brain`: typed memory records with status and host-derived provenance, the host-side mirror, index and lint,
  the answer log with its host tool, and the dream's tidy pass.

### Modified Capabilities

None. Project memory has no spec of record yet (`docs/memory.md` describes it); this change adds one capability
and leaves `host-tools` and `routine-delivery` as they are.

## Impact

- **Rollout bucket 3**: flag `BRAIN=1`, off by default, canaried on the home bot. With it unset the prompt
  goldens, the recorded turns, the Home text and the dream prompt are byte-identical (tests pin each).
- **Out of scope**
  - Sharing records between projects. Memory stays per project, as `docs/memory.md` promises; a tenant-wide
    search is a follow-up change once one project's records are worth sharing.
  - A store of our own, embeddings or a vector index. The files stay Claude Code's.
  - "Why did this logic change" and "state of the project" as stored records: both are derived on demand from
    git and the tracker.
  - A *Confirm* control or any other marking a person must do. It was in the first draft and was dropped on
    2026-11-23: nobody presses such a button. It can return if the canary shows someone wants it.
  - Checking a `method` record against a reference report. That is the real verification of a counting method
    and a change of its own.
  - A web page for browsing records.
  - Cleaning the production project's existing records — an operator's task in that installation's ops repo.
- **Code**: a new `src/brain/` (record parsing, index, lint, answer log — pure, tested), `src/memjournal.ts`
  (mirror at turn end), `src/turn.ts` (the hook), `src/prompt.ts` and `src/dream.ts` (flagged
  text), `src/hostrouter.ts` (one more host tool), `src/chat/core/` (the two list forms), the three
  Home lists, `docs/memory.md`, `docs/rollout.md`.
- **Data**: `brain/<slug>/` beside `memory/<slug>/` in the installation directory — index, lint, the use log
  (record names only), the answer log
  (answer text as posted, already past the scrubber's inbound side; see design D6 for what that does not cover).
