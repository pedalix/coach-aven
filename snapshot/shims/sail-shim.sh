#!/bin/sh
# sail-shim — forwards bare `php` / `composer` / `artisan` to Laravel Sail.
#
# This image intentionally ships NO host PHP/Composer: the Laravel runtime lives
# inside the project's Sail containers at the project's own versions. Agents
# (and humans) keep typing `php artisan test` / `composer require` out of habit;
# this shim transparently routes those to `./vendor/bin/sail <cmd>` so they work.
#
# It is symlinked as /usr/local/bin/{php,composer,artisan}. `node`/`npm` are NOT
# shimmed — Claude Code needs the real host node/npm. Use `sail npm` for project JS.
set -e
cmd=$(basename "$0")

# Walk up from CWD looking for a Sail binary (worktrees nest the project deeper).
dir=$(pwd)
while [ "$dir" != "/" ]; do
  if [ -x "$dir/vendor/bin/sail" ]; then
    exec "$dir/vendor/bin/sail" "$cmd" "$@"
  fi
  dir=$(dirname "$dir")
done

# No vendor/ yet. For `composer` we can still bootstrap via a throwaway container
# (this is how you get vendor/bin/sail to exist in the first place).
if [ "$cmd" = "composer" ]; then
  echo "[sail-shim] no vendor/ yet — bootstrapping composer in a throwaway container" >&2
  exec docker run --rm \
    -u "$(id -u):$(id -g)" \
    -v "$(pwd):/var/www/html" \
    -w /var/www/html \
    laravelsail/php83-composer:latest \
    composer "$@"
fi

echo "[sail-shim] '$cmd' has no host install — this is a Sail (docker-compose) image." >&2
echo "[sail-shim] Bring the stack up first: 'composer install' then 'sail up -d', then '$cmd' forwards into the container." >&2
exit 127
