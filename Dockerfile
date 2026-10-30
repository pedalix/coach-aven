# syntax=docker/dockerfile:1
# The bot's image (OpenSpec bot-image; container-deploy D5): the commit's tracked files, the dependencies of
# its lockfile, Node 24 and the host tools the code starts — git, the OpenSSH client, the Docker CLI, age
# and gitleaks. Nothing of any installation: no user, path, address or key of a box; those are the compose
# file's (infra/deploy/compose.yaml). It runs under whatever uid the runtime gives it, with or without a
# passwd entry (only the SSH transport needs one), and writes only under AVEN_DIR and HOME.
#
# Built by .github/workflows/image.yml for linux/amd64 and linux/arm64 from `git archive <commit>`, so even
# a local build sees tracked files only:
#   git archive HEAD | docker build -t coach-aven:dev -
#   docker run --rm coach-aven:dev --help
#
# The base is pinned by digest (Dependabot bumps it, .github/dependabot.yml). Debian rather than Alpine:
# sharp and esbuild publish glibc binaries per platform, and `npm ci` picks the right ones at build time.
FROM docker:29-cli@sha256:5e6baf67325a79f64ed3bed6863954d5e05d0f3d4e57cbdb14809346814bbfdb AS docker-cli
FROM zricethezav/gitleaks:v8.21.2@sha256:0e99e8821643ea5b235718642b93bb32486af9c8162c8b8731f7cbdc951a7f46 AS gitleaks

FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

# The host tools the code calls (design Context): git for the memory journals, the mirror job and the
# local-activity source; ssh for a remote sandbox host; age for the sources vault; the Docker CLI for
# sandboxes on the box's own Docker (SSHDOCKER_HOST=local); gitleaks for `orch sources audit`.
# Static binaries come from their official images, nothing from `curl | sh`.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git openssh-client age \
 && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=gitleaks /usr/bin/gitleaks /usr/local/bin/gitleaks

WORKDIR /app

# The dependency layer depends on the base image and these two files only: when the lockfile has not
# changed, it is the very same layer as in the previous image, and a box pulls only the code below.
# Dev dependencies included on purpose: tsx is the runtime loader, as in the systemd unit.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# The commit's tracked files (the build context is `git archive`; .dockerignore covers a working tree).
COPY . .

# After npm ci, or it would skip the dev dependencies. config.ts reads it for the error tracker's environment.
ENV NODE_ENV=production

LABEL org.opencontainers.image.title="coach-aven" \
      org.opencontainers.image.description="CoachAven — a chat coding agent driving per-project Claude Code sandboxes" \
      org.opencontainers.image.licenses="Apache-2.0"

# Unprivileged by default (the base image's `node`, uid 1000), so a bare `docker run` is not root. The compose
# file replaces it with the deployer's uid (container-deploy D3); a quickstart with any uid works too.
USER node

# The CLI, from any working directory: tsx by absolute path (`--import tsx` would resolve against the working
# directory, which is the installation directory here), in exec form so the container's SIGTERM reaches node.
ENTRYPOINT ["node", "--import", "/app/node_modules/tsx/dist/loader.mjs", "/app/src/cli.ts"]
