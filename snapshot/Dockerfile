# The project sandbox image.
#
# Base: docker:28-dind (Alpine + dockerd + compose plugin): the inner dockerd is what makes
# Laravel Sail / docker compose work inside the sandbox, so the container needs sysbox or
# --privileged on the sandbox host (docs/sandbox-drivers.md).
#
# Deliberately NO php / composer on the host: Sail runs the Laravel runtime inside the
# project's own containers at the project's own versions. node/npm ARE here, but only to
# run Claude Code (npm package) — project JS still goes through `sail npm`.
FROM docker:28-dind

RUN apk add --no-cache \
      bash \
      git \
      github-cli \
      nodejs \
      npm \
      curl \
      jq \
      imagemagick \
      openssh-client \
      ca-certificates

# Claude Code (the CLI). npm is the reliable install path on Alpine/musl (the native
# installer wants extra libs + a settings flag there, for no gain). Pinned to the fleet's
# CLAUDE_CLI_VERSION (build-and-push.sh passes it) so fresh sandboxes match what
# provisionTooling converges warm ones to — see src/cliversion.ts. (Runtime upgrades land
# in /root/.local, ahead of this copy on PATH: under sysbox /usr/local isn't writable.)
ARG CLAUDE_CLI_VERSION=2.1.292
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CLI_VERSION}

# Sail shims: bare `php`/`composer`/`artisan` forward into the Sail container.
COPY shims/sail-shim.sh /usr/local/bin/sail-shim
RUN chmod +x /usr/local/bin/sail-shim \
    && for c in php composer artisan; do ln -sf /usr/local/bin/sail-shim /usr/local/bin/$c; done

# docker:28-dind's ENTRYPOINT (dockerd-entrypoint.sh) stays for a plain `docker run` of the image.
# The sandbox driver replaces it with `sleep` and starts dockerd through its guard instead: at chat
# prep, and at the first warm-up after each start of the container (src/housekeeping.ts).
