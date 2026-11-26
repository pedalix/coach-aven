## Context

Read on `main`, 2026-11-26:

- **Levels today.** `src/access.ts`: per workspace `mode` (open / allowlist), `users` (may drive), `admins` (may
  run `/aven users`). "Operator" is computed in `src/chat/core/commands.ts`: `isHome && (isOperator ?
  isOperator(user) : true)`. Teams passes `isOperator` from `TEAMS_OPERATORS`, the web from its `operators`
  setting; the Slack driver passes nothing, so every user of the home workspace is an operator.
- **Operator commands today.** `/aven reload`, `/aven usage`, `/aven asks`, `/aven grant <capability>` (two
  capabilities: `workflows`, `actions`).
- **Model.** `CLAUDE_MODEL` → `cfg.claudeModel` → `--model` when a session starts (`src/tasks.ts`,
  `src/claudeSession.ts`). One value per installation. No effort setting; the only "effort" in chat is the review
  depth of `/aven review`, which is a prompt, not the CLI's effort.
- **Per-user surfaces.** The Home is published per person (`publishHome(user, …)`) but with the same view for
  everyone. The Session card is posted privately to the person who pressed ⚙️ Session (`postPrivate`), read-only
  plus Restart session. A message's own buttons are shared by all who see it — a per-person view can only live
  in the Home, a private post or a dialog.
- **Chat-set project settings** already live in the state (auto-review on/off and its depth), beside grants.

## Goals / Non-Goals

**Goals**

- An operator does in chat what today needs a file edit or a second tool: name operators, set a project's
  model and effort, and see grants, model and effort in one place.
- One rule for "operator" on all three chat platforms.
- Nothing changes for an installation that does not set the flag.

**Non-Goals**

- Editing `projects.config.json` or prompts from chat. The config is the ops repository's; the bot reads it.
- A model or effort per conversation or per turn (see Open Questions).
- Operators of a client workspace, or roles finer than viewer / may drive / operator.
- New capabilities to grant.

## Decisions

**D1. Operator = named in the config OR in a chat-kept list; nobody named → the platform's earlier rule.**
The config names stay as they are (`TEAMS_OPERATORS`, the web's `operators`); Slack gets the chat list only.
The list is one array in the state with who added each entry and when. *Rejected:* reusing the home workspace's
`admins` of `TeamAccess` — on a client workspace an admin manages who may drive there, and giving the same word
the fleet-wide meaning on home makes one field mean two rights. *Rejected:* a `SLACK_OPERATORS` setting alone —
it keeps "who may manage" a file edit, which is the complaint.

**D2. The first `add` on Slack also adds the caller.** Otherwise the first person named would lock out the one
naming them. The step from "everyone" to a list can be taken by anyone in the home workspace, because today
they are all operators; it is recorded with their name. Going back to "everyone" is not offered in chat (the
last operator cannot be removed) — it is a state edit by hand, on purpose.

**D3. Model and effort are per project, stored in the state, and reach new sessions only.** Order of
precedence: the project's chat-set value, then the installation's setting, then the CLI's own default. The
session start already passes `--model`; effort is passed the same way (`--effort`). This is the reach of
`/aven reload`, so the wording in replies is shared. *Rejected:* a `model` field in the project's config — the
bot does not write the config, and the request is to change it without leaving chat. *Rejected:* switching a
running session in place — not known to be supported by the pinned CLI, and Restart session already exists.

**D4. Accepted model names are a short list kept beside the CLI pin.** The aliases the pinned CLI accepts, in
one constant next to `PROBED_CLI_VERSIONS`, with a CLI-probe scenario that starts a session with each name and
with each effort level. A full model id is not accepted: a typo would only show when the next conversation
fails to start.

**D5. One view model for "what an operator sees of a project"**, built in `src/chat/core/`, used by both the
Home's section and the Session card: `{ slug, model, effort, grants[] }` with each value's source. The Home
view gains an optional operator part; the card's info gains the same optional part. Each driver renders it
(Slack blocks, Teams card, web HTML); the Slack output is pinned by the recorded snapshots.

**D6. Controls call the command handlers.** A button or a select carries the project and the value; the action
handler checks the operator rule again (a Home can stay open for days) and calls the same function the slash
command calls. No second implementation of a grant or a reload.

**D7. A grant pressed in the Home is announced in the project's channel.** `project-grants` announces "in the
channel the grant was made in"; the Home is not a channel, so the project's own conversation is used. Where a
project has no conversation the bot can post to, the control is refused with that reason.

**D8. One flag, `OPERATOR_CONTROLS=1`.** It gates the verbs, the list, the Home's section and the card's part.
Off: byte-identical Home and card (the existing snapshots prove it) and the earlier operator rule.

## Risks / Trade-offs

- **A wider Home for operators can hit Slack's view limits** (100 blocks; the Home once failed to publish when
  one section grew) → the section is laid out by the same packing as the cheat-sheet, and a fleet with many
  projects shows a per-project line with one overflow menu, not a block of buttons each.
- **Model changes move cost.** → operator-only, recorded with who and when, shown in the Home and in
  `/aven model`; the usage report already attributes cost per project.
- **Naming operators on Slack removes rights from everyone else in the home workspace at once.** → the reply
  says exactly that, with the resulting list.
- **The effort flag on the pinned CLI (2.1.314) is not verified** — `--effort` was read from the help of a
  newer local CLI (2.1.332). → the probe scenario is the first task; if the pinned CLI lacks it, effort waits
  for the next pin and the rest ships.

## Migration Plan

1. Merge with the flag off: no installation changes.
2. Home installation: flag on; name the operators; set a model and an effort on one project; start and end a
   grant from the Home; check the announcement and the card as an operator and as someone else.
3. First production installation, on the operator's word: flag on in its `.env`, operators named the same day.
4. Rollback at any step: remove the flag. The stored list and values stay in the state and are ignored.

## Open Questions

- **Per conversation?** The local habit is "this task is hard — raise the effort here". This change sets it per
  project. A per-thread value on the card is the natural next step, once the per-project one has been used.
- **Who may see costs.** `/aven usage` stays operator-only; whether the Home's section should carry a cost line
  per project is not decided.
- **Which other settings.** The request named "settings" in general. Only model and effort are covered; the
  next candidates should come from what is actually missed after this ships.
