## Why

An agent asked to add a CI workflow cannot push it: the token minted for the sandbox never carries `workflows`
(`AGENT_PERMISSIONS` in `src/github.ts`), although the GitHub App installation grants it. That omission is deliberate —
with `workflows: write` an agent can push an `on: push` workflow that runs with the repository's Actions secrets, so a
prompt injection (a ticket, a PR body, a mail) or an unattended poller run could reach them unseen. Today the only way
through is a person with Git access adding the files by hand. The operator wants a human to lift such a limit for a
short, recorded window instead, and wants the mechanism general enough for the next privileged capability.

## What Changes

- `/aven grant <capability> [duration]` from a project channel: an operator gives that project an extra capability
  for a while (default 30 minutes, at most 4 hours). The first and only capability is `workflows` — GitHub
  `workflows: write`.
- `/aven grant` lists the project's active grants; `/aven grant <capability> off` ends one early.
- A grant is recorded in `state.json` (who, what, until, where) and announced in the channel when it starts and ends.
- While a grant is active, the GitHub token seeded into that project's sandbox carries the extra permission, from the
  next turn on. Every turn of the project gets it — the sandbox and its token file are shared.
- When it ends, new turns get the ordinary token again. Tokens already minted are not revoked: they expire on their
  own within an hour, and the end notice says so.
- The reply says when a grant can have no effect: the installation runs without App auth, or the App installation
  has not granted the permission.
- The agent is not told anything: no prompt change, no new tool, no hook. A push that failed before the grant
  succeeds when retried after it.
- The Home lists (Slack, Teams, web) and `docs/commands.md` teach the verb.

Out of scope:
- Per-call approval (a card for each privileged tool call). It needs a Claude Code permission path under
  `--dangerously-skip-permissions` that is not proven, and it would suggest an isolation between sessions that one
  shared sandbox cannot give.
- Capabilities other than `workflows`, and grants that change anything besides the GitHub token (MCP routes, SQL
  write access). The registry is shaped for them; each is its own change.
- Granting from a client workspace, or by anyone who is not an operator.
- Revoking the widened tokens when a grant ends (design D8: whoever could copy one could already use it during the
  grant). A future capability whose after-the-fact use is dangerous brings its own revocation.

## Capabilities

### New Capabilities
- `project-grants`: temporary, operator-granted extra capabilities for one project — the command, the record and
  its announcements, the widened sandbox token while a grant is active, and how a grant ends.

### Modified Capabilities
<!-- none: no existing spec covers the agent's GitHub token or the /aven verbs -->

## Impact

- **Rollout bucket 2**, default-preserving: with no grant recorded, the token minted for every sandbox requests exactly
  today's permissions (a test pins the requested set), the system prompt is byte-identical (golden fixtures
  untouched), and no message is posted. Prod changes only when an operator runs `/aven grant`. The gate is the
  command itself; no env flag.
- Visible: one new verb in the three Home lists and in `docs/commands.md`.
- Code: `src/grants.ts` (new, pure: capability registry, command parsing, active/expired), `src/github.ts` (extra
  permissions into the mint, token revocation), `src/tasks.ts` (sandbox seeds pass the project's grants),
  `src/chat/core/commands.ts` (the verb), `src/state.ts` (the record), `src/pollers.ts` (the expiry sweep),
  `src/chat/slack/blocks.ts`, `src/chat/teams/teamshome.ts`, `src/chat/web/webhome.ts`, recorded snapshots.
- No new dependency. No GitHub App permission change: the App already declares `workflows: write` (the mirror job
  mints with it); an installation that has not approved it is named in the grant's reply, and the mint still drops
  what an installation lacks, as today.
