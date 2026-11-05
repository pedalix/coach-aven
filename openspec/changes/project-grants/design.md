# Design

## Context

See proposal.md for why. What shapes the approach:

- One sandbox per project, shared by every thread of it. The GitHub token lives in one file, `/root/.gh-token`, read by
  the git credential helper on every git call; `gh` and composer's `auth.json` get copies (`seedGitHubAuth`,
  `seedComposerAuth` in `src/project.ts`).
- The token is minted and re-seeded at the start of EVERY turn (`ensureSession` in `src/tasks.ts`; also once at
  project preparation). `getGitHubToken` requests `AGENT_PERMISSIONS` ∩ what the installation granted
  (`intersectPermissions`), scoped to the project's repositories. The orchestrator also mints for its own reads
  (pollers' PR lists, the sources tenant pull) through the same function.
- Operator verbs already exist: `/aven reload` checks `operator` in `src/chat/core/commands.ts` (on Slack the home
  workspace's people, on Teams and the web the configured operators). Command replies are private
  (`ChatDriver.reply`); channel-visible messages go through `ChatDriver.post`.
- Routines already store `{teamId, channel, surface}` and the pollers resolve the right driver from it; the pollers
  run a once-a-minute loop.

## Goals / Non-Goals

**Goals:**
- One pure module owns the capability registry and the grant rules, so the next capability is one registry entry
  plus whatever it widens.
- New turns get the widened token exactly while the grant is active; the end needs no action on the sandbox.
- No change at all for a project without a grant.

**Non-Goals:**
- Isolation between threads of one project during a grant (impossible with one shared sandbox and token file).
- Approving individual tool calls, or telling the agent about grants.
- Revoking tokens minted during a grant (D8).

## Decisions

### D1 — Grants are per project and time-boxed, not per call or per thread

The sandbox and its token file are shared by every thread of the project, so a per-thread or per-call grant would
promise an isolation the box cannot give. A project-wide window is honest about it and is exactly one condition in the
mint. Rejected: per-call approval through Claude Code's permission prompt (`can_use_tool` with a PreToolUse hook
answering `ask`) — whether the pinned CLI routes a hook's `ask` to the prompt tool under
`--dangerously-skip-permissions` is unproven, and the elevated token would still sit in the shared file. Rejected:
adding `workflows` to `AGENT_PERMISSIONS` or a permanent per-project config switch — both leave the permission on for
unattended runs indefinitely, with no record of who wanted it.

### D2 — Operators grant; same check as `/aven reload`

No new role or allowlist. A client workspace's admins are not operators and cannot widen the App's tokens. Listing
(`/aven grant` alone) is a read surface, open to whoever may see the project's settings (added to `VIEWER_VERBS`).

### D3 — Duration: default 30 minutes, at most 4 hours; a repeat grant replaces the end time

`<n>m` or `<n>h`, 1 minute to 4 hours. Granting a held capability again sets its end to now + duration (it can shorten
it too), so there is at most one grant per (project, capability). The cap keeps a forgotten grant from becoming a
standing permission; 4 hours covers a working session.

### D4 — The registry (`src/grants.ts`, pure)

```ts
CAPABILITIES = { workflows: { label: 'GitHub workflows write', github: { workflows: 'write' } } }
parseGrantCmd(text) → list | grant{cap, ms} | off{cap} | error
activeGrants(records, slug, now) / expiredGrants(records, now)
githubExtras(records, slug, now) → Record<permission, level>   // union of the active grants' `github` maps
```

Times are absolute ISO strings, so a restart needs no recomputation. A future capability that widens something other
than the GitHub token adds its own field beside `github` and its own reader; nothing generic beyond that.

### D5 — The record lives in `state.json`

`grants: { [slug]: { [capability]: { until, at, by, teamId, channel, surface? } } }` — the routine shape for "where to
announce", so the sweep resolves the driver the way routines do (`driverFor`, `asSurface`). Expired records are
removed by the sweep after the end is announced.

### D6 — The mint takes the extras; only sandbox seeds pass them

`getGitHubToken(cfg, repos, extra?)` requests `AGENT_PERMISSIONS ∪ extra`, still through `intersectPermissions`, so an
installation that has not approved `workflows` drops it (and is warned about) instead of failing the mint. The three
sandbox seeds in `src/tasks.ts` pass `githubExtras(store grants, slug, now)`; the orchestrator's own reads pass
nothing. With no grant, `extra` is empty and the request is byte-for-byte today's — the bucket-2 proof is a test on the
requested permissions. "Active" is decided at mint time (`now < until`), not by the sweep, so a turn after the end gets
the ordinary token even before the end is announced.

### D7 — A grant takes effect on the next turn

The grant does not touch a running sandbox: the per-turn seed is already the single place the token changes, and a
turn in progress keeps the token it started with. The reply says "from the next message".

### D8 — Ending: remove and announce; no revocation, no re-seed

The minute sweep (the pollers' existing 60-second loop) and `off` share one end function: remove the record, post the
end notice to the conversation it was granted in. Nothing touches the sandbox: the next turn's seed is already
ordinary (D6), and a stopped sandbox gets that seed before its agent runs.

Tokens minted during the grant are not revoked; each expires within an hour of its minting, and the end notice says
so. Rejected: revoke at the end (in-memory list of minted tokens, re-seed a running sandbox under its lock first,
`DELETE /installation/token`). It only stops someone who copied a token during the grant from using it afterwards —
and that someone could already do the same harm during the grant — while it is the only part that needs in-memory
state, sandbox access from the sweep and a restart story. A capability whose after-the-fact use is dangerous brings
its own revocation.

### D9 — Feedback at grant time

The reply checks two things and states them; neither blocks the grant. `cfg.github.kind !== 'app'`: the grant has no
effect (a static token has its own scopes; `none` has no token). Otherwise one JWT call (`fetchInstallation`, as the
mint already does) for the project's first repository: if its permissions lack a capability's GitHub permission, say
that an organization owner must approve it.

### D10 — Nothing reaches the agent

No prompt text, tool or hook changes. The agent sees a push refused before the grant and the same push succeeding
after it. The golden prompt fixtures stay untouched.

## Risks / Trade-offs

- [During a grant every turn of the project carries the widened token, including pollers' turns and routines] →
  accepted and stated in the announcement; windows are short (≤ 4 h) and recorded.
- [A token minted near the end stays valid up to an hour after it, in the sandbox file and for anyone who copied it] →
  accepted (D8); a turn still running at the end keeps its token until it finishes. The end notice says it.
- [The bot is down at the end time] → no turn runs meanwhile; the first sweep after start-up removes and announces the
  grant, and mints already stopped widening at the end (D6).
- [A grant on an installation in token mode does nothing] → said in the reply (D9), not refused, so the command
  behaves the same everywhere.

## Migration Plan

Default-preserving: deploy as usual with `ship`; a state file without `grants` reads as no grants. Rollback is the
previous version: older code keeps an unknown `grants` key in `state.json` and ignores it, and any widened token
expires within an hour.
