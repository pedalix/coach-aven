# The PLAIN sandbox image: Claude Code + git tooling + a small general toolchain (bash, git,
# gh, curl, jq, ssh, ripgrep, node 24/npm, python3/pip, make, unzip, rsync), no dockerd, no Sail.
# This list is the contract (OpenSpec `sandbox-image`): a project that needs more — PHP, say —
# gets it added HERE and the image rebuilt, never installed by hand into a running sandbox
# (housekeeping recycles containers; hand-installed packages vanish with them).
#
# For sandboxes that never run containers of their own and therefore need neither sysbox
# nor --privileged: an unprivileged `docker run` is enough, which is what makes this
# variant fit a personal CoachAven instance on a Mac mini (containers live in the macOS
# Linux VM) and any plain-code project. Multi-arch (amd64 + arm64): nothing here is
# arch-specific — node:24-alpine ships both, Claude Code installs from npm.
#
# Kept deliberately parallel to ../Dockerfile (same ARG, same apk set minus docker-only
# bits) so build-and-push.sh bakes one CLAUDE_CLI_VERSION into both variants and
# provisionTooling() finds the same layout. No ENTRYPOINT: the drivers start the
# container with their own `sleep` command and exec into it.
FROM node:24-alpine

RUN apk add --no-cache \
      bash \
      git \
      github-cli \
      curl \
      jq \
      openssh-client \
      ca-certificates \
      ripgrep \
      python3 \
      py3-pip \
      make \
      unzip \
      rsync

# Claude Code (the CLI). npm is the reliable install path on Alpine/musl (the native
# installer wants extra libs + a settings flag there, for no gain). Pinned to the fleet's
# CLAUDE_CLI_VERSION (build-and-push.sh passes it) — see src/cliversion.ts.
ARG CLAUDE_CLI_VERSION=2.1.292
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CLI_VERSION}

# The `sources` MCP server (src/sources/mcp.ts injects it for projects with a `sources` block):
# a dependency-free .mjs that queries the read-only replica mounted at /data/sources. Baked in
# so fresh sandboxes have it; provisionTooling() re-uploads it when the bot ships a newer one.
COPY sources-mcp.mjs /opt/aven/sources-mcp.mjs

# Same marker the drivers set via -e at run time; harmless here, handy when the image is
# poked at by hand.
ENV IS_SANDBOX=1
