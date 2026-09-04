# Project facts — `facts/<slug>.json`

Structured, **derived** state about a project that deterministic code writes and other
deterministic code reads. It is the first sliver of the "world state" from
`ideas/aven-distributed-cognition-assessment.md`: not a message bus, not a blackboard
with confidence scores — a file of facts with provenance, one writer, a few readers, no
LLM anywhere in the loop.

Everything else on disk is either orchestration bookkeeping (`state.json`,
`queue.jsonl`) or free text only Claude reads (`memory/<slug>`). A fact is different: it
is machine-produced, machine-consumed, and re-derivable from the environment, so it
lives beside `drafts/` and `memory/` in its own gitignored per-project file and is never
in `state.json`.

## Shape

```json
[
  {
    "subject": "project:caldora",
    "predicate": "depends_on_repos",
    "value": ["BluefinOrg/bill-php-sdk", "BluefinOrg/laravel-apaleo", "ace18/filament-flatpickr"],
    "sources": ["caldora-admin@c542d94b:composer.json"],
    "observedAt": "2026-09-04T06:40:41.237Z"
  }
]
```

- One record per `(subject, predicate)`; a fresh observation **replaces** the old one.
- `sources` is mandatory provenance (which manifest, at which commit). Pre-cooked state
  must stay traceable to its evidence — that is what keeps the transparency ask
  satisfiable once more of the world arrives pre-interpreted.
- No `confidence`, no `salience`, no subscriptions. Facts and events only; the store
  earns a second predicate when a second writer shows up.
- A missing or corrupt file reads as "no facts": the store is a derived cache and a reader
  degrades to "unknown", never crashes a turn.

## The one fact today: `depends_on_repos`

**Writer** — the dependency scanner (`src/deps.ts`), run by `prepareChat` right after the
repos are cloned/fetched. A single grep inside the sandbox over each checkout's
`composer.json` (only that file: composer requires every VCS source, transitive ones
included, to be declared in the root `repositories` block, whereas `composer.lock` names
the GitHub source of every public packagist package too). URLs in every shape composer
uses (`https://github.com/O/r.git`, `git@github.com:O/r.git`, `api.github.com/repos/O/r`)
are normalized to `Owner/name`.

**Readers**

1. **The GitHub token mint** (`tasks.ts` → `getGitHubToken`): the per-turn installation
   token is scoped to the project's repos **plus** the dependency repos under the same
   owner. Foreign-org deps (a public fork) stay in the fact but never enter the mint — one
   installation token can only name repos of its own installation, and GitHub rejects the
   whole mint otherwise.
2. **The composer auth seeder** (`project.ts` → `seedComposerAuth`): the same token is
   mirrored into `<checkout>/auth.json` (composer's credential file, `http-basic` +
   `x-access-token`) in every checkout that has a `composer.json`, every turn, because
   composer runs inside Sail / the bootstrap container where the sandbox's git credential
   helper does not exist. Existing worktree copies are refreshed; a checkout without
   `composer.json` gets none.
3. **The system prompt**: the reachable private package repos are listed so the agent
   knows composer and `git clone` already work for them.

This replaced the per-project `composerAuth` config field (a hand-made PAT that expired
and had to be maintained by a human). Nothing on the GitHub side needs configuring as
long as the App installation covers the package repos (it is installed org-wide).

## Bootstrap order

On the first session the fact does not exist yet: mint with the project's repos → clone →
scan → if the scope changed, re-mint → seed `auth.json`. From then on the fact is on file
and each turn is a single mint with the full scope.
