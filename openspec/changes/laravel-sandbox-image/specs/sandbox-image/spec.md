# Spec Delta

## MODIFIED Requirements

### Requirement: Plain image toolchain
The plain sandbox image SHALL provide, on both `amd64` and `arm64`: `bash`, `git`, `gh`, `curl`, `jq`, `ssh`, `rg`, `node` (24), `npm`, `python3`, `pip` (as `pip3`), `make`, `unzip`, `rsync`, and the pinned Claude Code CLI. It SHALL NOT provide a Docker daemon.

#### Scenario: Tool check inside a fresh sandbox
- **WHEN** a sandbox is created from the plain image and `command -v` runs for each listed tool
- **THEN** every tool resolves, and `docker` does not

#### Scenario: Multi-arch build
- **WHEN** `snapshot/build-and-push.sh plain` runs with `PUSH=0`
- **THEN** the image builds for `linux/amd64` and `linux/arm64`

## ADDED Requirements

### Requirement: Laravel image toolchain
The laravel sandbox image SHALL provide, on `amd64`: `bash`, `git`, `gh`, `curl`, `jq`, `ssh`, `rg`, `node`, `npm`, `python3`, `pip` (as `pip3`), `make`, `unzip`, `rsync`, the pinned Claude Code CLI, `docker` with its daemon and the compose plugin, `magick`, and the commands `php`, `composer`, `artisan` and `sail`. It SHALL NOT provide a PHP or a Composer of its own.

#### Scenario: Tool check inside the built image
- **WHEN** the image is built from `snapshot/` and `command -v` runs for each listed tool and for `dockerd`
- **THEN** every one resolves, and `php`, `composer`, `artisan` and `sail` are the Sail shim

#### Scenario: A tool added to the plain image only
- **WHEN** a package joins the plain image's `apk add` list and not the laravel image's
- **THEN** `npm test` fails and names the package

### Requirement: The Sail commands forward into the checkout's Sail
With a `vendor/bin/sail` in the working directory or a directory above it, `sail <args>` SHALL run that file with the arguments as typed, and `php`, `composer` and `artisan` SHALL run it as `vendor/bin/sail <command> <args>`. Without one, `php`, `artisan` and `sail` SHALL run nothing, exit 127 and name the steps that bring the stack up.

#### Scenario: From a directory inside the checkout
- **WHEN** `php artisan test --parallel` runs in `app/Http` of a checkout that has `vendor/bin/sail`
- **THEN** that checkout's `vendor/bin/sail php artisan test --parallel` runs

#### Scenario: `sail` as typed
- **WHEN** `sail up -d` runs in a checkout that has `vendor/bin/sail`
- **THEN** `vendor/bin/sail up -d` runs, not `vendor/bin/sail sail up -d`

#### Scenario: Before the first `composer install`
- **WHEN** `sail up -d` or `php -v` runs in a checkout without `vendor/`
- **THEN** it exits 127 and its `[sail-shim]` lines say `composer install`, then `sail up -d`

### Requirement: Composer before `vendor/` exists
Without a `vendor/bin/sail` in the working directory or above, `composer <args>` SHALL run in a throwaway container of the official Composer image: as the calling user, with the working directory mounted, platform requirements ignored and the arguments exactly as typed. It SHALL say on stderr that this is not the project's PHP.

#### Scenario: A lock file resolved for the project's own PHP
- **WHEN** `composer install` runs in a fresh checkout whose lock file asks for a PHP version and extensions the Composer image does not have
- **THEN** the packages are installed, the project's Composer scripts run, `vendor/bin/sail` exists and `vendor/` belongs to the caller

#### Scenario: Arguments as typed
- **WHEN** `composer install --no-scripts` runs in a checkout without `vendor/`
- **THEN** the container runs `composer install --no-scripts`: nothing is added to or taken from the arguments

#### Scenario: Once `vendor/bin/sail` exists
- **WHEN** `composer install` runs in a checkout that has `vendor/bin/sail`
- **THEN** it runs inside Sail, on the project's PHP with its platform requirements checked, and no throwaway container starts

### Requirement: Sail runs its commands as the sandbox's user
The laravel image SHALL set `APP_USER=root`, so that Sail runs its commands in the application container as the user that owns the checkout. A project whose `.env` names another `APP_USER` SHALL keep it.

#### Scenario: A command that writes the checkout
- **WHEN** `sail artisan key:generate` runs in a checkout cloned by root, its files 0644
- **THEN** `.env` gets the key

#### Scenario: Private packages
- **WHEN** `composer install` runs inside Sail and the checkout's `auth.json` is readable by root only
- **THEN** Composer reads it

#### Scenario: A project's own choice
- **WHEN** the project's `.env` says `APP_USER=sail`
- **THEN** Sail runs its commands as `sail`

#### Scenario: A Sail older than 1.41.1
- **WHEN** the project's `laravel/sail` is older than 1.41.1, which does not read `APP_USER`
- **THEN** Sail runs its commands as its `sail` user, as before the change; updating `laravel/sail` is the remedy
