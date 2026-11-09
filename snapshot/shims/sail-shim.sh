#!/bin/sh
# sail-shim — forwards bare `php` / `composer` / `artisan` / `sail` to Laravel Sail.
#
# This image intentionally ships NO host PHP/Composer: the Laravel runtime lives
# inside the project's Sail containers at the project's own versions. Agents
# (and humans) keep typing `php artisan test` / `composer require` / `sail up -d`
# out of habit; this shim transparently routes those to the checkout's
# `./vendor/bin/sail` (`sail <args>` as typed, the others as `sail <cmd> <args>`).
#
# It is symlinked as /usr/local/bin/{php,composer,artisan,sail}. `node`/`npm` are NOT
# shimmed — Claude Code needs the real host node/npm. Use `sail npm` for project JS.
set -e
cmd=$(basename "$0")

# Walk up from CWD looking for a Sail binary (worktrees nest the project deeper).
dir=$(pwd)
while [ "$dir" != "/" ]; do
  if [ -x "$dir/vendor/bin/sail" ]; then
    if [ "$cmd" = "sail" ]; then exec "$dir/vendor/bin/sail" "$@"; fi
    exec "$dir/vendor/bin/sail" "$cmd" "$@"
  fi
  dir=$(dirname "$dir")
done

# No vendor/ yet. For `composer` we can still bootstrap via a throwaway container
# (this is how you get vendor/bin/sail to exist in the first place). That container is
# the official Composer image — the current Composer on the current PHP, NOT the project's
# PHP — so platform requirements are ignored: the lock file was resolved for the PHP and
# the extensions of the project's Sail container, which no generic image has. It is what
# Laravel's own recipe for an existing application did (`composer install
# --ignore-platform-reqs` in a throwaway container). Runs as the caller, so vendor/ is
# the caller's; the checkout's auth.json (private packages) is inside the mount.
if [ "$cmd" = "composer" ]; then
  echo "[sail-shim] no vendor/ yet — bootstrapping composer in a throwaway container (the Composer image, not the project's PHP: platform requirements are ignored; after 'sail up -d' composer runs inside Sail)" >&2
  exec docker run --rm \
    -u "$(id -u):$(id -g)" \
    -v "$(pwd):/var/www/html" \
    -w /var/www/html \
    -e COMPOSER_IGNORE_PLATFORM_REQS=1 \
    composer:2 \
    composer "$@"
fi

echo "[sail-shim] '$cmd': no vendor/bin/sail in this directory or above — this image has no host PHP, the runtime is the project's Sail." >&2
echo "[sail-shim] In the Laravel checkout: 'composer install' (it creates vendor/bin/sail), then 'sail up -d'; after that '$cmd' forwards into the container." >&2
exit 127
