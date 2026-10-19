## Purpose

Ends the processes of a project sandbox nobody is using, the way Daytona's idle stop did, on a sandbox provider that has no idle lifecycle of its own (ssh-docker): when the bot stops an idle container, what counts as activity, how a stop coordinates with turns and wakes, what happens to the conversations in it, and which containers it may touch.

## ADDED Requirements

### Requirement: An idle project container is stopped
For every project whose sandbox driver has no idle stop of its own (ssh-docker), the bot SHALL stop the project's container once it has been idle for `SANDBOX_AUTOSTOP_MINUTES` minutes, and SHALL log one line naming the container and how long it was idle. The next turn SHALL start it again, as SHALL `/aven memory live`; calls that only look at the container (housekeeping, `/aven memory`) SHALL find it asleep and leave it stopped, as they did on Daytona. A project on a driver whose provider stops idle sandboxes itself (Daytona) SHALL NOT be stopped by the bot.

#### Scenario: Thirty quiet minutes
- **WHEN** `SANDBOX_AUTOSTOP_MINUTES` is unset and an ssh-docker project's container has had no activity and no work in progress for 30 minutes
- **THEN** the container is stopped within the following minute and the log says `sandbox '<name>' stopped after 30 min idle (ssh-docker)` or a later minute count

#### Scenario: Activity just before the limit
- **WHEN** a message is answered in the project 29 minutes after its previous activity
- **THEN** the container is not stopped, and the 30 minutes count again from that answer

#### Scenario: The next message after a stop
- **WHEN** a person writes in a thread of a project whose container was stopped
- **THEN** the container is started, the turn runs and its answer is posted like any other

#### Scenario: A Daytona project
- **WHEN** a project runs on the Daytona driver
- **THEN** the bot never stops its sandbox; Daytona's own idle stop applies as before

### Requirement: Activity is what the bot does in the container
A container's last activity SHALL be the latest of: the start or the end of any call the bot makes into it (a command, a file upload, starting, writing to or ending a session process, warming the container up), and any output the bot reads from one of its session processes. It SHALL NOT be earlier than the moment the bot started checking for idle containers. Listing containers and checking whether a container runs SHALL NOT count as activity.

#### Scenario: Nightly housekeeping on an awake container
- **WHEN** the housekeeping routine runs its commands in an awake container and they end at 04:41
- **THEN** that container is not stopped before 04:41 plus `SANDBOX_AUTOSTOP_MINUTES`

#### Scenario: Status checks do not keep it awake
- **WHEN** someone runs `/aven status` every five minutes and nothing else happens in a project
- **THEN** the project's container is still stopped after `SANDBOX_AUTOSTOP_MINUTES`, and the status then shows it stopped

#### Scenario: After a bot restart
- **WHEN** the bot restarts while a container has been idle for two hours
- **THEN** the container is stopped no sooner than `SANDBOX_AUTOSTOP_MINUTES` after the bot started, not at its first check

#### Scenario: A session that keeps printing
- **WHEN** a background agent of a conversation keeps producing output after its turn was answered
- **THEN** each output counts as activity and the container stays up until it has been quiet for `SANDBOX_AUTOSTOP_MINUTES`

### Requirement: Turns hold the container whatever their silence
The bot SHALL NOT stop a project's container while any turn of that project is queued, running, or waiting for a person to answer an agent question; while a one-off answer or a dream runs on it; or while a turn that a bot restart interrupted is being recovered. These hold the container however long the turn has produced no output and made no call into it.

#### Scenario: A long silent command
- **WHEN** a turn runs one command for 45 minutes that prints nothing and makes no other call
- **THEN** the container is not stopped during the turn, and it is stopped `SANDBOX_AUTOSTOP_MINUTES` after the turn ends if nothing else happens

#### Scenario: An unanswered agent question
- **WHEN** the agent asked a question with option buttons and nobody has clicked for 40 minutes
- **THEN** the container is not stopped while the question is open

#### Scenario: A turn waiting for a free slot
- **WHEN** a turn of the project waits in the queue for a free agent slot for 40 minutes
- **THEN** the container is not stopped while it waits

#### Scenario: Recovery after a restart
- **WHEN** the bot restarts during a turn and recovers it by reattaching to its still-running process
- **THEN** the container is not stopped until the recovery has settled

### Requirement: Lingering work postpones the stop up to the turn hard cap
Background tasks that a session's CLI reports as running, messages written into a session and not answered yet, and bot calls into the container that have not returned SHALL postpone the stop of an otherwise idle container, but only until its last activity is older than the larger of `STREAM_HARD_MAX_MINUTES` (the turn hard cap, 60 by default) and `SANDBOX_AUTOSTOP_MINUTES`. A container stopped while such work was still listed SHALL be logged as a warning naming that cause.

#### Scenario: A long background run
- **WHEN** a turn started an end-to-end suite in the background and answered, and the suite runs for 40 minutes without output
- **THEN** the container is not stopped while the suite runs, and its completion is posted as a background update as before

#### Scenario: A background task that never ends
- **WHEN** a session still lists a background task but the container has had no activity for 61 minutes
- **THEN** the container is stopped and the warning says background work was still listed

#### Scenario: A call that never returns
- **WHEN** a call into the container has been running for 61 minutes and nothing else happened
- **THEN** the container is stopped and the warning says a sandbox call was still running

### Requirement: A stop and a wake never interleave
The bot SHALL decide a stop again immediately before issuing it, while no other start, stop or state check of that container by the bot can run; if the container is no longer idle, it SHALL NOT be stopped. Any turn or call that needs the container while a stop runs SHALL wait for the stop to finish and then start the container. A check of whether the container runs SHALL wait for a running stop and report the state after it.

#### Scenario: A message during the stop
- **WHEN** a message arrives for the project while its container is being stopped
- **THEN** the turn waits for the stop, starts the container and answers, and nothing in the thread mentions the stop

#### Scenario: Work that started before the final check
- **WHEN** a turn of the project is queued after the sweep found the container idle but before the stop was issued
- **THEN** the container is not stopped

#### Scenario: Housekeeping during a stop
- **WHEN** the housekeeping routine checks a container while it is being stopped
- **THEN** it sees the container stopped and records `sandbox asleep — skipped`

### Requirement: Conversations resume after a stop
When the bot stops a container, it SHALL treat every session process of that project as ended without any call into the sandbox, post nothing in any thread, keep each conversation's Claude session id, and forget each conversation's reattach coordinates without changing the conversation's last-used time. The next turn of a conversation SHALL resume it with its session id.

#### Scenario: Replying in a thread after a stop
- **WHEN** a person replies in a thread whose project's container was stopped
- **THEN** the turn continues the same Claude conversation, and no error, "session died" or "context lost" note appears in the thread

#### Scenario: A bot restart after a stop
- **WHEN** the bot restarts after it stopped a container and a thread of that project continues
- **THEN** the bot does not try to reattach to a process of the stopped container; it resumes the conversation

#### Scenario: Retention is not reset
- **WHEN** a stop forgets the reattach coordinates of a conversation last used 44 days ago
- **THEN** that conversation's record is still pruned at 45 days, as if the stop had not happened

### Requirement: A wake restores what a Daytona start restored
When the bot starts an ssh-docker container that was stopped (or stops and starts it to recover it), it SHALL remove the session files of the processes that ended with the container and, for a docker-in-docker project, SHALL start dockerd and wait for it to answer before the warm-up returns. A dockerd that does not come up SHALL be logged and SHALL NOT fail the warm-up. Containers the agent ran inside it (a Sail stack) SHALL be left for the agent to start again. After such a start, no session process from before it SHALL be reported as running, whatever process now holds its old pid. A warm-up of a running container SHALL change none of this.

#### Scenario: Sail after a wake
- **WHEN** a docker-in-docker project's container is started again and the agent runs `./vendor/bin/sail up -d`
- **THEN** dockerd answers and the stack comes up

#### Scenario: A sandbox host reboot
- **WHEN** the sandbox host rebooted, its containers are stopped, and the bot holds a reattach record of a session process from before the reboot
- **THEN** the next turn starts the container, that process is reported gone, and the conversation resumes with its session id without waiting on a stale session

#### Scenario: A warm container
- **WHEN** a turn warms up a container that is already running
- **THEN** no session files are removed and dockerd is left as it is

### Requirement: Only this installation's containers are stopped
The bot SHALL consider for a stop only containers named `<SANDBOX_NAME_PREFIX><slug>` for the projects of its own registry whose driver has no idle stop of its own, and SHALL stop one only if its `managedBy` label equals this installation's `SANDBOX_MANAGED_BY` value and its `project` label equals the slug. A container that fails the label check SHALL be left running and SHALL be named in one warning per bot start.

#### Scenario: Another installation on the same host
- **WHEN** another installation's containers run on the same Docker host under another name prefix, with the same `managedBy` value
- **THEN** the bot never stops them

#### Scenario: A foreign container with one of our names
- **WHEN** a container named like one of the installation's projects carries another `managedBy` or `project` label
- **THEN** it is left running and one warning names it

#### Scenario: Other containers on a local Docker host
- **WHEN** the bot runs with `SSHDOCKER_HOST=local` next to a developer's own containers and the CLI probe's `cli-probe-*` containers
- **THEN** none of them is ever stopped by the bot

### Requirement: Configuration and where the stop runs
`SANDBOX_AUTOSTOP_MINUTES` SHALL keep its meaning: unset or empty means 30; `0` or a negative number means the bot never stops a container; a value that is not a number SHALL fail the boot naming the key. Idle checks SHALL run once a minute, only in the chat bot process once its background work has started, never in the CLI probe, the sources daemon or a one-off CLI command. A stop that fails SHALL be logged as a warning with the reason, SHALL leave the project's sessions as they are, and SHALL be tried again at the next check.

#### Scenario: Turned off
- **WHEN** `SANDBOX_AUTOSTOP_MINUTES=0`
- **THEN** no container is ever stopped by the bot and nothing else changes

#### Scenario: Not a number
- **WHEN** `SANDBOX_AUTOSTOP_MINUTES=thirty`
- **THEN** the bot does not start and the error names `SANDBOX_AUTOSTOP_MINUTES`

#### Scenario: The sources daemon beside the bot
- **WHEN** the sources daemon runs on the same host as the bot
- **THEN** only the bot process stops containers

#### Scenario: The host does not answer
- **WHEN** the stop command fails because the sandbox host is unreachable
- **THEN** a warning names the container and the reason, the sessions are untouched, and the stop is tried again a minute later
