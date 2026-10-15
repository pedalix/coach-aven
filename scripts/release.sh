#!/usr/bin/env bash
# release: tag the current main, push the tag (→ CI verifies and publishes the GitHub Release),
# then start the deploy workflow in the ops repo for that tag. The hand-off is deliberately
# manual: no credential of the installation lives in this public repo — the person who tags
# starts the deploy with their own `gh` login (needs write access to OPS_REPO).
#
#   npm run release -- vX.Y.Z            # OPS_REPO=<owner/ops-repo> to target another installation
set -euo pipefail
TAG="${1:-}"
OPS_REPO="${OPS_REPO:-pedalix/coach-aven-ops}"
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: npm run release -- vX.Y.Z" >&2; exit 2; }
[[ "$(git rev-parse --abbrev-ref HEAD)" == "main" ]] || { echo "release from main, not $(git rev-parse --abbrev-ref HEAD)" >&2; exit 2; }
git fetch -q origin main
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || { echo "local main is not origin/main — pull or push first" >&2; exit 2; }
git tag "$TAG" && git push origin "$TAG"
echo "tagged $TAG — CI: $(gh repo view --json url -q .url)/actions"
gh workflow run deploy.yml -R "$OPS_REPO" -f "tag=$TAG"
echo "deploy started in $OPS_REPO — https://github.com/$OPS_REPO/actions"
