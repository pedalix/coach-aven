# Sandbox images

The tooling (git, gh, node, Claude Code and, in `laravel`, the Sail shims and imagemagick) is baked
into the image; the bot's `provisionTooling()` (`src/project.ts`) only tops up what the image lacks:
imagemagick where it is missing, and the Claude Code pin. Two variants, one directory per Dockerfile:

- **`laravel`** (`Dockerfile`): `docker:28-dind` + the plain image's tools + the Sail shims in `shims/`,
  linux/amd64 only. Needs sysbox or `--privileged` on the sandbox host: a project using it says
  `"sandbox": { "dind": true }`.
- **`plain`** (`plain/Dockerfile`): drops dockerd, builds amd64 + arm64 and runs unprivileged —
  for projects that never start containers of their own, and for arm64 hosts. A project without a
  `sandbox` block runs this way (`docs/sandbox-drivers.md`).

Build and push with `build-and-push.sh` (usage and prerequisites in its header):

```bash
IMAGE=ghcr.io/<your-org>/coach-aven-sandbox-laravel ./build-and-push.sh        # laravel
IMAGE=ghcr.io/<your-org>/coach-aven-sandbox-plain   ./build-and-push.sh plain  # plain
```

You rarely need the script: this repository's CI publishes both variants of every `main` commit and release, under the
same version names as the bot image — `ghcr.io/pedalix/coach-aven-sandbox-plain:sha-<commit>` / `:vX.Y.Z` (the
quickstart's sandbox, `docs/quickstart.md`) and `ghcr.io/pedalix/coach-aven-sandbox-laravel:sha-<commit>` / `:vX.Y.Z`.
Both packages are public, so a sandbox host pulls them without a login. Anything more (another language runtime, a
database client) is an image of your own, built with the script: the image repo is then the installation's, and `IMAGE`
is required for a push. Point `SANDBOX_IMAGE` (the installation's default) or a project's `sandbox.image` at a
`:sha-<commit>` or `:vX.Y.Z` tag (or the `:<gitsha>` tag your own build prints), not `:latest`. The laravel image goes
with `"dind": true`; the plain one needs no `sandbox` block.

A container keeps the image it was created from. To give a project a newer image, move the pin, restart the bot (`SANDBOX_IMAGE` is
read at boot) and `docker rm -v proj-<slug>` on the sandbox host: the next turn creates the container from the new
image and clones again; what was inside the old one (installed dependencies, the inner Docker's images and volumes) is
gone. `-v` matters for the laravel image: its base declares a volume for `/var/lib/docker`, so the inner Docker's
store is an anonymous volume on the host, and a plain `docker rm` leaves it behind.

The Claude Code CLI inside sandboxes is pinned by `CLAUDE_CLI_VERSION` (warm sandboxes converge in
place; `"cliVersion"` per project is the canary) — see `src/cliversion.ts`. Pin only probed versions
(`PROBED_CLI_VERSIONS`): a bump starts with `npm run cli-probe -- run --cli <version>` and its report
(`docs/cli-probe.md`). The image build refuses an unprobed version and the repo's gate test holds the
Dockerfiles' and `.env.example`'s defaults to the set; the bot itself checks only the `x.y.z` shape,
so an installation's `.env` and a project's `cliVersion` are on the operator's honour.

Why no PHP/Composer in the image: with Sail, the Laravel runtime lives in the project's own
containers at the project's own versions; bare `php`/`composer`/`artisan`/`sail` are the shim
(`shims/sail-shim.sh`), which forwards into the checkout's `vendor/bin/sail` (OpenSpec `sandbox-image`):

- **Before `vendor/` exists**, `composer …` runs in a throwaway container of the official Composer image
  (`composer:2`), as the caller, with platform requirements ignored and the arguments as typed: the lock file was
  resolved for the PHP and the extensions of the project's Sail container, which no generic image has. That is the
  first `composer install`, the one that creates `vendor/bin/sail`; after `sail up -d` Composer runs inside Sail, on
  the project's PHP. Until `vendor/bin/sail` exists, `php`, `artisan` and `sail` exit 127 and name the steps.
- **Sail runs its commands as root.** The image sets `APP_USER=root`: the sandbox and its checkout are root's, and
  Sail's own `sail` user (uid 1337) could neither write the checkout nor read the `auth.json` the bot writes for
  private packages. A project's `.env` naming another `APP_USER` wins; a `laravel/sail` older than 1.41.1 does not
  read the variable. The web process of a stock Sail compose file is another matter: supervisord starts it as
  `SUPERVISOR_PHP_USER` (`sail`), which the project sets to `root` on the service when that process must write
  `storage/`.
