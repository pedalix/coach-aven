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

# The plain image's tool list (../plain/Dockerfile — the contract is OpenSpec `sandbox-image`) plus
# imagemagick; docker and the compose plugin come with the base.
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
      ca-certificates \
      ripgrep \
      python3 \
      py3-pip \
      make \
      unzip \
      rsync

# Claude Code (the CLI). npm is the reliable install path on Alpine/musl (the native
# installer wants extra libs + a settings flag there, for no gain). Pinned to the fleet's
# CLAUDE_CLI_VERSION (build-and-push.sh passes it) so fresh sandboxes match what
# provisionTooling converges warm ones to — see src/cliversion.ts. (Runtime upgrades land
# in /root/.local, ahead of this copy on PATH: under sysbox /usr/local isn't writable.)
ARG CLAUDE_CLI_VERSION=2.1.314
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CLI_VERSION}

# Sail shims: bare `php`/`composer`/`artisan`/`sail` forward into the checkout's Sail.
COPY shims/sail-shim.sh /usr/local/bin/sail-shim
RUN chmod +x /usr/local/bin/sail-shim \
    && for c in php composer artisan sail; do ln -sf /usr/local/bin/sail-shim /usr/local/bin/$c; done

# Sail runs `sail artisan|composer|php|npm|test …` in the app container as $APP_USER — by default
# its `sail` user, uid 1337. The sandbox and its checkout are root's, so uid 1337 can neither write
# the checkout (.env, storage/, vendor/) nor read the 0600 auth.json the bot seeds for private
# composer packages. Root in the app container is the user that owns the files outside it. Set on
# the image, not in the shim, so a direct `./vendor/bin/sail …` gets it too; a project's own .env
# still wins (Sail sources it before applying its default). Sail reads APP_USER since 1.41.1
# (April 2025); an older one always uses its `sail` user.
ENV APP_USER=root

# docker:28-dind's ENTRYPOINT (dockerd-entrypoint.sh) stays for a plain `docker run` of the image.
# The sandbox driver replaces it with `sleep` and starts dockerd through its guard instead: at chat
# prep, and at the first warm-up after each start of the container (src/housekeeping.ts).
