# The PLAIN sandbox image: Claude Code + git tooling, no dockerd, no Sail.
#
# For sandboxes that never run containers of their own and therefore need neither sysbox
# nor --privileged: an unprivileged `docker run` is enough, which is what makes this
# variant fit a personal CoachAven instance on a Mac mini (containers live in the macOS
# Linux VM) and any plain-code project. Multi-arch (amd64 + arm64): nothing here is
# arch-specific — node:22-alpine ships both, Claude Code installs from npm.
#
# Kept deliberately parallel to ../Dockerfile (same ARG, same apk set minus docker-only
# bits) so build-and-push.sh bakes one CLAUDE_CLI_VERSION into both variants and
# provisionTooling() finds the same layout. No ENTRYPOINT: the drivers start the
# container with their own `sleep` command and exec into it.
FROM node:22-alpine

RUN apk add --no-cache \
      bash \
      git \
      github-cli \
      curl \
      jq \
      openssh-client \
      ca-certificates \
      ripgrep

# Claude Code (the CLI). npm is the reliable install path on Alpine/musl (the native
# installer wants extra libs + a settings flag there, for no gain). Pinned to the fleet's
# CLAUDE_CLI_VERSION (build-and-push.sh passes it) — see src/cliversion.ts.
ARG CLAUDE_CLI_VERSION=2.1.282
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CLI_VERSION}

# Same marker the drivers set via -e at run time; harmless here, handy when the image is
# poked at by hand.
ENV IS_SANDBOX=1
