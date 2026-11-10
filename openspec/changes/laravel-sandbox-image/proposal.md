# Proposal

## Why

The laravel sandbox image (`snapshot/Dockerfile`) has no contract in the specs and fails a fresh Laravel checkout in four ways, found in a new installation's first project on 2026-11-09:
- **The first `composer install` fails.** Before `vendor/` exists the shim runs Composer in `laravelsail/php83-composer`, an image last built in March 2024 (PHP 8.3.3). Measured on a real application's lock file of 279 packages: exit 2 with 23 problems — `symfony/*` 8.1 wants `php >=8.4.1`, four extensions are missing. The agent has to find its own way around the documented first step.
- **Sail's commands cannot write the checkout.** Sail runs `sail artisan`, `sail composer`, `sail npm` as its `sail` user, uid 1337; the sandbox and its checkout are root's (files 0644). `artisan key:generate` cannot write `.env`, Laravel cannot open `storage/logs/laravel.log`, `composer require` cannot write `vendor/`, and Composer cannot read the 0600 `auth.json` the bot writes for private packages.
- **`sail` is not a command**, although the shim's own message and the system prompt say `sail up -d` and `sail npm …`.
- **The image lacks tools the plain image has.** In prod's eleven docker-in-docker sandboxes the transcripts of nine show `python3: command not found`.

## What Changes

- **The bootstrap runs in the official Composer image** (`composer:2`), as the caller, with platform requirements ignored and the arguments exactly as typed. It is what Laravel's own recipe for an existing application did: the lock file was resolved for the PHP and the extensions of the project's Sail container, which no generic image has.
- **The image sets `APP_USER=root`**, so Sail runs its commands as the user that owns the checkout. A project whose `.env` names another `APP_USER` keeps it.
- **`sail` joins `php`, `composer` and `artisan`** as a name of the shim; it forwards its arguments as typed.
- **The plain image's tools** (`rg`, `python3`, `pip3`, `make`, `unzip`, `rsync`) are added, and a test holds the two images' package lists together.
- **CI builds the laravel image** on a pull request that touches it and checks the toolchain, and **publishes it** for every `main` commit as `ghcr.io/<owner>/coach-aven-sandbox-laravel:sha-<commit>` (amd64), promoted to `vX.Y.Z` / `latest` with the bot — like the plain image. An installation pins a tag instead of building the image on its sandbox host by hand.
- **The spec gains the laravel image's contract**, and the plain image's Node major is corrected (24 since 2026-10-16; the spec said 22).

## Capabilities

### Modified Capabilities
- `sandbox-image`: the laravel image's toolchain and its publication, what its four Sail commands do before and after `vendor/` exists, the user Sail runs its commands as; the plain image's Node major.

## Impact

- **Rollout: bucket 1, an ungated bug fix.** Nothing in the bot changes, and nothing changes for an installation on merge or on a release: the laravel image is built and pinned per installation (`SANDBOX_IMAGE`, read at boot, or a project's `sandbox.image`), and a container keeps the image it was created from. A project gets the fix when its installation rebuilds the image, moves the pin, restarts the bot and removes the project's container (`docker rm proj-<slug>`; everything inside it goes with it).
- **Code:** `snapshot/Dockerfile`, `snapshot/shims/sail-shim.sh`, `src/sailshim.test.ts` (new), `.github/workflows/ci.yml`, `snapshot/README.md`, `docs/sandbox-drivers.md`, `docs/troubleshooting.md`, `docs/rollout.md`.
- **Out of scope:**
  - the system prompt's toolchain paragraph: it stays true, its fixtures do not move;
  - a project whose compose file leaves Sail's web process to supervisord: that process is uid 1337 whatever `APP_USER` says (`design.md`, Risks);
  - the inner dockerd's cgroup nesting under `--privileged` on a cgroup-v2 host — the bot's dockerd guard, its own change (`design.md`, Context);
  - the git identity of an installation that runs its own GitHub App.
