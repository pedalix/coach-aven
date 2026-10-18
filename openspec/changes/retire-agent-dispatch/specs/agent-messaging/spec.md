## ADDED Requirements

### Requirement: Mentions never create a task
Mentioning a project or an agent in text SHALL never create a task, whether in a question, an answer or a reply to a person. Only a `send_message` call SHALL create one.

#### Scenario: Text mention
- **WHEN** an agent's answer to a person contains "@caldora please check the orders"
- **THEN** no task is created for caldora, and caldora starts no turn

## MODIFIED Requirements

### Requirement: The answering turn runs in a shadow conversation
An installation receiving a task SHALL run it as a turn of the target agent in a conversation of its own, one per task, under the target project's tenant. The turn SHALL use the target's prompt and sandbox. It SHALL go through the same queue, metering and restart recovery as chat turns, including the task's origin in metering after a restart. It SHALL post nothing to any chat conversation. The question SHALL be framed to the agent as a question from another agent, to be answered without changing anything. Shadow turns SHALL use at most half of the installation's concurrent turn slots, and at least one, so incoming tasks never take every slot from people. A shadow conversation's session SHALL be closed once its task has ended.

#### Scenario: Nothing in the channel
- **WHEN** bluefin answers a task for caldora
- **THEN** caldora's channel shows no message, and metering records the turn with its task id and origin `home/owen-ops`

#### Scenario: Restart mid-answer
- **WHEN** the bluefin bot restarts while the shadow turn runs
- **THEN** the turn is recovered like a chat turn, the answer is still sent once, and metering still carries the task's origin

#### Scenario: Recovery fails
- **WHEN** the bluefin bot restarts and the shadow turn can be neither reattached nor replayed
- **THEN** the task ends `failed` with the answering side's error, and the asker is told

#### Scenario: Incoming burst
- **WHEN** ten tasks arrive at once on an installation with four turn slots, while people are using it
- **THEN** at most two shadow turns run at a time, the others wait for a shadow slot, and a person's turn still gets a slot
