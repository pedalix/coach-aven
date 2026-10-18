# Proposal

> **Status: proposed 2026-10-18.** Decisions taken in review:
> - **A card says what an agent is and what it can do.** `description` stays as the first part. The second is a list of skills, the A2A AgentSkill subset: id, name, description, examples, tags.
> - **A task may name one skill of its target.**
>   - The receiving installation decides: a skill the target does not declare is rejected.
>   - A task without a skill is a general request, as today.
> - **The operator declares skills** in the project's `messaging` block. Routing by skill and permissions per skill come later, with roles per sender.
> - **Implementation waits for `retire-agent-dispatch`**, which is rewriting the same modules (`src/messaging/wrap.ts`, `tools.ts`).

## Why

Today an agent card carries one line: what the agent is. An asking agent picks its target by guessing from that line. Agents are about to specialise:
- a project agent for one codebase;
- an operator's tenant agent;
- an agent for one function, such as a brand studio that builds a brand profile from a hotel's website and designs a site from it.

The asker needs to know what each one offers. A2A's Agent Card already answers this with a list of skills, each with an id, a name, a description and example requests.

A skill named on a task also gives the receiving side something explicit to act on. It does not have to guess intent from the text. That matters for later work (routing a task, allowing a skill to some senders only), and for the audit today.

## What Changes

- **Skills in the configuration.**
  - A project's `messaging` block may declare `skills: [{id, name, description, examples?, tags?}]`.
  - They are validated at load: kebab-case ids, unique, one-line texts with caps, at most 16 skills. An error names the project and the skill.
  - A project without `skills` behaves exactly as before.
- **Skills in the cards.** Cards carry the declared skills: local cards, and remote ones through `cards`. `agents()` shows them for every reachable installation.
- **A skill on a task.** `send_message` takes an optional `skill`.
  - A first message naming a skill the target does not declare gets `rejected: unknown skill`, with the target's skill ids.
  - The receiving installation decides, for both transports. In the caller's own installation, the tool refuses at once and lists the target's skills.
  - Only a task's first message carries a skill.
- **Where the skill shows up.**
  - The task record on both sides stores it.
  - `/aven asks` shows it.
  - The answering turn's framing names the skill, its name and its description.
  - Without a skill, the framing is byte-identical to today's.
- **Protocol.** The change is additive within version 2: a card field `skills`, and a sealed payload field `skill`.
  - A card without `skills` and a payload without `skill` stay valid.
  - A release without this change ignores both (`hub-open-network`: receivers ignore fields they do not know), so it runs a task naming a skill as a general request.

## Out of scope

These are extension notes in the design:
- routing a task by its skill to another session, another prompt or another sandbox;
- permissions per skill, together with roles per sender in `accept`, enforced by the receiving bot through the sandbox permission mode rather than the prompt;
- agents that are not sandboxes, such as adapters to external A2A endpoints (the hub adapter idea from `agent-messaging`);
- cost per skill in `/aven asks`;
- cards generated from a project's README or facts instead of declared by the operator;
- skills of the asking side: a card describes what an agent answers, not what it asks.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `agent-messaging`:
  - new: skills are declared in the messaging configuration;
  - new: a task can name the skill it asks for;
  - changed: discovery through agent cards (cards carry skills);
  - changed: agent tools mirror A2A operations (`send_message` takes `skill`);
  - changed: terminal states (a new `rejected` reason, `unknown skill`).

  The capability comes from the `agent-messaging` change, which is not archived yet. `hub-open-network` and `retire-agent-dispatch` also modify it. The archive order is `agent-messaging` → `hub-open-network` → `retire-agent-dispatch` → `agent-skills`.

## Impact

- **Rollout.**
  - Bucket 2: the change reaches only projects with a `messaging` block, and the configuration is additive.
  - A project without `skills` keeps a byte-identical card, prompt and framing; the existing goldens prove it.
  - The `send_message` tool gains an optional parameter for every project configured to send.
  - Prod has no `messaging` block.
  - One ledger row in `docs/rollout.md`.
- **Order.** Implemented after `retire-agent-dispatch` merges, because that change rewrites `wrapTask` and the tool descriptions.
- **Code.**
  - `src/messaging/config.ts`: validation;
  - `a2a.ts`: `AgentSkill`, card parsing;
  - `protocol.ts`: the payload field;
  - `service.ts`: `localCards`, `sendMessage`, `onAsk`;
  - `tools.ts`: the `send_message` schema;
  - `wrap.ts`: the skill line in `wrapTask`;
  - `records.ts`: the `skill` on task records;
  - `audit.ts`: `/aven asks`;
  - `events.ts`: the `ask.rejected` reason.
- **Config.** `messaging.skills` per project. `projects.config.example.json` and `docs/runtime-config.md` show it.
- **Data.** The task records in `state.json` gain an optional `skill`.
