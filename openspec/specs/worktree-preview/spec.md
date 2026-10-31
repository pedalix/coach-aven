# worktree-preview Specification

## Purpose

Running a worktree's code as a private web-chat bot on a scratch project, on the operator's machine beside the installations running there and sharing nothing with them, so a change can be seen before it merges.

## Requirements

### Requirement: A preview runs the worktree's code as a loopback web chat
`npm run preview` SHALL start the bot from the current checkout's source with the web chat as its only chat driver, `WEB_AUTH=none`, a loopback listener and the first free port from 8790 up. It SHALL print the URL to open.

#### Scenario: Starting a preview
- **WHEN** the operator runs `npm run preview` in a worktree
- **THEN** the bot logs `Web chat running`, and the printed `http://127.0.0.1:<port>` opens the chat without a sign-in

#### Scenario: Two previews
- **WHEN** a second worktree starts a preview while the first one runs on 8790
- **THEN** the second listens on 8791

### Requirement: A preview is the quickstart's installation on a scratch project
A preview SHALL build its settings from the repository's quickstart templates (`quickstart/.env.example`, `quickstart/projects.config.example.json`) and the operator's `~/.config/coach-aven/preview.env`, which supplies the Claude credit, the GitHub access (a GitHub App or a token, reaching the scratch repository only) and `PREVIEW_REPO`, the scratch repository of the `demo` project.

#### Scenario: First preview on a machine
- **WHEN** `preview.env` names a credit, a GitHub App or token and `PREVIEW_REPO=acme/scratch`
- **THEN** the preview's only project is `demo` on `acme/scratch`, with the quickstart's unprivileged sandbox settings

#### Scenario: Missing operator file
- **WHEN** `~/.config/coach-aven/preview.env` does not exist or lacks the credit, the GitHub access or `PREVIEW_REPO`
- **THEN** nothing starts, and the message names the file and the missing keys

### Requirement: A preview reads nothing from an installation
A preview SHALL NOT read an installation's `.env`, projects config, state or data, and SHALL carry no Slack, Teams, hub, tracker or error-tracker setting.

#### Scenario: Home runs on the same machine
- **WHEN** the home installation runs with its Slack tokens, hub identity and projects
- **THEN** the preview's environment has none of them, and its only project is `demo`

### Requirement: A preview writes only its own directory and containers
A preview SHALL keep its installation and data directories under the worktree's `.preview/`, ignored by git and starting from an empty state. Its sandboxes SHALL carry a name prefix derived from the branch and a `managedBy` label of their own.

#### Scenario: Beside the home bot
- **WHEN** the home bot has sandboxes `proj-*` and a preview on branch `fix/thread` opens a turn
- **THEN** the preview creates `pv-fix-thread-proj-demo`, and home's containers and files are untouched

### Requirement: Stopping a preview removes what it created
`npm run preview -- stop` SHALL stop the worktree's preview process and remove the sandbox containers that carry its prefix. It SHALL keep `.preview/` unless `--clean` is given.

#### Scenario: Stop after review
- **WHEN** the operator runs `npm run preview -- stop` in the worktree
- **THEN** the port is free, no container with the preview's prefix exists, and the installations' containers are untouched
