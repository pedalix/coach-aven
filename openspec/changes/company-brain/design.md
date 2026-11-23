## Context

Project memory is Claude Code's own auto memory inside the sandbox (`docs/memory.md`): `MEMORY.md` plus topic
files with frontmatter, written and read by the agent. The host touches it in three places: `/aven memory` reads a
file through an exec, a dream consolidates it, and after each dream `src/memjournal.ts` commits a snapshot to
`memory/<slug>/` (a git repository) so a rebuilt sandbox can be re-seeded.

Constraints that shape this design:

- The host runs deterministic code only; a model runs in a sandbox.
- No mounts and no listener in the sandbox: the host reads a sandbox by exec at moments it already owns (the end
  of a turn, as the outbox does) and the agent reaches the host through host tools on the session's own channel.
- One sandbox serves every conversation of a project, so nothing here is per conversation inside the sandbox.
- A dream was the production installation's largest cost line in October 2026; anything added to it is capped.

What the measurement in the proposal showed is that the agent already writes the records; what is missing is a
status, a trace of what was answered, a way to tell checked from unchecked, and upkeep.

## Goals / Non-Goals

**Goals:**

- A person can tell a confirmed record from an agent's own note, and so can the agent.
- "What did we answer on this ticket, and did anything follow" is answered from a log the host wrote.
- Stale and contradicting records are found by code and resolved by the dream.
- Flag off is byte-identical.

**Non-Goals:**

- A second memory store, a schema beyond four kinds, embeddings.
- Cross-project or tenant-wide reading.
- Proving a record true. Confirmation records that a person vouched for a version; it is not verification.

## Decisions

### D1. The records stay Claude Code's files

The contract is frontmatter keys (`kind`, `status`, `ticket`) taught in the system prompt. No `autoMemoryDirectory`,
no store of ours.

- Why: the agent reads these files in 59 % of turns today without being told to; a store it must be taught to
  query would be read less. Claude Code loads `MEMORY.md` itself.
- Rejected: a host-side database with a query tool as the source of truth. It doubles the truth (the agent still
  writes its files) and needs a migration of every existing record before it is useful.

### D2. The mirror is the existing journal, fed after every turn

`memory/<slug>/` stays the copy; with the flag the bot also updates it when a turn ends: one exec lists
`sha256sum` of the memory files, changed files are read back the way the outbox reads files, and the change is
committed. Derived files live apart in `brain/<slug>/` (`index.json`, `lint.json`, `answers.jsonl`,
`confirmations.jsonl`).

- Why the end of the turn: it is the moment the bot reads the sandbox anyway, and the confirm control needs the
  set of records the turn changed.
- Why git: versions come for free, and "confirmed at this version" needs one.
- Cost: one exec per turn; reads only for changed files. A failure never blocks the answer.

### D3. Which records a turn read

Read: a record's file name appearing in a tool input of the turn's stream (a `Read` path, a shell command).
Changed: the mirror's diff. Reads are a heuristic and used only to decide whether to log an answer (D4); changed
is exact and is what *Confirm* acts on.

### D4. The answer log is written by the host

`answers.jsonl` gets an entry when a turn read or changed an `investigation` record: time, conversation key,
asker id, the message as the sandbox received it (already scrubbed), the answer as posted, record names, tickets,
the thread link when the driver has one.

- Why not ask the agent to write "what we answered" into the record: 2 of 64 investigations did. The host has the
  answer text of every turn; logging it is a few lines and cannot be forgotten.
- `brain_history` is a host tool beside the messaging tools (`src/hostrouter.ts`): the caller is the session, so
  the project comes from the channel, never from an argument. "What followed" is the count of later logged turns
  in the same conversation and the date of the last one — the bot does not keep people's thread messages.
- Marked and shadow conversations are not logged: their text belongs to another domain.

### D5. Confirmation is a host ledger with a mark the bot writes

`confirmations.jsonl` holds `{record, contentHash, by, at, turnId}`. After a confirmation the bot writes a
`confirmed: <date>` line into the record's frontmatter (no name — no personal data in memory). At every mirror the
bot recomputes the hash of the record without that line and without `modified`; a mark with no matching ledger
entry is removed.

- Why a mark in the file: the agent must see it without a tool call, and `/aven memory <topic>` shows it to people.
- Why the ledger is the truth: the agent can write any frontmatter; a mark it invents does not survive a mirror.
- Why only the records the turn changed: a person confirms what they just read in the answer. Extending the mark
  to every record the answer merely read would confirm things they never saw.
- Who may confirm: anyone who may drive the agent in that workspace (the actor gate), decided by the maintainer on
  2026-11-23. A named list per project was rejected as a config key nobody asked for; a workspace that needs a
  narrower circle already has the allowlist.
- Rejected: reusing 👍 *Helped*. An answer can help and still be wrong, and the feedback metric must not change
  meaning.

### D6. Lint is code; tidying is the dream's

`src/brain/lint.ts` is pure. Its findings: no kind; investigation without status; `open` longer than 30 days;
several records with one ticket; index and files out of step; a personal-data pattern (the e-mail and phone
detectors of `src/scrub.ts`); changed since confirmation.

- What code cannot find: a contradiction between two records, a surname. The lint narrows the dream's attention
  (same ticket, same title words); the dream's prompt names contradictions and names of people as things to
  resolve in the records it opens.
- The dream prompt gains one flagged section with the lint text, capped at 15 findings, oldest first, so the
  backlog of an existing project drains over nights instead of in one expensive run.
- The answer log holds answer text as posted. Answers are not scrubbed today (`docs/security.md`), so the log can
  hold what an answer held. It lives in the installation directory beside `usage/` and `feedback/` with the same
  retention ("until you delete them"); `docs/security.md` gets the row.

### D7. Surfaces

- The control is one more answer control in the view model (`src/chat/views.ts`), rendered by each driver that
  declares it; a driver without it shows nothing and people use `/aven memory confirm <record>` — not in this
  change unless a canary driver needs it.
- `memory open` and `memory unconfirmed` are viewer forms of the existing verb, answered from `index.json`.
- The Home lists of the three surfaces name the control and the two forms.

### D8. Prompt text

Two flagged paragraphs in the base layer (`src/prompt.ts`): the record contract, and "say when an answer rests on
an unconfirmed record". Goldens for both flag states.

## Risks / Trade-offs

- [The agent ignores the contract and keeps writing untyped records] → the lint counts them and the dream
  migrates up to 15 a night; the canary metric is the share of typed records after two weeks.
- [People confirm without reading] → the control appears only when the turn changed records, the mark is dated
  and versioned, and a changed record loses it. Confirmation is a signal, not a guarantee; the prompt says
  "confirmed by a person", never "verified".
- [The mirror adds latency to every turn] → it runs after the answer is posted, and a turn that changed nothing
  costs one exec.
- [The dream gets more expensive] → 15 findings a night; the dream's cost per run is already in `/aven usage`
  per routine, and the canary watches it.
- [The answer log is a new copy of customer-facing text] → one directory, named in `docs/security.md`, never
  sent anywhere; deleting `brain/<slug>/` forgets it.
- [The "read" heuristic misses a record read by an unusual command] → the log misses an entry; nothing else
  depends on it.

## Migration Plan

1. Merge with the flag off (byte-identical).
2. Home bot: flag on for its own project; watch the share of typed records, the lint count, the dream's cost.
3. Production: flag on as its own step, after the operator has removed personal data from the existing records
   by hand (the dream would do it over weeks; a person does it in an hour).
4. Rollback: unset the flag. Records keep their extra frontmatter keys, which nothing reads; `brain/<slug>/` can
   be deleted.

## Open Questions

- Should a confirmation expire with age (a domain record confirmed a year ago)?
- Does the canary need `/aven memory confirm <record>` for a surface without the control?
