## Why

An operator who is in chat cannot finish an operator's job there. The pieces exist as separate slash commands
(`/aven users`, `/aven grant`, `/aven reload`, `/aven usage`), but:

- **The model and the effort cannot be changed from chat at all.** The model is one installation setting
  (`CLAUDE_MODEL`), read at boot; the effort is not set anywhere. Changing either means editing `.env` and
  restarting the bot, for every project at once.
- **On Slack there is no operator.** Whoever is in the home workspace may reload the config, grant a capability
  and read the costs (`operator = isHome` when the driver names nobody; only Teams and the web name operators,
  in their config). The chat has two levels — may drive, may only read — where three are needed.
- **Nothing shows an operator what is set.** The Home tab is the same cheat-sheet for everyone; the ⚙️ Session
  card is the same for everyone. Which grants are active, which model a project runs, who may manage — each is
  a different command to remember.

Observed on 2026-11-25: the operator of an installation left chat and opened a local session several times in
one day, for a grant, a model change and a look at who may do what.

Consumer: the operator of any installation; first the home installation, then the first production one.

## What Changes

Everything below is behind one flag, `OPERATOR_CONTROLS=1`, off by default.

- **Operators are named, on every chat platform.** `/aven operators` lists them; an operator adds and removes
  one. Operators named in the installation's config stay operators and cannot be removed in chat. Where nobody
  is named at all, the rule is today's (Slack: everyone in the home workspace).
- **A project's model and effort are set from chat**: `/aven model [<name>|default]` and
  `/aven effort [low|medium|high|default]` in the project's conversation, by an operator. Stored with the
  installation's state, applied to conversations that start after it — the same reach as `/aven reload`.
- **The Home shows an operator a section others do not see**: the operators, and per project its model, effort
  and active grants, with buttons for what the commands do (reload, grant, end a grant, model, effort).
- **The ⚙️ Session card shows an operator the same controls for that conversation's project.** Everyone else
  sees today's card.

Not in this change: editing a project's repositories, MCP entries or prompt from chat (they stay in the
installation's ops repository, applied by `/aven reload`); a model or effort per conversation; operators of a
client workspace (operators stay people of the home workspace); new roles beyond viewer, may-drive, operator.

## Capabilities

### New Capabilities

- `operator-controls`: who is an operator and how the list is kept; a project's model and effort set from chat;
  what the Home and the Session card show an operator.

### Modified Capabilities

None. `project-grants` already says "an operator — whoever may run `/aven reload`"; this change defines who
that is and adds a second place to press the same grant.

## Impact

- `src/access.ts` (operators: the rule, the command grammar — pure, tested), `src/state.ts` (the operators
  list; `model`/`effort` beside a project's other chat-set settings), `src/config.ts` (the flag),
  `src/tasks.ts` and `src/claudeSession.ts` (model and effort per project at session start).
- `src/chat/core/commands.ts` (`operators`, `model`, `effort`), `src/chat/core/interactions.ts` (the Home's and
  the card's actions), `src/chat/views.ts` (the Home's operator part, the card's), and the three drivers'
  rendering: `src/chat/slack/blocks.ts`, `src/chat/teams/cards.ts`, `src/chat/web/webviews.ts`.
- The Home lists: `homeBullets`, `src/chat/teams/teamshome.ts`, `src/chat/web/webhome.ts`.
- `src/cliprobe/`: a scenario that the pinned CLI takes the effort and the model names offered.
- Docs: `docs/runtime-config.md`, `docs/configuration.md`, `docs/rollout.md` (the ledger row).
- Rollout bucket: **visible behaviour change behind a flag**, canary first.
