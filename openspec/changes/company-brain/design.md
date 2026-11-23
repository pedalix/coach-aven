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

- A person can tell a record somebody corrected from an agent's own note, and so can the agent — without
  anyone being asked to mark anything.
- "What did we answer on this ticket, and did anything follow" is answered from a log the host wrote.
- Stale and contradicting records are found by code and resolved by the dream.
- Flag off is byte-identical.

**Non-Goals:**

- A second memory store, a schema beyond four kinds, embeddings.
- Cross-project or tenant-wide reading.
- Proving a record true. Provenance says how a record was used and whether a person ever corrected it; it is
  not verification, and silence is never read as agreement.

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
`uses.jsonl`).

- Why the end of the turn: it is the moment the bot reads the sandbox anyway, and provenance needs the set of
  records each turn changed.
- Why git: versions come for free, and a rebuilt sandbox is re-seeded from it already.
- Cost: one exec per turn; reads only for changed files. A failure never blocks the answer.

### D3. Which records a turn read

Read: a record's file name appearing in a tool input of the turn's stream (a `Read` path, a shell command).
Changed: the mirror's diff. Reads are a heuristic: they decide whether to log an answer (D4) and feed the use
count (D5). Changed is exact and is what "revised after a reply" rests on.

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

### D5. Provenance is derived, nobody marks anything

The first draft had a *Confirm* control on the answer. It was dropped on 2026-11-23 on the maintainer's word:
people do not press such a button, and a trust signal that depends on it would stay empty.

`uses.jsonl` gets one entry per turn that read or changed a record: time, conversation key, turn id, what started
the turn (a person, a routine, a poller), the names read and the names changed. No text. From it and the mirror
the index carries per record:

- `uses` and `lastUsed`: turns started by a person that read or changed it;
- `revisedAfterReply`: the last time a turn started by a person's message changed the record in a conversation
  where an earlier turn had already read or changed it. This is what a correction looks like from the host: the
  agent answered from the record, a person replied, the record changed.

- Why this and not a mark: it costs people nothing and the agent cannot write it — the host reads the stream and
  the mirror, never the record's own claims.
- What it is not: a person may reply "thanks" and the agent may edit the record for its own reasons, so
  "revised after a reply" is evidence of attention, not proof. And a record used fifty times without a reply is
  still unchecked: a wrong figure was accepted in production for weeks until someone compared it with a report.
  The use count is shown as context ("most used, never corrected" is the list worth a person's hour).
- The bot writes nothing into the sandbox's memory. The agent gets provenance from `brain_history` (D4), and the
  prompt asks it to look before it states a figure or a rule from a `method` or `domain` record.
- Rejected: reusing 👍 *Helped*. An answer can help and still be wrong, and the feedback metric must not change
  meaning.
- Rejected for this change: checking a `method` against a reference report. It is the real verification and
  needs a source of truth per method.

### D6. Lint is code; tidying is the dream's

`src/brain/lint.ts` is pure. Its findings: no kind; investigation without status; `open` longer than 30 days;
several records with one ticket; index and files out of step; a personal-data pattern (an e-mail address, a phone
number in international form — `src/scrub.ts` detects secrets, not these, so the two patterns live with the index); `open` while the tracker has resolved the ticket.

- The tracker finding is the one input from outside the mirror. It is gathered once a night, before the dream,
  for a project whose tracker the host already reads (`src/youtrack.ts` returns `resolved`), and handed to the
  pure lint as data. The host does not edit the status; the dream does. A turn's own lint makes no network call.

- What code cannot find: a contradiction between two records, a surname. The lint narrows the dream's attention
  (same ticket, same title words); the dream's prompt names contradictions and names of people as things to
  resolve in the records it opens.
- The dream prompt gains one flagged section with the lint text, capped at 15 findings, oldest first, so the
  backlog of an existing project drains over nights instead of in one expensive run.
- The answer log holds answer text as posted. Answers are not scrubbed today (`docs/security.md`), so the log can
  hold what an answer held. It lives in the installation directory beside `usage/` and `feedback/` with the same
  retention ("until you delete them"); `docs/security.md` gets the row.

### D7. Surfaces

- No new control on an answer; the three chat drivers render nothing new.
- `memory open` and `memory unchecked` are viewer forms of the existing verb, answered from `index.json`.
  `unchecked` lists `method` and `domain` records never revised after a reply, most used first.
- The Home lists of the three surfaces name the two forms.

### D8. Prompt text

Two flagged paragraphs in the base layer (`src/prompt.ts`): the record contract, and "say when an answer rests on
a record nobody corrected" (ask `brain_history`; name the record as your own note in the first lines). Goldens for
both flag states.

## Risks / Trade-offs

- [The agent ignores the contract and keeps writing untyped records] → the lint counts them and the dream
  migrates up to 15 a night; the canary metric is the share of typed records after two weeks.
- [Almost every record stays "unchecked" and the agent's caveat becomes noise] → the prompt asks for it only on
  figures and rules from `method` and `domain` records, in one line; the canary reads real answers for it.
- ["Revised after a reply" fires on an edit the reply did not ask for] → it is worded as attention, never as
  "verified"; the canary counts how many such marks were real corrections.
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

- Does anyone want an explicit way to say "this record is right" once the lists exist? If so, as a text form.
- What is the reference for a `method` record, and can the host compare against it?
