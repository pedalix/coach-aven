#!/usr/bin/env bash
# Build a sandbox image VARIANT and push it to GHCR.
#
# Variants (one directory per Dockerfile; `laravel` is the historical default and keeps
# its old image name, platform and tags so nothing that exists today changes):
#   laravel  — snapshot/Dockerfile: docker:28-dind + Sail shims, linux/amd64 only (the
#              Daytona runner / Hetzner sandbox host are amd64; dind needs sysbox or
#              --privileged on the host).
#   plain    — snapshot/plain/Dockerfile: no dockerd, no Sail, multi-arch
#              (linux/amd64 + linux/arm64) for unprivileged sandboxes — e.g. a personal
#              CoachAven instance on an Apple-silicon Mac mini, or any project that never
#              runs containers of its own. Needs the driver's `dind: false` to skip the
#              dockerd guard (see docs/sandbox-drivers.md).
#
# Prereqs:
#   - docker buildx available locally; multi-arch needs QEMU binfmt (docker buildx ls
#     lists linux/arm64) or a native arm builder
#   - logged in to GHCR:  echo "$GHCR_PAT" | docker login ghcr.io -u <user> --password-stdin
#     (PAT needs write:packages; or a GitHub App token with packages:write)
#
# Usage:
#   ./build-and-push.sh                   # laravel: builds + pushes :<gitsha> and :latest
#   ./build-and-push.sh plain             # plain variant (or VARIANT=plain)
#   IMAGE=ghcr.io/foo/bar ./build-and-push.sh plain          # your registry (ECR, GHCR of another org…)
#   ENV_FILE=../infra/<slug>/.env ./build-and-push.sh plain  # take CLAUDE_CLI_VERSION from that installation
#   PLATFORMS=linux/arm64 ./build-and-push.sh plain    # override the variant's platforms
#   PUSH=0 ./build-and-push.sh plain      # build only (validates the Dockerfile on every
#                                         # platform; nothing is pushed or loaded)
set -euo pipefail
cd "$(dirname "$0")"

VARIANT="${1:-${VARIANT:-laravel}}"
case "$VARIANT" in
  laravel)
    CONTEXT="."
    DEFAULT_IMAGE="ghcr.io/bluefinorg/bluefin-sandbox-laravel"
    DEFAULT_PLATFORMS="linux/amd64"
    ;;
  plain)
    CONTEXT="./plain"
    DEFAULT_IMAGE="ghcr.io/bluefinorg/bluefin-sandbox-plain"
    DEFAULT_PLATFORMS="linux/amd64,linux/arm64"
    ;;
  *)
    echo "unknown variant '$VARIANT' (known: laravel, plain)" >&2
    exit 2
    ;;
esac

IMAGE="${IMAGE:-$DEFAULT_IMAGE}"
PLATFORMS="${PLATFORMS:-$DEFAULT_PLATFORMS}"
PUSH="${PUSH:-1}"
TAG="${TAG:-$(git rev-parse --short HEAD 2>/dev/null || echo manual)}"
# The Claude Code pin baked into the image: CLAUDE_CLI_VERSION from the environment, else
# from ENV_FILE (an installation's runtime .env, e.g. ENV_FILE=../infra/<slug>/.env), else the
# Dockerfile's own ARG default. Keep it equal to what the bot runs with, or fresh sandboxes
# will immediately re-install at their first chat prep. Both variants take the same ARG so
# one pin serves the whole fleet.
CLI_PIN="${CLAUDE_CLI_VERSION:-$(grep -E '^CLAUDE_CLI_VERSION=' "${ENV_FILE:-/dev/null}" 2>/dev/null | cut -d= -f2- || true)}"

echo ">> building ${IMAGE}:${TAG} [variant=${VARIANT} platforms=${PLATFORMS}] (Claude Code ${CLI_PIN:-Dockerfile default})"
# Without --push buildx keeps the result in the build cache only: that is the point of
# PUSH=0 — prove the Dockerfile builds on every platform before touching the registry.
# (--load cannot take a multi-platform result, so a dry run deliberately loads nothing.)
docker buildx build \
  --platform "$PLATFORMS" \
  ${CLI_PIN:+--build-arg CLAUDE_CLI_VERSION=$CLI_PIN} \
  -t "${IMAGE}:${TAG}" \
  -t "${IMAGE}:latest" \
  $([ "$PUSH" = 1 ] && echo --push) \
  "$CONTEXT"

if [ "$PUSH" = 1 ]; then
  echo ">> pushed ${IMAGE}:${TAG} and ${IMAGE}:latest"
  [ "$VARIANT" = laravel ] && echo ">> register it as a Daytona snapshot with: ../src cli snapshot:ensure (or POST /api/snapshots {imageName})"
else
  echo ">> build-only run finished (PUSH=0): nothing pushed"
fi
