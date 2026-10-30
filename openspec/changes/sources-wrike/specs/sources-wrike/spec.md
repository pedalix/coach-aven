# Spec Delta

## Purpose
Brings the tasks a team keeps in Wrike folders into a project's sources store as tracker tasks, so the readouts over the attention field (`tasks`, `stuck`, `search`) see that work like the work in the other trackers.

## ADDED Requirements

### Requirement: Folder-scoped Wrike source
A project's `sources.wrike` block SHALL name one or more Wrike folder, project or space ids (API v4); the puller SHALL read every task in each listed folder and in every folder beneath it, subtasks included, and nothing outside them. The block SHALL be validated at boot: `folders` non-empty, each an API v4 id (a permalink number is rejected with the way to convert it), `tokenEnv` an environment variable name, `host` a `wrike.com` host, `since` a date; unknown keys are rejected.

#### Scenario: A client folder with subfolders
- **WHEN** `folders: ["IEAAB2CDI4CLNT01"]` is configured and a task sits in a subfolder of it
- **THEN** the task is pulled, with that subfolder's title as its project

#### Scenario: A permalink number instead of an id
- **WHEN** a folder is configured as `"1100220033"`
- **THEN** the configuration fails at boot naming the API v4 id and the conversion call

### Requirement: Same task record as the other trackers
Each Wrike task SHALL be written as a `task` record (`source: wrike`, `account` = the API host, `id` = the API v4 task id, `key` = the number in its permalink) with its title, status, first assignee, author, due day, created/updated, project, permalink, labels, plain-text description and ALL its comments, scrubbed at write like every tracker record.

#### Scenario: A comment from the client
- **WHEN** a client comments on a task in a configured folder
- **THEN** the next pass writes the task again with every comment it has, and `tasks`/`stuck` see the comment as the task's last activity

### Requirement: Wrike's own verdicts and names
The status category SHALL follow the custom status's group: Completed and Cancelled are `done`, Deferred is `todo`, an Active status is `todo` or `doing` by its name and never `done`. People SHALL be written as `Name <email>` when Wrike knows both, else the e-mail, else the name, else `wrike:<contact id>`.

#### Scenario: A person the people file knows
- **WHEN** a task's first assignee is `Mira Talbot <mira.talbot@studio.example>` and the people file lists `mira.talbot@studio.example`
- **THEN** `stuck` and `tasks` show that person's id as the assignee

#### Scenario: A parked task
- **WHEN** a task's custom status is in the Deferred group and it has not moved for longer than `stuck`'s threshold
- **THEN** `stuck` lists it under its project and status like any open tracker task

### Requirement: Incremental per folder
Each configured folder SHALL keep its own cursor (the newest `updatedDate` seen, re-read with a small overlap); a folder's first pull SHALL start at `since`, or 30 days back without it. The cursor SHALL advance only after the folder's pass succeeded.

#### Scenario: A folder added later
- **WHEN** a second folder is added to a block whose first folder has pulled for weeks
- **THEN** the second folder's first pull starts at `since`, not at the first folder's cursor

#### Scenario: A failed pass
- **WHEN** a request fails mid-pass
- **THEN** that folder's cursor stays where it was and the next pass re-reads from there

### Requirement: Credentials and failures
The token SHALL come from the environment variable `tokenEnv` (default `WRIKE_API_TOKEN`) and SHALL be sent only to the configured `wrike.com` host. A 429 SHALL be retried after its `Retry-After`; a 401 or 403 SHALL mark the source for re-authentication. `orch sources auth <slug> wrike check` SHALL report who the token is and fail when a configured folder is not readable with it.

#### Scenario: A revoked token
- **WHEN** Wrike answers 401
- **THEN** the pull reports `reauth`, no folder's cursor moves, and the daily credential check fails the same way

### Requirement: Nothing changes without a Wrike block
A project without `sources.wrike` SHALL pull, store and answer exactly as before; the other trackers' raw layout and cursors SHALL be unchanged.

#### Scenario: Existing tracker projects
- **WHEN** a project has YouTrack, Jira or Asana blocks and no `wrike` block
- **THEN** its raw files, cursors and readout answers are the same as in the previous release
