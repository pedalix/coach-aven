# cli-probe Specification

## Purpose
Turns what the bot assumes about the headless Claude Code CLI into hypotheses with verdicts, recorded per CLI version and checked against the SDK's type declarations, so the repository only pins CLI versions whose contract was probed.

## Requirements

### Requirement: A hypothesis about the CLI is a scenario with a verdict
Each scenario SHALL state one hypothesis about the CLI, drive the CLI through scripted steps and judge each run from the CLI's events.

**Run verdicts.** A run SHALL be judged `holds`, `fails` or `inconclusive`. A scenario SHALL tell apart what it waits for:
- **Preconditions.** For example, the model makes the scripted tool call. When a precondition does not happen within its time, the run is `inconclusive`.
- **Predictions.** What the hypothesis says the CLI does. When a prediction does not happen within its time, the run `fails`.

**Verdict per CLI version.** A scenario SHALL declare how many conclusive runs settle it. Its verdict for a version is:
1. `flaky`, when its conclusive runs disagree, however many there are;
2. otherwise `inconclusive`, when it has fewer conclusive runs than it declares;
3. otherwise `holds` or `fails`, as all its conclusive runs say.

Only `holds` counts as holding.

**Contract or exploratory.** A scenario SHALL be marked `contract` when the bot relies on its hypothesis. Otherwise it is exploratory: its verdict is recorded and gates nothing.

#### Scenario: The model does not follow the script
- **WHEN** a scenario asks for a Bash call and the model answers without one
- **THEN** the run is `inconclusive`, it does not count toward the verdict, and the report says which precondition was missing

#### Scenario: A predicted event never comes
- **WHEN** a scenario predicts a `result` within 10 seconds of an interrupt and none comes
- **THEN** the run `fails`

#### Scenario: Runs disagree
- **WHEN** one conclusive run holds and another fails
- **THEN** the scenario is `flaky` for that version and does not hold, even if it declares more runs than were conclusive

#### Scenario: Not enough conclusive runs
- **WHEN** a scenario declares three runs, only two were conclusive, and both hold
- **THEN** its verdict for that version is `inconclusive`

### Requirement: A probe run is isolated from the machine it runs on
A run SHALL use:
- the CLI version it names, installed outside the machine's own installation, or a binary given explicitly;
- a configuration directory created for the run;
- a subscription token given to the probe in its own variable;
- the bot's own command line (environment prefix, behaviour variables and flags), with the scenario's extras merged into it;
- an empty working directory.

It SHALL remove the environment variables a parent Claude Code session sets. Nothing from the operator's own Claude Code configuration (settings, plugins, skills, memory, hooks) SHALL reach the run.

A run SHALL check the version the CLI reports in `system/init` against the version it names. A mismatch SHALL end the run as an error, not as a verdict.

#### Scenario: The operator's configuration does not leak
- **WHEN** the operator's own Claude Code has plugins and a default permission mode
- **THEN** the probe run's `system/init` lists none of those plugins, and permissions behave as the bot's flags make them behave

#### Scenario: Started from inside a Claude Code session
- **WHEN** the operator starts the probe from a Claude Code session
- **THEN** the CLI under test sees none of that session's environment variables

#### Scenario: The bot's flags change
- **WHEN** the bot's spawn command changes
- **THEN** the next probe run uses the changed command without a change to the probe

#### Scenario: Version not installed
- **WHEN** the named version is not on the machine
- **THEN** the probe installs it in its own cache, and the machine's own `claude` stays as it was

#### Scenario: The wrong CLI answers
- **WHEN** the CLI that starts reports a version other than the one the run names
- **THEN** the run ends as an error naming both versions, and no verdict is recorded

### Requirement: A probe can run through the bot's sandbox transport
With a sandbox transport selected, the probe SHALL:
- run the CLI in a sandbox it creates for that run, through the bot's sandbox driver, under a name that carries the probe's own prefix;
- write to and read from the CLI through the same driver calls the bot's session uses;
- delete the sandbox when the run ends, including when the run fails.

It SHALL delete only sandboxes whose names carry its prefix, chosen by name. A driver's listing can include every sandbox of an account. Deleting a project's sandbox SHALL be refused by the driver itself.

#### Scenario: Run in a sandbox
- **WHEN** the operator runs a scenario with the ssh-docker transport
- **THEN** the CLI runs in a new sandbox of the probe's own, its stdin goes through the driver's session input, and the report names the transport

#### Scenario: The run fails midway
- **WHEN** a sandbox run fails after the sandbox was created
- **THEN** the sandbox is deleted and the failure is in the report

#### Scenario: Leftover from a crashed run
- **WHEN** the driver's listing holds a leftover probe sandbox and the sandboxes of an installation's projects
- **THEN** the probe deletes the leftover and nothing else

#### Scenario: Asked to delete a project's sandbox
- **WHEN** any code asks the driver to delete a sandbox whose name carries the project prefix
- **THEN** the driver refuses and deletes nothing

### Requirement: Each probed version leaves a report and recordings in the repository
For each probed CLI version, the probe SHALL write a report and, for each scenario, the recording of one conclusive run. Both go under the repository's fixtures for that version.

A recording SHALL hold:
- the frames in both directions, with times relative to the start of the run;
- the process boundaries: each start with its arguments (secrets excluded), and each exit with its code or signal.

The report SHALL name:
- the CLI version and the SDK release used for type checks;
- the models and the transport;
- the date;
- each scenario's verdict, with its runs, observations and cost;
- the event kinds seen, with their fields;
- the type-check findings.

It SHALL render as tables. When the probed set already holds a version, the report SHALL also show what changed since the newest of those versions: verdicts, kinds and fields.

Recordings SHALL be normalized before they are written, and every field SHALL keep its type:
- every string has the run's paths removed, in their plain and their encoded forms;
- every identifier the CLI or the API issued is replaced by a stable placeholder of the same shape, so cross-references survive;
- no wall-clock time remains, including times encoded in identifiers;
- opaque blobs, such as thinking signatures, are replaced by fixed values;
- the whole rate-limit information is replaced by fixed values.

The report SHALL carry a hash of each recording.

#### Scenario: A pin bump shows what changed
- **WHEN** a pin-bump pull request adds the report of a new version
- **THEN** that report has a section listing the verdicts, event kinds and fields that changed since the newest version already probed

#### Scenario: A recording is normalized
- **WHEN** a recording is written
- **THEN** no string in it contains a path under the operator's home or the run's directories, in plain or encoded form
- **AND** it contains no session, run, task or message id the CLI issued, no wall-clock time and no thinking signature
- **AND** a placeholder that replaces a UUID is itself a UUID

#### Scenario: A recording spans a restart
- **WHEN** a scenario kills the CLI and starts it again with `--resume`
- **THEN** the recording shows the exit with its signal and the new start with its arguments, between the frames of the two processes

#### Scenario: Identifiers and secrets in recordings
- **WHEN** reports and recordings are committed
- **THEN** the repository's identifier guard and its secret scanner check them like any tracked file

### Requirement: Events are checked against the SDK's declarations
The probe SHALL check every recorded frame against the type declarations of the Claude Agent SDK release that names the probed CLI version as the one it matches. When no release names that version, it SHALL use the nearest lower release and name it in the report. When no release at or below the version exists, the check SHALL fail and say so.

For each frame, the candidates are the declared kinds whose discriminating literals the frame matches: its type, its subtype, and the replay marker of a user message. The check SHALL walk the frame against each candidate, keep the candidate with the fewest violations, and report every finding of that frame, not only the first:
- a **violation**: a required field is missing, or a field has a value its declared type does not allow, at a path;
- an **undeclared field**: a field the kind does not declare, at a path;
- an **undeclared kind**: no candidate.

Findings on frames the CLI wrote:
- a violation of the protocol's own declarations SHALL fail the check;
- a mismatch inside the API message model those declarations import (the Anthropic API's message, usage and stream event types) SHALL be listed, not failed;
- undeclared fields and kinds SHALL be listed, not failed.

Findings on frames the probe wrote, which are the bot's own frames, SHALL be listed and SHALL NOT fail the check.

The declarations SHALL be fetched at check time. They SHALL NOT be committed to the repository or installed as a dependency.

#### Scenario: A field of the wrong type
- **WHEN** a recorded `result` carries `session_id` as a number
- **THEN** the check reports a violation at `session_id` and fails

#### Scenario: Several findings in one frame
- **WHEN** a recorded frame lacks a required field and carries two fields the declaration lacks
- **THEN** the check reports the missing field as a violation and both extra fields as undeclared, for that one frame

#### Scenario: A mismatch in the API message model
- **WHEN** an assistant frame's message lacks a field that the imported API message type requires
- **THEN** the report lists it as an API message model mismatch and the check passes

#### Scenario: A field the declarations lack
- **WHEN** `system/init` carries a field the declarations do not list
- **THEN** the report lists it as an undeclared field and the check passes

#### Scenario: A kind the declarations lack
- **WHEN** the CLI emits an event kind the declared union lacks
- **THEN** the report lists it as an undeclared kind and the check passes

#### Scenario: The bot's own message differs from the declaration
- **WHEN** a user message the probe wrote, as the bot writes it, lacks a field the SDK's declaration requires
- **THEN** the report lists the finding under the input frames and the check passes

#### Scenario: No release names the version
- **WHEN** no SDK release names the probed CLI version
- **THEN** the check uses the nearest lower release and the report says so

### Requirement: The bot's session code is tested against recordings
Every contract scenario SHALL have a test that feeds its recording to the bot's session code and asserts what the bot makes of it. The repository's test command SHALL run these tests without network.

#### Scenario: A recorded turn
- **WHEN** the recording of a plain turn is replayed
- **THEN** the session settles one turn with the recorded result text, cost and session id

#### Scenario: A recorded host tool call
- **WHEN** the recording of a host tool call is replayed
- **THEN** the session answers the `mcp_message` requests and the turn settles with the tool's result in its text

#### Scenario: A recorded background report
- **WHEN** the recording of a background task that outlives its turn is replayed
- **THEN** the unsolicited result reaches the idle-result path and settles no waiting turn

### Requirement: The repository's CLI pin is a probed version
The repository SHALL keep a set of probed CLI versions. A version SHALL be in the set only when:
- its committed report has every contract scenario holding;
- the hashes in the report match its recordings.

These SHALL be in the set:
- the CLI version the sandbox images default to;
- the version in the example environment file.

CI SHALL fail when any of these rules is broken. CI SHALL also re-check the committed recordings against the SDK declarations named in their reports.

The image build SHALL refuse to bake a CLI version outside the set.

#### Scenario: A pin bump without a report
- **WHEN** a pull request changes the images' default CLI version to one without a committed report
- **THEN** CI fails

#### Scenario: A contract scenario fails on a new version
- **WHEN** a new version's report has a contract scenario that does not hold
- **THEN** the version cannot enter the set, and the repository cannot pin it

#### Scenario: A recording edited after its report
- **WHEN** a recording changes and its hash no longer matches the report
- **THEN** CI fails

#### Scenario: An image built with an unprobed pin
- **WHEN** an operator builds a sandbox image with a CLI version outside the set
- **THEN** the build stops before anything is built and names the probed versions

### Requirement: Live runs belong to the operator, never to CI
A live run SHALL take its subscription token only from the probe's own variable. It SHALL report its cost per scenario and in total.

CI SHALL run without any model credential. It checks committed reports and recordings only.

A probe run SHALL NOT read or change any installation's state, configuration or project sandboxes. The sandbox transport SHALL use only the driver settings in the probe's own environment.

#### Scenario: CI on a pull request
- **WHEN** CI runs on a pull request
- **THEN** no CLI is started against the model API, and the checks use only the committed files and the fetched declarations

#### Scenario: No token
- **WHEN** the operator starts a live run without the probe's token variable, on a host whose installation has a token of its own
- **THEN** the probe stops before starting the CLI, names its variable, and does not use the installation's token

#### Scenario: Cost
- **WHEN** a live run ends
- **THEN** the report lists the cost of each scenario and the total

#### Scenario: Probe beside a running bot
- **WHEN** the operator runs the probe with the sandbox transport on the host where an installation's sandboxes run
- **THEN** the probe creates, uses and deletes only its own sandbox, and the bot's state file, chat records and project sandboxes are unchanged
