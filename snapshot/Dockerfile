# Thin-orchestrator project snapshot image.
#
# Base: docker:28-dind (Alpine + dockerd + compose plugin) — verified working as a
# Daytona snapshot on our self-hosted box (see ../../thin-orchestrator-handoff.md §8).
# Daytona injects its toolbox at runtime; we keep the stock dind ENTRYPOINT so dockerd
# still starts (that's what makes Laravel Sail / docker compose work inside the sandbox).
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
      openssh-client \
      ca-certificates

# Claude Code (the CLI). npm is the reliable install path on Alpine/musl; the native
# installer is glibc-oriented. Pin intentionally rather than tracking latest.
RUN npm install -g @anthropic-ai/claude-code

# Sail shims: bare `php`/`composer`/`artisan` forward into the Sail container.
COPY shims/sail-shim.sh /usr/local/bin/sail-shim
RUN chmod +x /usr/local/bin/sail-shim \
    && for c in php composer artisan; do ln -sf /usr/local/bin/sail-shim /usr/local/bin/$c; done

# Inherit docker:28-dind's ENTRYPOINT (dockerd-entrypoint.sh) — do NOT override it.
