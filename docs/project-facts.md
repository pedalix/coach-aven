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

## The first fact: `depends_on_repos`

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

## The second fact: `project_skills`

**Writer** — the skills scanner (`src/skills.ts`, OpenSpec `agent-skills`), run by `prepareChat`
right after the dependency scanner, only for a project whose agent card offers skills
(`messaging.skills` set). Inside the sandbox it prints the frontmatter of every
`.claude/skills/<folder>/SKILL.md` where the session loads skills: its working directory, and for
a multi-repo project each repo passed with `--add-dir` (`REPO_SKILLS`, `docs/runtime-config.md`).

```json
{
  "subject": "project:brand-studio",
  "predicate": "project_skills",
  "value": [
    { "name": "brand-profile", "description": "Builds a brand profile from a hotel's website.", "origin": "brand-studio", "tags": ["brand"], "examples": ["Build the brand profile for https://hotel-alpenblick.example"] }
  ],
  "sources": ["brand-studio@1a2b3c4:.claude/skills/brand-profile/SKILL.md"],
  "observedAt": "2026-10-19T08:12:03.000Z"
}
```

- `origin` is the repo's short name, or `project` for the project folder of a multi-repo project.
- A name found in two places is kept once with `clash: [<every origin>]` and is never offered
  until renamed.
- A malformed key is logged and dropped; a failed scan keeps the previous fact.

- The id is the skill's folder name (the CLI resolves `/name` by folder); `userInvocable: false`
  records a skill marked `user-invocable: false`, never offered.
- The scan's markers carry a fresh nonce, so frontmatter or folder names cannot forge a record; a
  folder whose name is not a skill name is skipped without being named; lines are cut at 1000
  characters and 120 per file; a failed command keeps the previous fact.

**Reader** — the agent card (`src/messaging/skills.ts` → `exposedSkills`): the project's
`messaging.skills` over this fact decides which skills the card offers and which a task may name.

## Beside it: `session_commands`

**Writer** — every session of a project that offers skills reports, in its `system/init`, the names
of its slash commands and skills; `tasks.ts` records them (`skills.ts` → `recordSessionCommands`),
sorted, rewriting the fact only when they change. **Reader** — the agent card: a project skill whose
name one of these takes (minus the project's own skills), or one of the CLI's built-ins, is withheld,
because `/name` would run the command instead.

## Bootstrap order

On the first session the fact does not exist yet: mint with the project's repos → clone →
scan → if the scope changed, re-mint → seed `auth.json`. From then on the fact is on file
and each turn is a single mint with the full scope.
