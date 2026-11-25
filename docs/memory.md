# Project memory

How CoachAven gives the agent **per-project memory** that survives across threads —
so it stops re-learning "edits go to repo X, never Y" every conversation.

> **Status: verified on prod (`proj-caldora`, 2026-06-26).** Claude Code `2.1.183` is in
> the snapshot and native auto memory is already writing real, useful per-project notes
> with no configuration. v1 reads it straight out of the sandbox. Durability across
> sandbox rebuilds is explicitly **out of scope for v1**.

## Decision (TL;DR)

- Use **Claude Code's native auto memory** — we do **not** build our own memory file or
  set `autoMemoryDirectory`. The agent already writes memory by default; we just read it.
- Memory is **per project**, isolated — no cross-project sharing (mirrors a Claude Tag
  *private* channel, not the workspace-shared model).
- **v1 = volatile.** Memory lives only inside the project's warm sandbox. It survives
  between turns/sessions on a live sandbox, and is **lost on a sandbox rebuild** — exactly
  like the session transcript today (`contextLost`). Host-side persistence is deferred.
- Reading is exposed via `/aven memory` (the learned layer) and read-only `/aven prompt`
  (the deliberate layer); writing memory happens through normal conversation. Editing the
  prompt is deferred to [runtime config](runtime-config.md).
- The host mirrors memory after every turn and tidies it at night when its own check finds
  problems — the [company brain](#company-brain); sandboxes stay the source of truth.

## Background: the two Claude Code memory systems

Claude Code has two memory mechanisms, both loaded at the start of every session:

| | CLAUDE.md files | **Auto memory** |
| --- | --- | --- |
| Who writes it | you | **Claude itself** |
| Contains | rules, conventions | learnings, patterns, preferences |
| Location | repo `CLAUDE.md`, `.claude/rules/`, `~/.claude/CLAUDE.md` | `~/.claude/projects/<project>/memory/MEMORY.md` |
| Scope | project / user / org | per git repo (shared across worktrees) |

We use **auto memory** — the same `MEMORY.md` + topic-file system Claude Code uses
locally. Requires Claude Code **≥ 2.1.59**, on by default.

### Where memory sits in the prompt stack

CoachAven already layers project context (`buildSystemPrompt`, `src/prompt.ts`):

1. Orchestrator base (identity, repo layout, git flow — worktree/PR or direct commits — toolchain)
2. Project `systemPrompt` from the registry — *the deliberate layer, set by us*
3. Each repo's own `CLAUDE.md` — auto-loaded by Claude Code
4. **Auto memory** — *the learned layer, written by the agent*

Layer 2 is what we curate; layer 4 is what the agent accumulates. They are complementary:
deliberate vs learned.

## How it works in CoachAven

### Location

Auto memory lives at the Claude Code default path inside the sandbox:

```
/root/.claude/projects/<cwd-with-'/'→'-'>/memory/MEMORY.md   # index, loaded every session
/root/.claude/projects/<cwd-with-'/'→'-'>/memory/<topic>.md  # detail, loaded on demand
```

The `<cwd-...>` derivation is the **same** one we already use in
`sessionTranscriptValid` (`src/tasks.ts`) for the transcript path — so no new path logic
is needed.

- **Single-repo project:** `cwd` is the repo checkout → memory is keyed by that repo and
  shared across its task worktrees and all threads of the project.
- **Multi-repo project:** `cwd` is the project root (not a git repo) → memory is keyed by
  the project root.

Either way it resolves to **one memory store per project**, shared across that project's
threads — which is exactly the project-level memory we want.

### Writing memory (automatic + explicit)

- **Automatic:** Claude decides what's worth keeping (build commands, conventions,
  debugging insights) and writes it during a turn. No action needed.
- **Explicit:** anyone says, in a normal turn, e.g.
  *"запомни для проекта: правки идут только в `caldora-app`, не трогай website"* →
  it becomes a standing note.

Writing is **not** a separate Slack command — it rides on the existing turn machinery.

### Reading memory: `/aven memory`

A read-only command that surfaces what the agent remembers about the current project's
channel:

- `/aven memory` → dumps `MEMORY.md` (private/ephemeral reply).
- `/aven memory <topic>` → dumps a specific topic file.

Implementation: `exec` into the project's `proj-<slug>` sandbox and `cat` the file at the
derived path. No sandbox-waking persistence layer, no `autoMemoryDirectory`. Reading a
small markdown file while the live `claude` may be mid-write is a benign race (worst case:
a momentarily truncated read), acceptable for a read-only view.

### Reading the prompt: `/aven prompt` (read-only)

The symmetric inspect command for the **deliberate** layer: `/aven prompt` shows the
current project system prompt (the `systemPrompt` from the registry — what `buildSystemPrompt`
layers in). Read-only and private, it ships **with the memory phase** so both layers of the
agent's context are inspectable. Reads straight from the in-memory `registry`, no sandbox
needed. **Editing** the prompt from Slack is a separate feature — see
[runtime config](runtime-config.md).

### Loading

The first 200 lines (or 25 KB) of `MEMORY.md` are auto-loaded into every session; topic
files are read on demand by the agent. This is Claude Code behaviour, not ours.

## Prerequisites — verified

Checked on the live `proj-caldora` sandbox via a sandbox exec script (since removed) (2026-06-26):

1. **Claude Code version** — `2.1.183` (≥ 2.1.59 required). ✓
2. **Auto memory writes files in our headless mode** (`--dangerously-skip-permissions`,
   `stream-json`) — confirmed, with no `settings.json` (so it's on by default). ✓

Observed in `caldora` (cwd `/root/work/caldora` → `/root/.claude/projects/-root-work-caldora/memory/`):

```
MEMORY.md                          # index
project_caldora_overview.md        # repos, worktree workflow
project_caldora_admin_structure.md # routes, observability, log channels, testing
project_eguma_voucher_sync.md      # sync flow + 2026-06 incident, PR #17, follow-ups
```

Content is genuinely useful (architecture, an incident with its PR, remaining actions),
in the same `MEMORY.md`-index + frontmatter-topic-file format Claude Code uses locally.

Fallback (only if this ever stops working): a self-managed `memory/<slug>.md` injected as
prompt layer 2.5. Not needed today.

## v1 scope and limitations

- **Volatile.** Memory is only in the sandbox; a rebuild wipes it (same failure mode as
  the transcript). Acceptable for v1; surface it the way we surface `contextLost`.
- **No host-side persistence.** Deferred (see below).
- **No Slack editing of memory.** Writes are conversational only; `/aven memory` is read-only.
- **No cross-project sharing.** Each `proj-<slug>` sandbox is isolated, so memory is too —
  by construction.

## Memory journal (durability + history)

After every turn the bot mirrors the project's memory dir into a **per-project git repo** at
`./memory/<slug>/` (next to `state.json`: server-owned, gitignored, deploy-excluded): one exec lists a hash per
memory file, the files that differ from the host's copy are read back and committed (`turn <id>`). A turn that
changed nothing costs that one exec; a failure is logged and the answer stands. One repo per project → no
cross-project collision.

- **History / reconstruct:** each change is a commit, so `git log` reads as a changelog and any past state is
  recoverable by checkout. `/aven memory log` shows the history.
- **Restructurable:** the journal is plain git — compact, branch, or roll back a bad edit.
- **Durability:** on the rare rebuild (image swap, a lost sandbox host), `restoreMemoryIfEmpty`
  seeds a fresh sandbox from the journal HEAD — but only when the sandbox has no memory yet,
  so a warm sandbox (the newer source of truth) is never overwritten.
- **Offline reads:** `/aven memory` serves the journaled host copy without waking the
  sandbox; `/aven memory live` forces the sandbox's current state.

The sandbox stays the working source of truth; the journal is the durable, restructurable
log. Implemented in `src/memjournal.ts` (host git + sandbox file IO; pure helpers tested).

## Company brain

Part of every project, with no flag and no switch (OpenSpec `company-brain`). The host turns the agent's own
memory files into records a team can rely on, without a model on the host.

- **The record contract.** Every session's prompt has two paragraphs: a record carries a `kind`
  (`investigation`, `domain`, `method`, `decision`), an investigation a `status` and a `ticket`, and an answer
  that rests on a record nobody corrected says so. Claude Code documents no format for these files and rewrites
  their frontmatter — it moves a key it does not know under `metadata:` — so the host reads each key from the
  top level first and from `metadata` otherwise (the probe's `memory-keys-survive-edit`, `docs/cli-probe.md`).
- **The index.** `brain/<slug>/index.json` in the installation directory lists every record: its file, title,
  `kind`, `status` and `ticket` when its frontmatter carries them, when the host first saw it and when its
  content last changed. No record text.
- **The lint.** `brain/<slug>/lint.json` lists what code can find: a record without a kind, an investigation
  without a status or `open` for more than 30 days, several records for one ticket, a file `MEMORY.md` does not
  link and a link without a file, an e-mail address or an international phone number (the pattern and a count,
  never the text), and a repository's `CLAUDE.md` that changed since the last tidy.
- **The use log.** `brain/<slug>/uses.jsonl`: one line per turn that read or changed a record — the time, the
  conversation, what started the turn (a person, a routine, a poller, another agent) and the record names. No
  text. "Read" is a heuristic (a memory file named in a tool input); "changed" is the mirror's diff.
- **Provenance.** From the use log the index carries per record how many turns started by a person used it,
  when last, and when it was last *revised after a person's reply* — changed by a person's turn in a
  conversation that had already used it. Nobody marks anything and the agent cannot write it. It is evidence
  of attention, not verification: a record used fifty times and never revised is still unchecked.
- **The answer log.** `brain/<slug>/answers.jsonl`: for a turn that read or changed an `investigation` record,
  the question as the sandbox received it, the answer as posted, who asked, the records, their tickets and the
  thread link. Not written for a marked (cross-domain) or shadow conversation, nor for a direct message or a
  command's own conversation — the log is read by the whole project. The nightly tidy logs no answer.
- **`brain_history`.** A host tool on the session's own channel: for a ticket id or a record's file name it
  returns the record's provenance and the logged answers oldest first, each with how many turns followed in
  that conversation (from the usage log). The project is the caller's; another project's ticket finds nothing.

### The nightly tidy

The one upkeep pass. It replaces the dream (a scheduled consolidation turn people had to switch on, which swept
session transcripts every night): there is no command, no routine and no schedule to set.

- **What starts it.** During the 03:00 hour (`AVEN_TZ`) the host reads each project's `lint.json`. Nothing due →
  no turn, and a stopped sandbox stays stopped. Otherwise one turn gets at most 15 findings, oldest first, so
  an existing project's backlog drains over nights.
- **What it may do.** Memory only: the prompt forbids code, branches, pull requests and edits to any
  `CLAUDE.md`, and it does not read transcripts. It resolves the findings it was given and touches no other
  record.
- **When it stops.** A finding given to three tidies and still listed no longer starts one — a false positive
  of the personal-data pattern must not buy a turn every night. It stays in the lint. A record someone changes
  later is due again.
- **`CLAUDE.md`.** The mirror also notes a digest of each repository's `CLAUDE.md`. The first one is a
  baseline; a change is one finding, and the tidy that was given it brings contradicting records into
  agreement with the file.
- **What it leaves.** Nothing in chat. The journal commit (`turn tidy-<day>`), a log line and a usage record
  under the key `cron:tidy:<slug>` (`/aven usage`); the counts live in `brain/<slug>/tidy.json`.
- **No races.** A project with a live turn is left for the next minute of the hour; a failed tidy is not
  retried that night.

The index and the lint are derived: delete them and the next turn rebuilds them from the mirror and the use
log. The two logs are not: deleting `brain/<slug>/` forgets what was answered. Not there yet: the tracker
check and the `/aven memory open` / `unchecked` forms. Implemented in `src/brain/` (pure parts tested apart;
`night.ts` runs one project's tidy), `src/memjournal.ts`, `src/pollers.ts` and `src/hostrouter.ts`.

## Deferred / future

- **Editing the prompt from Slack** → [runtime config](runtime-config.md). The read-only
  `/aven prompt` ships here in the memory phase; the modal editor, `state.json` overrides,
  and `/aven prompt reset` live in that doc's phase.

## Command summary

| Command | Effect |
| --- | --- |
| *(normal turn)* "запомни для проекта: …" | write a standing memory note |
| `/aven memory` | read the project's `MEMORY.md` — journaled host copy, no sandbox wake (private) |
| `/aven memory <topic>` | read a specific memory topic file |
| `/aven memory live [topic]` | force-read the sandbox's current memory (wakes it if asleep) |
| `/aven memory log` | show the per-project memory snapshot history |
| `/aven prompt` | read the project's current system prompt (read-only; private) |
