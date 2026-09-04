#!/usr/bin/env bash
# Build the project snapshot image and push it to GHCR.
#
# Prereqs:
#   - docker available locally (this host has it via the `bluefin` user / your laptop)
#   - logged in to GHCR:  echo "$GHCR_PAT" | docker login ghcr.io -u <user> --password-stdin
#     (PAT needs write:packages; or a GitHub App token with packages:write)
#
# Usage:
#   ./build-and-push.sh                 # builds + pushes :<gitsha> and :latest
#   IMAGE=ghcr.io/foo/bar ./build-and-push.sh
set -euo pipefail
cd "$(dirname "$0")"

IMAGE="${IMAGE:-ghcr.io/bluefinorg/bluefin-sandbox-laravel}"
TAG="${TAG:-$(git rev-parse --short HEAD 2>/dev/null || echo manual)}"
# The Claude Code pin baked into the image: CLAUDE_CLI_VERSION from the environment, else
# the prod runtime .env, else the Dockerfile's own ARG default. Keep it equal to what the
# bot runs with, or fresh sandboxes will immediately re-install at their first chat prep.
CLI_PIN="${CLAUDE_CLI_VERSION:-$(grep -E '^CLAUDE_CLI_VERSION=' ../infra/prod/runtime/.env 2>/dev/null | cut -d= -f2- || true)}"

echo ">> building ${IMAGE}:${TAG} (Claude Code ${CLI_PIN:-Dockerfile default})"
# linux/amd64 explicitly — the Daytona runner box is amd64; building on an arm laptop
# would otherwise push an arm image the runner can't run.
docker buildx build \
  --platform linux/amd64 \
  ${CLI_PIN:+--build-arg CLAUDE_CLI_VERSION=$CLI_PIN} \
  -t "${IMAGE}:${TAG}" \
  -t "${IMAGE}:latest" \
  --push \
  .

echo ">> pushed ${IMAGE}:${TAG} and ${IMAGE}:latest"
echo ">> register it as a Daytona snapshot with: ../src cli snapshot:ensure (or POST /api/snapshots {imageName})"
