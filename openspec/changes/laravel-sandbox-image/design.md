# Design

## Context

- **The sandbox.** The driver starts a container from the image with the entrypoint replaced by `sleep`; everything in it runs as root with umask 0022. The checkout is cloned by root. Before each turn the bot writes `<checkout>/auth.json` (0600) when the project has private Composer packages. With `"dind": true` the bot's guard starts the inner `dockerd`.
- **The shim today** (`snapshot/shims/sail-shim.sh`, symlinked as `php`, `composer`, `artisan`): it walks up from the working directory to a `vendor/bin/sail` and runs `vendor/bin/sail <command> <args>`. Without one, `composer` runs in `laravelsail/php83-composer:latest` with the working directory mounted, and the other two exit 127 with a message that says `sail up -d`. That mount is inside the sandbox's own Docker; the sandbox container itself has none.
- **Sail** runs `sail artisan|composer|php|npm|test …` as `docker compose exec -u "$APP_USER"`, by default its `sail` user. It sources the project's `.env` before applying that default, and reads `APP_USER` since 1.41.1 (2025-04-22); older releases hard-code `sail`. Its start script gives `sail` the caller's uid (`usermod -u $WWWUSER sail`), which fails for uid 0, so in a root sandbox `sail` stays uid 1337.
- **The system prompt** tells the agent the first steps of a Laravel checkout: `composer install`, copy `.env`, `sail up -d`.
- **Measured, 2026-11-09**, on a real application's lock file: 279 packages, resolved for PHP 8.4.1 up to (not including) 8.5 and six extensions.

  | Bootstrap container | Result of `composer install` |
  |---|---|
  | `laravelsail/php83-composer` (PHP 8.3.3), as the shim runs it | exit 2, 23 problems |
  | `composer:2` (PHP 8.5.12) | exit 2, 10 problems, all of them extensions |
  | `composer:2`, platform requirements ignored | exit 0, 279 installs, package discovery done |

  The last row was repeated in a sandbox started the way the driver starts one, as root on a root-owned checkout: 28 s, `vendor/` and `bootstrap/cache/*.php` root's. Then `sail up -d`, and Sail's commands in the same container under both users:

  | `APP_USER` | uid | Writes `.env`, `vendor/`, `storage/logs` | Reads the 0600 `auth.json` |
  |---|---|---|---|
  | `sail` (Sail's default) | 1337 | no — `artisan key:generate` fails on `laravel.log` and `.env` | no |
  | `root` (this change) | 0 | yes | yes |

  As root: `key:generate`, `composer install` inside Sail (plugins load, no super-user warning, `check-platform-reqs` all green), 95 migrations, `sail npm ci`, `sail npm run build`, and the login page answers 200.
- **Found on the way, not part of this change.** Under `--privileged` on a cgroup-v2 host the bot's guard starts `dockerd` in the container's root cgroup, and an inner container that asks for a memory limit fails (`cannot enter cgroupv2 "/sys/fs/cgroup/docker" with domain controllers`). `docker run -m 64m alpine true` reproduces it; after the nesting step of the image's own `dind` wrapper it exits 0. Sysbox sandboxes are not affected (checked on one). It is the guard's (`src/housekeeping.ts`), a change of its own.

## Decisions

### D1. The bootstrap container is `composer:2`, platform requirements ignored
Composer's official image carries the current Composer on the current PHP and is rebuilt continuously. `COMPOSER_IGNORE_PLATFORM_REQS=1` goes in as an environment variable, so every Composer command gets it and the shim parses no arguments.

A lock file is resolved for the PHP and the extensions of the project's own Sail container. No generic image matches it: the measured one needs PHP 8.4.1 or newer, below 8.5, and six extensions. Laravel's Sail documentation for an existing application (11.x) ran `composer install --ignore-platform-reqs` in a throwaway container for the same reason. The real check happens where the application runs: inside Sail, `composer check-platform-reqs` was green.

*Why not a newer `laravelsail/phpXX-composer`?* They are frozen builds: `php83` since March 2024, `php84` since November 2024, and there is none for 8.5. A frozen image is what broke.

*Why not pick the image from `composer.json`'s `require.php`?* It adds a parser to a shell shim and still misses the extensions.

*Why not pin a digest?* The pin would age the same way; the moving tag follows Composer and PHP, and platform requirements are ignored either way.

### D2. The project's scripts run; the arguments are not touched
`composer install` means the same before and after `vendor/` exists: scripts and plugins run, and the shim forwards the arguments as typed. Measured with scripts on, as an ordinary user and as root: package discovery completes on PHP 8.5 without the project's extensions.

*Why not add `--no-scripts`?* It makes the first install differ from every later one, and it leaves `bootstrap/cache` without the package manifest, which a web process that is not root cannot write later. A caller who wants it types it.

### D3. `APP_USER=root` on the image
Sail's intent is that its container user is the owner of the checkout; on a developer's machine it gets there by renumbering `sail`. In a root sandbox the owner is uid 0, and `APP_USER=root` is the knob Sail offers for its commands. It is an image `ENV` and not a line in the shim, so a direct `./vendor/bin/sail …` gets it too. A project's `.env` naming another `APP_USER` wins, because Sail sources `.env` first.

*Why not `chown` the checkout to uid 1337?* The bot and git work in it as root: git refuses a repository owned by someone else, and every file the agent writes would be root's again.

*Why not a sandbox user that is not root?* It changes every path and every seeded file of every installation for one image's sake.

### D4. `sail` is a fourth name of the shim
The 127 message and the system prompt already say `sail up -d`. As `sail` the shim runs `vendor/bin/sail <args>`; without a `vendor/bin/sail` it exits 127 like `php` and `artisan`. The message now says where to run `composer install`.

### D5. The plain image's tools, held by a test
`ripgrep`, `python3`, `py3-pip`, `make`, `unzip`, `rsync` join the `apk add` list. `src/sailshim.test.ts` parses both Dockerfiles and fails when the plain list has a package the laravel list lacks. `node` stays the base distribution's package (22 today, the plain image has 24): it runs Claude Code, and project JavaScript goes through `sail npm`.

### D6. CI builds the image on a pull request
A pull request that touches `snapshot/Dockerfile` or `snapshot/shims/` builds the image for `linux/amd64` and runs the tool check of the spec, like the plain image's job. Nothing is published: the laravel image stays an installation's own build.

## Risks / Trade-offs

- **The web process of a stock Sail project stays uid 1337.** Sail's supervisord starts it as `SUPERVISOR_PHP_USER`, `sail` by default, and in a root sandbox `sail` keeps uid 1337 (measured on Sail's stock runtime image). It cannot write the root-owned checkout (`storage/`, `bootstrap/cache`), before this change or after it. The remedy is the project's: `SUPERVISOR_PHP_USER: root` in the service's `environment` (measured: the process is then root; Laravel's Sail documentation names it for permission errors), or `chmod -R a+rwX storage bootstrap/cache`. A compose file with its own `command` already runs it as the caller. The image cannot set it: the variable has to be in the compose file.
- **A Sail older than 1.41.1 ignores `APP_USER`** and keeps today's behaviour. `laravel/sail` is a dev dependency; updating it is the remedy.
- **A script or a plugin that does not run on the newest PHP** fails the bootstrap after `vendor/` is installed. `composer install --no-scripts` (or `--no-plugins`) gets past it; after `sail up -d`, `composer install` runs again on the project's PHP.
- **Every Composer command before `vendor/` exists ignores platform requirements**, `require` and `update` included: they resolve without the project's platform. Rare (a checkout has its lock file), and the stderr line says whose PHP it is.
- **No `vendor/composer/platform_check.php` until Composer runs inside Sail.** Composer does not write it when platform requirements are ignored; the first `composer install` or `dump-autoload` in Sail does.
- **Files Sail's commands create are root's**, like the rest of the checkout. Outside a sandbox nothing changes: the variable exists only in the image.
- **An existing container keeps the image it was created from.** The fix reaches a project when its installation rebuilds the image, moves the pin and removes the container; what was inside (installed dependencies, the inner Docker's images and volumes) is rebuilt on the next turn.
