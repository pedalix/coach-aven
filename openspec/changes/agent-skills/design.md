## Context

Cards and tasks come from `agent-messaging` (design D7, D9) with `hub-open-network` (version 2, N5) on top:
- **The card** is the subset `AgentCard {name, description, accepting, domain}` in `src/messaging/a2a.ts`.
  - It is built by `localCards` in `src/messaging/service.ts`.
  - It is answered to a peer's `agents` request by `onAgents` as a `cards` payload.
  - It is parsed with `parseCard`, which rebuilds the object from known fields, so unknown fields are dropped.
- **`send_message(target, text, {taskId?})`** (`src/messaging/tools.ts`) goes to `sendMessage`. That function checks a local target's existence and acceptance at once. It records an `OutTask` and posts an `ask` whose sealed `Payload` is `{message, domain, toDomain?, marks, depth}`.
- **The receiving side, `onAsk`,** checks in this order:
  1. acceptance (`not accepted` also covers "no such agent");
  2. `domain changed`;
  3. `too deep`;
  4. `budget`.

  It then records an `InTask` and delivers `wrapTask(...)` into a shadow conversation.
- **The `messaging` block** is validated in `src/messaging/config.ts`. `description` there is one line of at most 300 characters.
- **`/aven asks`** is rendered by `src/messaging/audit.ts`.

Constraints:
- No change for projects without `skills`.
- No protocol version: version 2's rule is that changes are additive and receivers ignore unknown fields.
- `retire-agent-dispatch` is rewriting `wrapTask` and the tool descriptions right now, so this change is implemented after it merges.

## Goals / Non-Goals

**Goals:**
- An asker can see what each reachable agent offers and name what it asks for.
- The receiving installation is the only authority on its agents' skills.
- The skill a task named is visible afterwards, in records, the audit and the answering framing.

**Non-Goals:**
- Routing, permissions or pricing by skill. The design places their hooks; nothing more.
- Agents that are not sandboxes.
- Inferring a skill from the text of a task.

## Decisions

### S1. Skills are declared by the operator, in the `messaging` block
```json
"messaging": {
  "accept": ["home/owen-ops"],
  "description": "Brand studio: brand profiles and site designs for hotels",
  "skills": [
    { "id": "brand-profile", "name": "Brand profile from a website",
      "description": "Scans a hotel's website and returns a structured brand profile: tone, colours, imagery, audiences",
      "examples": ["build a brand profile for hotel-alpenrose.example"], "tags": ["branding"] },
    { "id": "site-design", "name": "Site design from a brand profile",
      "description": "Proposes a page design that follows a brand profile",
      "examples": ["design the landing page for hotel-alpenrose.example"] }
  ]
}
```
- `description` stays what the agent is; skills are what it offers.
- Validation (caps: 16 skills, 5 examples, 8 tags; one-line texts; kebab ids, unique) runs at load and on `/aven reload`. It fails loudly and names the project and the skill, as the rest of the block does.

Alternatives:
- *Skills in the project prompt (`projects.d/<slug>.md`).* The prompt is prose for the agent, not data for other agents.
- *Generated from the README or from facts.* That is attractive later, when facts can say what an agent really did. Now it would describe intentions as capabilities.

### S2. The A2A AgentSkill subset
- A skill is `{id, name, description, examples?, tags?}`. A2A also has `inputModes` and `outputModes`; we omit them, because every task is text today.
- A2A requires `tags`. Ours are optional, and an adapter to an external A2A endpoint would send `[]`.
- `AgentCard.skills?` is absent when the agent declares none, so the card of every project without skills stays byte-identical.

### S3. On the wire: `skills` on the card, `skill` in the sealed payload
- **Cards.** `cards` carries the new card field. `parseCard` keeps valid skills and drops malformed entries (a peer's bad skill never hides its whole card).
- **Payload.** The skill a task asks for travels as `Payload.skill`, inside the encryption, beside `domain` and `depth`.
  - It is not in the A2A message: A2A has no standard field for it. An adapter to a real A2A endpoint would map it to `message.metadata`.
  - It is set on a task's first message only.
- **Old releases.** Both fields are additive within version 2. A release without this change drops `skills` from cards and ignores `skill`, so a task naming a skill runs there as a general request. That is acceptable, and it is said in `docs/agent-messaging.md`.

### S4. The receiving installation decides
In `onAsk` the skill check comes after acceptance, the domain and the depth, and before the budget:
1. A sender the target does not accept gets `not accepted`, as today, and learns nothing about skills.
2. A skill the target does not declare, or a value that is not a skill id, gets `rejected: unknown skill`. The rejection text lists the declared ids, which the accepted sender could read from the card anyway.
3. A rejected task does not count against the budget.

A local target is checked in `sendMessage` before anything is recorded, exactly as its acceptance is today. The tool returns an error listing the target's skills. `onAsk` still checks, so both transports have one authority.

### S5. What the answering agent sees
- `wrapTask` gains one optional line after `From: … · Task: …`: `Skill: <id> — <name>: <description>`.
- Without a skill, the framing is byte-identical, and the existing goldens prove it. A new golden pins the line.
- The line informs; it grants nothing (S7).

### S6. Records and audit
- `OutTask.skill?` and `InTask.skill?` are added to `state.json`, which is additive.
- `/aven asks` shows ` · skill <id>` on a task that named one.
- The `ask.rejected` event carries `reason=unknown skill`.

### S7. What a skill does not do yet, and where that plugs in

| Later | Plugs in at |
|---|---|
| Routing by skill (a prompt fragment, another session or another sandbox per skill) | `onAsk`, after S4's check: the skill is known and authoritative there |
| Permissions per skill, with roles per sender in `accept`, enforced by the receiving bot through the sandbox permission mode | the same point; the role and the skill pick the mode for the shadow conversation |
| Agents that are not sandboxes (adapters to external A2A endpoints) | a card source beside `localCards`; S2's subset maps 1:1 to A2A |
| Cost per skill in `/aven asks` | the task's `skill` and its metered cost are already on one record |
| Generated cards | the facts store (`docs/project-facts.md`) as a second source for `skills` |

## Risks / Trade-offs

- **[Declared skills drift from what the agent can do]** The operator owns the text, and examples keep it concrete. Generated cards are a later option.
- **[An asker names the wrong skill]** It gets `rejected: unknown skill` with the list, and asks again. No turn is spent on the answering side.
- **[A release without skills runs a skill-named task as a general request]** This is additive by design, and documented. It matters only until all installations run this change.
- **[Card size]** Caps on count and length. Cards travel only per `agents` call.
- **[A peer's card text reaches the asking agent]** It is the peer operator's declared text, returned as tool data like today's description. The asker's rules for data from other agents apply.

## Migration Plan

None: configuration and wire are additive. Merge (bucket 2), then:
1. Declare skills for one staging project in its ops repo, and `/aven reload` there.
2. Call `agents()` from the home tenant agent; it shows them.
3. Run a task naming a declared skill, and one naming an unknown skill. Record both in the PR.

**Rollback.** Remove `skills` from the configuration, or revert. Records with `skill` stay readable by the older code, which ignores the field.
