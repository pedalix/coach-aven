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
- A scheduled [**Dreaming**](#dreaming) pass keeps memory sharp and writes a host-side
  backup copy into `state.json` (disaster recovery only — sandboxes are the source of truth).

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

CoachAven already layers project context (`buildSystemPrompt`, `src/tasks.ts`):

1. Orchestrator base (identity, repo layout, worktree/PR rules)
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

Checked on the live `proj-caldora` sandbox via `scripts/peek-sandbox.ts` (2026-06-26):

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

## Dreaming

A scheduled, low-priority, **memory-only** reflection turn per project — the natural
marriage of the existing scheduler (`src/schedule.ts`) with project memory. A "dream" does
**not** touch code; it tidies and consolidates what the agent has learned.

### Mental model (source of truth = the sandbox)

Our sandboxes are warm and `autoDeleteInterval: -1` — they survive normal stop/start, so
**the live in-sandbox auto memory is the working source of truth and is effectively
durable** in day-to-day operation. A from-scratch rebuild (swapping the snapshot image, a
Daytona-side loss, a critical bug) is the **rare exception**, not a routine event.

So dreaming is framed around *quality*, with persistence as a secondary safety net:

- **Source of truth:** the native auto memory inside `proj-<slug>`. It lives there and
  survives stop/start.
- **Primary goal — memory quality.** Consolidate and prune in place: drop obsolete entries
  (dead repos/conventions), merge duplicates, synthesize durable learnings from recent
  sessions, and keep `MEMORY.md` a sharp index **within the 200-line / 25 KB load budget**
  (only that prefix is loaded into every session).
- **Side effect — a host-side duplicate.** Each dream writes a copy of the consolidated
  memory into **`state.json`** (server-owned, survives `export`/`import`). Not
  `projects.config.json` — that's deploy-managed and would be clobbered by `prod:export`.
- **The duplicate is a disaster-recovery backup**, restored (re-seeded into a fresh
  sandbox) **only on the rare rebuild**. No per-turn or per-rebuild snapshotting in the hot
  path.
- **Bonus:** the host copy is readable **without waking the sandbox** (offline inspection,
  versioning) — `/aven memory` could serve the last consolidated copy from `state.json` and
  reserve a live `exec` read for "show me right now".

### Guardrails

- **Memory-only.** A dream must never `git push` or open a PR — hard rule, enforced in its
  prompt and ideally a guardrail. It reads recent work + memory and rewrites memory, nothing
  else.
- **Cost gating.** Only dream projects with **activity since the last dream**; run at low
  frequency (e.g. nightly), and let the sandbox auto-stop again afterward.
- **No races.** A dream is its own session/process on the project sandbox. **Skip if a turn
  is in flight** for that project (visible via `queues`) so it doesn't fight a live user
  turn over the memory files; prefer low-traffic hours.
- **Conservative curation.** Additive/consolidating, not aggressive deletion; keep a
  pre-dream copy (the `state.json` backup doubles as this) so a bad dream is recoverable.
  Memory is read by humans via `/aven memory`, so drift is catchable.

### Shape (v1, implemented)

A new **routine kind** (`kind: 'dream'`) on the existing routines mechanism — not a second
scheduler. Managed with `/aven dream [on|off|now]` (bare = status); enabling creates one
nightly dream routine per project channel (default `0 3 * * *`, in `AVEN_TZ`). The scheduler
fires it like any routine; `fireRoutine` dispatches dreams to `fireDream`, which:

- runs **silently** via the no-UI turn runner (`runAsk` + `DREAM_FRAMING`) — no channel post;
- **skips if the project has a live turn** (`projectBusy`), to avoid racing a user on memory;
- **logs a one-line digest** (`dreamDigest`) to the journal and stores it on the routine
  (`lastSummary`), surfaced by `/aven dream` and `/aven routines` — visibility without noise.

### Decided / deferred within Dreaming

- **Silent + logged digest** (chosen): curate quietly, log a one-line digest; no channel spam.
- **Activity gate** (deferred): v1 dreams on schedule whenever enabled and the project isn't
  busy; "only if there was activity since the last dream" needs a per-project last-activity
  signal and is left for later.

## Deferred / future

- **Durability across rebuilds.** Reframed: because sandboxes are warm and never
  auto-deleted, in-sandbox memory is durable for normal operation, so we do **not** do
  per-turn host snapshotting. Persistence rides on [Dreaming](#dreaming) instead — the
  periodic dream writes a consolidated copy into `state.json`, which we re-seed into a fresh
  sandbox only on the rare rebuild (image swap, Daytona loss). Avoids the bug-prone
  hot-path backup (snapshot timing, races with the live writer, restore ordering).
- **Editing the prompt from Slack** → [runtime config](runtime-config.md). The read-only
  `/aven prompt` ships here in the memory phase; the modal editor, `state.json` overrides,
  and `/aven prompt reset` live in that doc's phase.

## Command summary

| Command | Effect |
| --- | --- |
| *(normal turn)* "запомни для проекта: …" | write a standing memory note |
| `/aven memory` | read the project's `MEMORY.md` (private) |
| `/aven memory <topic>` | read a specific memory topic file |
| `/aven prompt` | read the project's current system prompt (read-only; private) |
