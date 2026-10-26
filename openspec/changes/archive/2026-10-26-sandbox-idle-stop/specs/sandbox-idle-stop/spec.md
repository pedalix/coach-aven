## Purpose

Ends the processes of a project sandbox nobody is using, the way Daytona's idle stop did, on a sandbox provider that has no idle lifecycle of its own (ssh-docker): when the bot stops an idle container, what counts as activity, how a stop coordinates with turns and wakes, what happens to the conversations in it, what a wake restores, and which containers it may touch.

## ADDED Requirements

### Requirement: An idle project container is stopped
For every project whose sandbox driver has no idle stop of its own (ssh-docker), the bot SHALL stop the project's container once it has been idle for `SANDBOX_AUTOSTOP_MINUTES` minutes, and SHALL log one line naming the container, how long it was idle and how long the stop took. The next turn SHALL start it again, as SHALL `/aven memory live`; `/aven memory` SHALL find it asleep and leave it stopped, as it did on Daytona. A project on a driver whose provider stops idle sandboxes itself (Daytona) SHALL NOT be stopped by the bot.

#### Scenario: Thirty quiet minutes
- **WHEN** `SANDBOX_AUTOSTOP_MINUTES` is unset and an ssh-docker project's container has had no activity and no work in progress for 30 minutes
- **THEN** the container is stopped within the following minute and the log says `sandbox '<name>' stopped after 30 min idle (ssh-docker, <s>s)` or a later minute count

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
A container's last activity SHALL be the latest of: the start or the end of any call the bot makes into it (a command, a file upload, starting, writing to or ending a session process, warming the container up), and any output the bot reads from one of its session processes. It SHALL NOT be earlier than the moment the bot started checking for idle containers. Listing containers and checking whether a container runs SHALL NOT count as activity. Idle time, and the age of a turn's hold, SHALL be measured on the monotonic clock the turn deadlines run on: time the host spent suspended, or a step of its wall clock, SHALL NOT count.

#### Scenario: Nightly housekeeping on an awake container
- **WHEN** the housekeeping routine runs its commands in an awake container and they end at 04:41
- **THEN** that container is not stopped before 04:41 plus `SANDBOX_AUTOSTOP_MINUTES`

#### Scenario: Status checks do not keep it awake
- **WHEN** someone runs `/aven status` every five minutes and nothing else happens in a project
- **THEN** the project's container is still stopped after `SANDBOX_AUTOSTOP_MINUTES`, and the status then shows it stopped

#### Scenario: After a bot restart
- **WHEN** the bot restarts while a container has been idle for two hours
- **THEN** the container is stopped no sooner than `SANDBOX_AUTOSTOP_MINUTES` after the bot started, not at its first check

#### Scenario: A host that slept
- **WHEN** the machine running the bot and its containers is suspended for two hours during a turn and then resumes
- **THEN** the turn still holds its container, and the time asleep counts toward no idle limit

#### Scenario: A session that keeps printing
- **WHEN** a background agent of a conversation keeps producing output after its turn was answered
- **THEN** each output counts as activity and the container stays up until it has been quiet for `SANDBOX_AUTOSTOP_MINUTES`

### Requirement: Turns hold the container whatever their silence
The bot SHALL NOT stop a project's container while any turn of that project is being accepted, queued, running, or waiting for a person to answer an agent question; while a one-off answer or a dream runs on it; or while a turn that a bot restart interrupted is being recovered. These hold the container however long the turn has produced no output and made no call into it — except a hold older than the turn hard cap (`STREAM_HARD_MAX_MINUTES`) plus five minutes, measured from when its turn left its conversation's queue, which SHALL count as lingering work instead.

#### Scenario: A long silent command
- **WHEN** a turn runs one command for 45 minutes that prints nothing and makes no other call
- **THEN** the container is not stopped during the turn, and it is stopped `SANDBOX_AUTOSTOP_MINUTES` after the turn ends if nothing else happens

#### Scenario: An unanswered agent question
- **WHEN** the agent asked a question with option buttons and nobody has clicked for 40 minutes
- **THEN** the container is not stopped while the question is open

#### Scenario: A turn waiting for a free slot
- **WHEN** the first turn of a new thread waits in the queue for a free agent slot for 40 minutes
- **THEN** the container is not stopped while it waits

#### Scenario: A message still being acknowledged
- **WHEN** a message arrives for an idle project and the bot is still marking it and posting its status message when the sweep re-checks the container
- **THEN** the container is not stopped

#### Scenario: Recovery after a restart
- **WHEN** the bot restarts during a turn and recovers it by reattaching to its still-running process
- **THEN** the container is not stopped until the recovery has settled

#### Scenario: A turn hung before its watchdog
- **WHEN** a turn has held the container for 70 minutes because a call made while preparing its session never returned, and the container has had no activity for 60 minutes
- **THEN** the container is stopped and the warning says a turn held it past the hard cap

### Requirement: A scheduled wakeup is waited for
When the agent of a live session scheduled a wakeup (`ScheduleWakeup`), the bot SHALL NOT stop the project's container before two minutes after the wakeup is due. The due time SHALL be the one the CLI reports for the call, or the call's time plus its requested delay clamped to one hour until that report arrives, and SHALL never be later than the call plus 62 minutes. A cancelled wakeup, or one whose process ended, SHALL NOT hold anything.

#### Scenario: A wakeup in 50 minutes
- **WHEN** a turn scheduled a wakeup 50 minutes out, answered, and nothing else happens
- **THEN** the container is not stopped before two minutes after the wakeup is due

#### Scenario: A cancelled wakeup
- **WHEN** the agent scheduled a wakeup and then cancelled it with `stop`
- **THEN** the container is stopped `SANDBOX_AUTOSTOP_MINUTES` after its last activity

### Requirement: Lingering work postpones the stop up to the turn hard cap
Background tasks that a session's CLI reports as running, messages written into a session and not answered yet, a turn the CLI started on its own and has not finished, a hold older than the turn hard cap, and bot calls into the container that have not returned SHALL postpone the stop of an otherwise idle container, but only until its last activity is older than the larger of `STREAM_HARD_MAX_MINUTES` (the turn hard cap, 60 by default) and `SANDBOX_AUTOSTOP_MINUTES`. A container stopped while such work was still there SHALL be logged as a warning naming that cause.

#### Scenario: A long background run
- **WHEN** a turn started an end-to-end suite in the background and answered, and the suite runs for 40 minutes without output
- **THEN** the container is not stopped while the suite runs, and its completion is posted as a background update as before

#### Scenario: A turn the CLI started on its own
- **WHEN** a background task finished after its turn was answered and the CLI's own follow-up turn runs a command that prints nothing for 40 minutes
- **THEN** the container is not stopped while that turn runs

#### Scenario: A background task that never ends
- **WHEN** a session still lists a background task but the container has had no activity for 61 minutes
- **THEN** the container is stopped and the warning says background work was still listed

#### Scenario: A call that never returns
- **WHEN** a call into the container has been running for 61 minutes and nothing else happened
- **THEN** the container is stopped and the warning says a sandbox call was still running

### Requirement: A stop and a wake never interleave
The bot SHALL decide a stop again immediately before issuing it, while no other start, stop or state check of that container by the bot can run; if the container is no longer idle, it SHALL NOT be stopped. Any turn or call that needs the container while a stop runs SHALL wait for the stop to finish, including the sessions being ended and their coordinates forgotten, and then start the container. A check of whether the container runs SHALL wait for a running stop and report the state after it. A stop that does not finish SHALL be ended at its timeout, over ssh and in local mode alike, so nothing waits on it longer.

#### Scenario: A message during the stop
- **WHEN** a message arrives for the project while its container is being stopped
- **THEN** the turn waits for the stop, starts the container and answers, and nothing in the thread mentions the stop

#### Scenario: Work that started before the final check
- **WHEN** a turn of the project is queued after the sweep found the container idle but before the stop was issued
- **THEN** the container is not stopped

#### Scenario: A stop that hangs
- **WHEN** the Docker daemon stops answering in the middle of a stop, with the bot in local mode (`SSHDOCKER_HOST=local`)
- **THEN** the stop is ended at its timeout, together with every process it started, and a turn waiting for it goes on

#### Scenario: A peek during a stop
- **WHEN** `/aven memory` checks a container while it is being stopped
- **THEN** it sees the container stopped and says it is asleep

### Requirement: A stop lets the inner Docker shut down
On a docker-in-docker project the bot SHALL ask the container's inner dockerd to stop, and wait for it up to 30 seconds, before stopping the container, so the containers it runs (a Sail stack) are stopped with their own grace rather than killed.

#### Scenario: A Sail database during a stop
- **WHEN** an idle docker-in-docker project's container is stopped while its Sail stack runs
- **THEN** the stack's containers receive their stop signal from the inner dockerd before the outer container stops

#### Scenario: The inner dockerd stopped, the container not
- **WHEN** the inner dockerd was stopped but the container's own stop then failed, or the bot died before it
- **THEN** the next warm-up of the still running container starts dockerd again before its turn goes on

### Requirement: Conversations resume after a stop
When the bot stops a container, it SHALL treat every session process of that project as ended without any call into the sandbox, keep each conversation's Claude session id, and forget each conversation's reattach coordinates without changing the conversation's last-used time. It SHALL post nothing in any thread, except one 🔔 Background update in a conversation whose process still listed background work or was in a turn of its own, saying that this work ended with the stop; a conversation that answers a task of another agent SHALL get no such line. The next turn of a conversation SHALL resume it with its session id.

#### Scenario: Replying in a thread after a stop
- **WHEN** a person replies in a thread whose project's container was stopped
- **THEN** the turn continues the same Claude conversation, and no error, "session died" or "context lost" note appears in the thread

#### Scenario: Background work cut by a stop
- **WHEN** a container is stopped while a session still lists a background task
- **THEN** that conversation's thread gets one 🔔 Background update saying the background work ended with the stop, and no other thread gets anything

#### Scenario: A bot restart after a stop
- **WHEN** the bot restarts after it stopped a container and a thread of that project continues
- **THEN** the bot does not try to reattach to a process of the stopped container; it resumes the conversation

#### Scenario: Retention is not reset
- **WHEN** a stop forgets the reattach coordinates of a conversation last used 44 days ago
- **THEN** that conversation's record is still pruned at 45 days, as if the stop had not happened

### Requirement: A wake restores what a Daytona start restored
At the first warm-up after each start of an ssh-docker container — whoever started it: the bot's wake, a recovery stop-and-start, a host reboot followed by the bot's start, a restart by hand — the bot SHALL remove the session files of every session whose process is not alive in the new run (a session's files SHALL be kept only while its process is alive and its standard input is that session's own pipe, or, where the runtime does not let the bot read it, while a live process holds the pid the session's own files name) and, for a docker-in-docker project, SHALL start dockerd and wait for it to answer before the warm-up returns. A dockerd that does not come up SHALL be logged and SHALL NOT fail the warm-up. Containers the agent ran inside it (a Sail stack) SHALL be left for the agent to start again. A session process SHALL be reported as running only if its standard input is that session's own pipe, so no process from before a start passes for a session, whatever process now holds its old pid; where the container's runtime does not let the bot read a process's standard input at all, the session's own files naming the process SHALL decide, as before this change. A warm-up of a container that has not started again since the bot last saw it SHALL change none of this, and the first warm-up of a container the bot has never seen start SHALL remove nothing.

#### Scenario: Sail after a wake
- **WHEN** a docker-in-docker project's container is started again and the agent runs `./vendor/bin/sail up -d`
- **THEN** dockerd answers and the stack comes up

#### Scenario: A sandbox host reboot
- **WHEN** the sandbox host rebooted, its containers are stopped, and the bot holds a reattach record of a session process from before the reboot
- **THEN** the next turn starts the container, that process is reported gone, and the conversation resumes with its session id without waiting on a stale session

#### Scenario: A start whose probe failed
- **WHEN** a warm-up started the container but failed its health probe, and the next warm-up finds the container running
- **THEN** that next warm-up removes the old session files and starts dockerd

#### Scenario: A start the bot could not record
- **WHEN** a warm-up started the container but could not record the start, and a turn then opened a session in it
- **THEN** the next warm-up removes the session files of the previous run and keeps that session's

#### Scenario: A warm container
- **WHEN** a turn warms up a container that has not started again since the previous warm-up
- **THEN** no session files are removed and dockerd is left as it is

#### Scenario: The first warm-up after this change ships
- **WHEN** the updated bot warms up a container that has been running with live sessions since before the update
- **THEN** no session files are removed and those sessions keep running

### Requirement: Only this installation's containers are stopped
The bot SHALL consider for a stop only the stored sandbox names of the projects of its own registry whose driver has no idle stop of its own, and SHALL stop one only if, in the same host call, its `managedBy` label equals this installation's `SANDBOX_MANAGED_BY` value and its `project` label equals the slug. A container that fails the label check SHALL be left running and SHALL be named in one warning per bot start. A project whose stored sandbox name differs from the one its name prefix gives SHALL be named in one warning per bot start.

#### Scenario: Another installation on the same host
- **WHEN** another installation's containers run on the same Docker host under another name prefix, with the same `managedBy` value
- **THEN** the bot never stops them

#### Scenario: A foreign container with one of our names
- **WHEN** a container named like one of the installation's projects carries another `managedBy` or `project` label
- **THEN** it is left running and one warning names it

#### Scenario: Other containers on a local Docker host
- **WHEN** the bot runs with `SSHDOCKER_HOST=local` next to a developer's own containers and the CLI probe's `cli-probe-*` containers
- **THEN** none of them is ever stopped by the bot

### Requirement: Housekeeping keeps running where the bot stops containers
On a driver whose idle stop the bot owns, while the idle stop is on, the housekeeping routine SHALL wake an asleep container for its pass and say so in its summary, and the idle stop SHALL stop it again afterwards; with the idle stop off it SHALL skip an asleep container, as before. The housekeeping prune SHALL NOT remove containers managed by Docker Compose, on any driver.

#### Scenario: Nightly pass on an idle project
- **WHEN** the housekeeping routine fires for an ssh-docker project whose container is asleep
- **THEN** the container is started, the pass runs, its summary starts with `woke`, and the container is stopped again once it has been idle for `SANDBOX_AUTOSTOP_MINUTES`

#### Scenario: Idle stop off
- **WHEN** `SANDBOX_AUTOSTOP_MINUTES=0` and the housekeeping routine fires for an ssh-docker project whose container is asleep
- **THEN** the container stays stopped and the summary says `sandbox asleep — skipped`

#### Scenario: A stopped Sail stack and the prune
- **WHEN** housekeeping prunes above the disk threshold in a container whose Sail stack is stopped
- **THEN** the stack's containers and their images are kept

### Requirement: Configuration and where the stop runs
`SANDBOX_AUTOSTOP_MINUTES` SHALL keep its meaning, read with surrounding spaces trimmed: unset, empty or only spaces means 30; `0` or a negative number means the bot never stops a container; a value that is not a number SHALL fail the boot naming the key. For the ssh-docker stop a value between 0 and 10 SHALL be raised to 10, with a warning. Idle checks SHALL run once a minute, only in the chat bot process once its background work has started, never in the CLI probe, the sources daemon or a one-off CLI command, and a check SHALL NOT start while the previous one runs. A stop that fails SHALL leave the project's sessions as they are and SHALL be tried again after a backoff that grows from one to fifteen minutes, with one warning when the failures start. The failures SHALL count as over only when the host answers a stop again (a re-check that found work and asked nothing SHALL NOT end them), or once no failure of that container has been seen for twice the longest backoff.

#### Scenario: Turned off
- **WHEN** `SANDBOX_AUTOSTOP_MINUTES=0`
- **THEN** no container is ever stopped by the bot, and housekeeping never wakes an asleep one

#### Scenario: Below the floor
- **WHEN** `SANDBOX_AUTOSTOP_MINUTES=5`
- **THEN** ssh-docker containers stop after 10 minutes without activity, and the bot logs a warning at the start of its checks

#### Scenario: Only spaces
- **WHEN** `SANDBOX_AUTOSTOP_MINUTES` holds only spaces
- **THEN** containers stop after 30 minutes, as if it were unset

#### Scenario: Not a number
- **WHEN** `SANDBOX_AUTOSTOP_MINUTES=thirty`
- **THEN** the bot does not start and the error names `SANDBOX_AUTOSTOP_MINUTES`

#### Scenario: The sources daemon beside the bot
- **WHEN** the sources daemon runs on the same host as the bot
- **THEN** only the bot process stops containers

#### Scenario: The host does not answer
- **WHEN** the stop command fails because the sandbox host is unreachable
- **THEN** one warning names the container and the reason, the sessions are untouched, and the stop is tried again after one minute, then after longer waits up to fifteen minutes, without another warning until a stop of it works again

#### Scenario: A new outage days later
- **WHEN** the host came back while the container was busy, so no stop of it was tried, and days later a stop of it fails again
- **THEN** that failure is a new outage and gets its own warning
