# Proposal

## Why

Today, trying CoachAven takes a working day and other people's admins.
- **A Slack app.** It needs a workspace admin, a manifest, two tokens and a reinstall.
- **A Docker host.** The sandboxes need a Docker host, a sandbox image the installation builds and pushes to its own registry, and a privileged docker-in-docker default.
- **A GitHub App.** The App needs an organization owner's approval.
- **Nothing ties the steps together.** Each piece is documented, but no page puts them in order or says how long they take.

The community plan sets the goal for weeks 2–3: one trial path, measured on a clean machine. The maintainer should finish it in under 60 minutes, and one person from outside in under 90. Its steps should need no registry, no privileged container and no other person's approval.

The pieces exist on `main`:
- the published bot image and the compose runtime (`container-deploy`);
- the web chat (`web-chat-driver`), which needs no Slack;
- sandboxes on the machine's own Docker (`SSHDOCKER_HOST=local`);
- the unprivileged plain sandbox image (`snapshot/plain`);
- a plain `GITHUB_TOKEN`;
- the subscription token (`claude setup-token`), which the maintainer chose as the credit to try with (`api-key-credit`, design D7).

What is missing is the path that joins them, plus two gaps:
- **The web chat cannot be reached in a container without a login.** `WEB_AUTH=none` requires a loopback listener. A container's loopback cannot be reached through a published port, so a local web chat in compose needs either an identity provider or a forwarding sidecar. The home bot runs that sidecar today, a workaround nobody should have to copy.
- **The bot does not say when it cannot reach Docker.** With local sandboxes, a missing socket or a wrong group shows up as an error inside the first turn, not at boot.

## What Changes

- **A `quickstart/` directory in the repository: a complete installation directory.** It has the layout of an ops overlay and of a box (`container-deploy` D1), so the quickstart and an operated installation differ only in their values:
  - `.env.example`: the minimum for a trial, about seven lines (credit, `GITHUB_TOKEN`, web chat, local sandboxes);
  - `projects.config.example.json`: one project, one repository, `sandbox: { privileged: false, dind: false }`, no MCP, no workspaces, and sandbox names of its own (`qs-`), so it never shares a container with another installation on the same machine;
  - `compose/compose.yaml`: the bot from the published image (`orch web`), its sandboxes from the published plain sandbox image of the same version, and a `setup-token` service run on demand;
  - `init.sh`: copies the two templates when their targets are missing, and writes the machine's values into `compose/.env`: the image version of the clone's commit, the user, the group, the Docker socket's group as a container sees it, and the port. It never asks for or writes a credential.
- **The steps.**
  1. Clone at the latest release tag.
  2. Run `./init.sh`.
  3. Get a subscription token: `claude setup-token`, which also runs inside the sandbox image without installing anything.
  4. Create a fine-grained GitHub token for one repository.
  5. Fill three lines.
  6. Run `docker compose up -d`.
  7. Open the sign-in link from the log.
  8. Ask in the project's room.

  An "Uninstall" section removes the containers, the sandbox included.
- **A local sign-in link for the web chat (`WEB_AUTH=link`).** At boot, the bot prints a link with a new random key. Opening it signs the browser in as the installation's only person, who is also its operator. The session survives restarts, because the bot keeps its own session secret in the installation directory. Without the key, every page answers 401. Unlike `none`, it may listen on any address inside the container, so a published port works. Like `none`, it requires a localhost base URL, so it stays a local mode and never becomes a login for a public host.
- **A boot check of the local Docker.** With `SSHDOCKER_HOST=local`, the bot checks in the background, retrying for a minute, that it reaches Docker. When it does not, it logs one error naming the socket, the group and `init.sh`. The boot neither waits nor stops.
- **Docs.**
  - `docs/quickstart.md`: the steps with their measured times, what each step needs from whom, and how to go on from there (Slack or Teams, a remote Docker host, an API key, `npm run ops`).
  - The README gets a "Try it" block that links to it.
  - `docs/web.md` describes `WEB_AUTH=link`.
- **The measurement.** A rehearsal on a fresh Linux machine by Claude, then the maintainer on a clean VM. The times go into `docs/quickstart.md`.

- **The plain sandbox image is published (added 2026-10-30, after the first rehearsal).** CI builds `snapshot/plain` beside the bot image for every `main` commit and promotes it on a release tag, as `ghcr.io/pedalix/coach-aven-sandbox-plain` under the bot's version names. The quickstart then builds nothing on the machine: one version names both images, the step that built the image for 70 s is gone, and `setup-token` runs from a pulled image. Operated installations keep building their own sandbox images.

## Capabilities

### New Capabilities
- `quickstart`: the trial installation the repository ships. It covers what the directory holds, what it needs from the machine and from other services, the order of the steps, the sandbox image built locally, and the measured time.
- `web-local-login`: the web chat's sign-in link for a local installation. It covers when the mode is accepted, what the link grants, and what a request without it gets.

### Modified Capabilities
- `sandbox-image`: the plain variant is published by this repository's CI under the bot image's version names.

Otherwise none. The web chat's and the compose runtime's own specs belong to changes still in flight (`web-chat-driver`, `container-deploy`). This change adds beside them and does not modify their requirements.

## Impact

- **Rollout: bucket 2, default-preserving.**
  - `WEB_AUTH=link` is a new value. No installation sets it, and `oidc` and `none` behave as before (tests prove both).
  - The Docker boot check runs only with `SSHDOCKER_HOST=local`, in the background, logs only after a minute of failures, never stops the boot and sends nothing to the error tracker.
  - The `quickstart/` directory is new files that no installation reads.
  - Ledger row: "quickstart (`WEB_AUTH=link`)". The canary is the rehearsal and the maintainer's run. No prod stage, because no operated installation uses it. The row retires when the maintainer's measurement is in `docs/quickstart.md`.
- **Code:**
  - `src/config.ts`: `WEB_AUTH=link`;
  - `src/chat/web/server.ts` and `app.ts`: the link route, the 401, the boot line;
  - `src/sshdocker.ts`: the Docker check, started from the shared boot path;
  - `src/cliprobe/gate.test.ts`: the quickstart's CLI pin;
  - tests beside each.
- **Files:** `quickstart/`, `docs/quickstart.md`, `README.md`, `docs/web.md`, `docs/rollout.md`.
- **Out of scope:**
  - **Changing defaults for operated installations.** Privileged docker-in-docker stays the default for a project without a `sandbox` block. Making it opt-in is a bucket-3 change of its own.
  - **The README's first screen, `docs/security.md`, `local-dev.md` in three levels, `troubleshooting.md` and `configuration.md`.** These are docs PRs beside this change, without OpenSpec.
  - **An `orch doctor`.** Checks will come from real failure reports, one at a time; the Docker check is the first.
  - **Slack or Teams in the quickstart.** They are documented as the next step, not part of the trial.
  - **The sources daemon, MCP servers, routines and the hub.**
