# Proposal

## Why

A project without a `sandbox` block runs as **privileged docker-in-docker**: `resolveSandboxOptions` defaults to `privileged: true, dind: true`, and the runtime defaults to `--privileged`. That default fit the first installations, Laravel agencies running Sail inside the sandbox. For anyone else it is the riskiest choice, made silently:
- A privileged container is root-equivalent on its Docker host. Claude Code runs there with its permission prompts off and reads text from people and documents.
- With a local sandbox host, that Docker host is the machine holding the bot's secrets and its Docker socket.

The image has the same problem from the other side: one installation-wide image (`SNAPSHOT_IMAGE`, a Daytona-era name) forces one toolchain on every project, so a Laravel project and a Node project cannot share an installation without a compromise.

## What Changes

The maintainer's shape (2026-10-31):
- **Per installation, two sandbox settings besides the driver:** the host and the default image.
- **Per project:** `sandbox.image` overrides the image, and `sandbox.dind: true` asks for Docker inside, which makes the container privileged.
- **The mode default is plain**, whatever the default image. Docker-in-docker is only ever written on the project that gets it.

In detail:
- **`sandbox.image`** on a project: the image its container is created from. Unset means the installation's `SANDBOX_IMAGE`.
- **The settings get `SANDBOX_` names:**

  | Old | New |
  |---|---|
  | `SNAPSHOT_IMAGE` | `SANDBOX_IMAGE` |
  | `SSHDOCKER_HOST` | `SANDBOX_HOST` |
  | `SSHDOCKER_RUNTIME` | `SANDBOX_DIND_RUNTIME` |

  The old names stay readable as fallbacks, and the boot logs one line naming the ones in use. Templates and docs use only the new names.
- **`"dind": true` alone means privileged**, so `{ "dind": true }` is the whole opt-in.
- **Warnings at boot and at `/aven reload`:**
  - projects without a block, named, because they rely on today's default and the default becomes plain in a later release; the fix is `"dind": true` (or `"sandbox": { "dind": false }` to accept plain now);
  - a privileged project on a local sandbox host without `SANDBOX_LOCAL_PRIVILEGED=1`;
  - the old setting names.
- **`SANDBOX_DEFAULT`** (stage 1 as first merged, never released in a tag) is removed: the default is not an installation setting.
- **The flip, a separate PR:** a project without a block runs plain. It shipped after every operated installation wrote `"dind": true` where it needs it.

## Capabilities

### Modified Capabilities
- `sandbox-drivers`: the image and the privilege are a project's choice; the installation's sandbox settings and their names.

## Impact

- **Rollout:**
  - **This change, bucket 2:** a project without a block still runs as today; every existing `docker run`, prompt, housekeeping and idle-stop script stays byte for byte, pinned by tests. New: `sandbox.image`, the new names (old ones read), the warnings.
  - **The flip, a later change, bucket 3:** block-less projects run plain; containers whose flags or image differ from the project's are listed for recreation. Its own ledger row.
  - Before the flip: prod writes `"dind": true` on its 11 block-less projects (today's behaviour, unchanged); staging and home already have plain blocks.
- **Code:** `src/sandboxopts.ts` (image field, warnings), `src/config.ts` and `src/cliprobe/sandbox.ts` (names with fallbacks), `src/projects.ts`, `src/sshdocker.ts` and `src/driver.ts` (per-project image), `src/tasks.ts`, `infra/deploy/deploy.sh` and the quickstart compose file (the host and image names).
- **Out of scope:** egress filtering (not planned); image labels checking the mode (the maintainer: not needed); per-project runtimes; seccomp/AppArmor.
