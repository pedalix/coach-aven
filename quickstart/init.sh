#!/bin/sh
# CoachAven quickstart setup (docs/quickstart.md; OpenSpec quickstart D4). Run it from anywhere, as often as you like.
#
# It writes what it can learn from this machine and nothing you have to obtain:
#   - .env and projects.config.json from their examples, only when they are missing (yours are never touched);
#   - compose/.env, rewritten every time: the bot image of this clone's commit (its tag, else sha-<commit>),
#     your uid and gid, the Docker socket's group as a container sees it, the web port (AVEN_WEB_PORT, 8787), and
#     SANDBOX_IMAGE when you set it (another sandbox image than the published one of the same version);
#   - the bot image and the sandbox image pulled, so the first answer does not wait for a download;
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
  head=$(git rev-parse HEAD 2>/dev/null) || { echo "error: $here is not in a git clone of CoachAven — clone it (docs/quickstart.md, step 1)" >&2; exit 1; }
  version=sha-$head
  echo "warning: this clone is not at a release tag; using $version, the image of a main commit (a canary build)." >&2
  echo "         For a release: git checkout \$(git describe --tags --abbrev=0) and rerun ./init.sh" >&2
fi
image=ghcr.io/pedalix/coach-aven:$version

docker version >/dev/null 2>&1 || { echo "error: Docker does not answer — start Docker (Docker Desktop, or the docker service) and rerun" >&2; exit 1; }
unpublished() {
  echo "error: $1 is not published — only release tags and main's commits have images." >&2
  echo "       Check out a release (git checkout \$(git describe --tags --abbrev=0)) or main, and rerun." >&2
  exit 1
}
# Both images now, so the first answer does not wait for a download.
echo "pulling  $image"
docker pull -q "$image" >/dev/null 2>&1 || unpublished "$image"
sandbox=${SANDBOX_IMAGE:-ghcr.io/pedalix/coach-aven-sandbox-plain:$version}
echo "pulling  $sandbox (the sandbox)"
case $sandbox in
  ghcr.io/*) docker pull -q "$sandbox" >/dev/null 2>&1 || unpublished "$sandbox" ;;
  *) docker image inspect "$sandbox" >/dev/null 2>&1 || { echo "error: no local image $sandbox — build it first" >&2; exit 1; } ;;
esac

# The socket's group as a container sees it: on Docker Desktop the host's own `stat` reads a symlink, not that.
docker_gid=$(docker run --rm --entrypoint stat -v /var/run/docker.sock:/var/run/docker.sock "$image" -c %g /var/run/docker.sock)
# The bot will run as you with that group: check now that it reaches Docker, rather than in the bot's log later.
docker run --rm --user "$(id -u):$(id -g)" --group-add "$docker_gid" -v /var/run/docker.sock:/var/run/docker.sock \
  --entrypoint docker "$image" version >/dev/null 2>&1 || {
  echo "error: a container running as uid $(id -u) with group $docker_gid cannot reach /var/run/docker.sock." >&2
  echo "       Rootless Docker, Podman and Colima are untested (docs/quickstart.md); report what you run." >&2
  exit 1
}

port=${AVEN_WEB_PORT:-8787}
cat > compose/.env <<ENV
# Written by ../init.sh from this machine — rerun it rather than editing.
AVEN_VERSION=$version
AVEN_UID=$(id -u)
AVEN_GID=$(id -g)
DOCKER_GID=$docker_gid
AVEN_WEB_PORT=$port
${SANDBOX_IMAGE:+SANDBOX_IMAGE=$SANDBOX_IMAGE}
ENV
echo "wrote    compose/.env ($version, uid $(id -u), docker group $docker_gid, port $port)"

cat <<NEXT

Next:
  1. Fill CLAUDE_CODE_OAUTH_TOKEN and GITHUB_TOKEN in $here/.env,
     and your repository in $here/projects.config.json.
  2. cd $here/compose && docker compose up -d
  3. docker compose logs bot | grep sign-in | tail -n 1    — open that link (a few seconds after the start)
NEXT
