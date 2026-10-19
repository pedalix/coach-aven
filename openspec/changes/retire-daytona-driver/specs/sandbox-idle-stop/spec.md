## MODIFIED Requirements

### Requirement: An idle project container is stopped
For every project whose sandbox driver has no idle stop of its own (ssh-docker), the bot SHALL stop the project's container once it has been idle for `SANDBOX_AUTOSTOP_MINUTES` minutes, and SHALL log one line naming the container, how long it was idle and how long the stop took. The next turn SHALL start it again, as SHALL `/aven memory live`; `/aven memory` SHALL find it asleep and leave it stopped. A project on a driver whose provider stops idle sandboxes itself SHALL NOT be stopped by the bot.

#### Scenario: Thirty quiet minutes
- **WHEN** `SANDBOX_AUTOSTOP_MINUTES` is unset and an ssh-docker project's container has had no activity and no work in progress for 30 minutes
- **THEN** the container is stopped within the following minute and the log says `sandbox '<name>' stopped after 30 min idle (ssh-docker, <s>s)` or a later minute count

#### Scenario: Activity just before the limit
- **WHEN** a message is answered in the project 29 minutes after its previous activity
- **THEN** the container is not stopped, and the 30 minutes count again from that answer

#### Scenario: The next message after a stop
- **WHEN** a person writes in a thread of a project whose container was stopped
- **THEN** the container is started, the turn runs and its answer is posted like any other

#### Scenario: A driver whose provider stops its own sandboxes
- **WHEN** a project runs on a driver whose provider stops idle sandboxes itself, so the driver offers the bot no stop
- **THEN** the bot never stops that project's sandbox
