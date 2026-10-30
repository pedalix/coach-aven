#!/bin/sh
# CoachAven quickstart setup (docs/quickstart.md; OpenSpec quickstart D4). Run it from anywhere, as often as you like.
#
# It writes what it can learn from this machine and nothing you have to obtain:
#   - .env and projects.config.json from their examples, only when they are missing (yours are never touched);
#   - compose/.env, rewritten every time: the bot image of this clone's commit (its tag, else sha-<commit>),
#     your uid and gid, the Docker socket's group as a container sees it, and the web port (AVEN_WEB_PORT, 8787);
#   - home/, the bot's HOME.
# It never reads, writes or prints a token.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
cd "$here"

for f in .env projects.config.json; do
  case $f in .env) src=.env.example ;; *) src=projects.config.example.json ;; esac
  if [ -e "$f" ]; then
    echo "kept     $f"
  else
    cp "$src" "$f"
    chmod 600 "$f"
    echo "created  $f (from $src) — fill it in"
  fi
done
mkdir -p home

# The image of this very commit, so the bot and the sandbox's Dockerfile come from the same point.
if tag=$(git describe --tags --exact-match 2>/dev/null); then
  version=$tag
else
  version=sha-$(git rev-parse HEAD)
  echo "warning: this clone is not at a release tag; using $version, a canary build of main." >&2
  echo "         For a release: git checkout \$(git describe --tags --abbrev=0) and rerun ./init.sh" >&2
fi
image=ghcr.io/pedalix/coach-aven:$version

# The socket's group as a container sees it: on Docker Desktop the host's own `stat` reads a symlink, not that.
echo "pulling  $image (to ask Docker for the socket's group)"
docker pull -q "$image" >/dev/null
docker_gid=$(docker run --rm --entrypoint stat -v /var/run/docker.sock:/var/run/docker.sock "$image" -c %g /var/run/docker.sock)

port=${AVEN_WEB_PORT:-8787}
cat > compose/.env <<ENV
# Written by ../init.sh from this machine — rerun it rather than editing.
AVEN_VERSION=$version
AVEN_UID=$(id -u)
AVEN_GID=$(id -g)
DOCKER_GID=$docker_gid
AVEN_WEB_PORT=$port
ENV
echo "wrote    compose/.env ($version, uid $(id -u), docker group $docker_gid, port $port)"

cat <<NEXT

Next:
  1. Fill CLAUDE_CODE_OAUTH_TOKEN and GITHUB_TOKEN in $here/.env,
     and your repository in $here/projects.config.json.
  2. cd $here/compose && docker compose up -d
  3. docker compose logs bot | grep sign-in    — open that link
NEXT
