#!/usr/bin/env bash
# CoachAven — scripted deploy of ONE installation onto a Linux box over ssh (OpenSpec container-deploy):
# the published image (ghcr.io/<owner>/coach-aven) run by `docker compose` in REMOTE_DIR/compose as the
# deployer. A deploy names a version and uploads nothing; a rollback is the same command with the earlier
# version. The bot is a tiny control plane — one process driving the project sandboxes; no nginx, no TLS
# here (Socket Mode dials OUT; Teams and the web chat listen on loopback behind the host's proxy).
#
# Usage:  infra/deploy/deploy.sh <slug> <command>      (npm run ops -- <slug> <command>)
#
# <slug> names the INSTALLATION: your ops repo checked out at infra/<slug>/ (a git
# checkout holding deploy.env, .env, the GitHub App key, projects.config.json, projects.d/;
# see infra/deploy/README.md). Several installations sit side by side under infra/; there
# is deliberately no default — the one you did not name is the one you would deploy by
# mistake. No slug, or one without infra/<slug>/deploy.env, prints this help and the slugs found.
#
#   install        Root stage: create REMOTE_DIR (deployer-owned). Deployer stage: check Docker Engine,
#                  the Compose plugin and the deployer's docker-group membership, create the deployer's
#                  ~/.config/coach-aven, render REMOTE_DIR/compose/compose.yaml — and start nothing.
#   export         Upload the runtime files the app needs at REMOTE_DIR: .env,
#                  github-app-private-key.pem, projects.config.json, projects.d/, and when
#                  present mirrors.json and hub.peers.json — read
#                  from infra/<slug>/. Refuses while that checkout is dirty, pushes it
#                  first, then uploads. Run once, and again on any change. NEVER touches
#                  state.json.
#   import         The reverse: download the box's live runtime files into the ops
#                  checkout and show the drift as `git status` for you to commit. (alias: pull)
#   deploy <version>
#                  vX.Y.Z, or sha-<commit> on a canary (CANARY=1); refused while a systemd unit of an
#                  earlier release is still active; docker pull → pin the version in REMOTE_DIR/compose/.env
#                  → docker compose up -d → wait 90 s for the driver's "bot running" line → one line in
#                  REMOTE_DIR/deploys.log; red when the line does not come. Rollback = deploy <earlier
#                  version> (its image is still on the box).
#   logs [-f]      The bot's log (docker compose logs).
#   status         The pinned version, the containers, the last deploys.
#   start|stop|restart  Lifecycle; restart = up -d --force-recreate + the same wait.
#   ssh            Interactive SSH session (deployer).
#   down           docker compose down (the images, the pin and the files stay).
#
# First run order:  install → export → deploy <version>
# Update code:      deploy <version>
# Rotate secrets:   export → restart
# Sync from box:    import   (pull the box's runtime back into infra/<slug>/)
# An installation still on the systemd deploy of v0.44.0 or earlier moves with the checklist in
# infra/deploy/README.md; this script no longer installs or deploys that path (OpenSpec retire-systemd-deploy).
#
# Config: infra/<slug>/deploy.env (DEPLOY_HOST, DEPLOY_USER, ROOT_USER, REMOTE_DIR, SERVICE_NAME; optional
# CHAT_DRIVER=slack|teams|web, CANARY=1, IMAGE, DAEMON_LISTEN — copy from ops.example/deploy.env.example).
# CHAT_DRIVER is the run command (`orch <driver>`); absent = slack. A leftover RUNTIME=compose is accepted,
# RUNTIME=systemd refused. SSH uses your default keys/agent (deployer@HOST, and root@HOST for install).
# Needs: ssh, scp, tar.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
# The installation's truth: a git checkout of its private OPS REPO at infra/<slug>/ (the
# whole of infra/ is gitignored except deploy/ and teams/; template in ops.example/).
# SEPARATE from the repo-root files, which are your LOCAL DEV runtime. `export` pushes the
# checkout and uploads it to the box; `import` pulls the box's copies back into it so the
# repo always records what the box runs. Secrets (.env, the App key) live in the checkout
# but are ignored by its .gitignore — they travel by scp only. deploy.env (the target) is
# tracked there and only read here.
SLUG="${1:-}"
RUNTIME_DIR="$REPO_ROOT/infra/$SLUG"
ENV_FILE="$RUNTIME_DIR/deploy.env"
# The runtime files the app needs at REMOTE_DIR (uploaded by export, pulled by import).
RUNTIME_FILES=(.env github-app-private-key.pem projects.config.json)
# Optional runtime SUBDIRS, synced recursively when present: projects.d/ holds the
# per-project system prompts (projects.d/<slug>.md — see docs/runtime-config.md).
# Note export copies over (scp, not rsync --delete): a file deleted locally lingers on
# the box, which is harmless — the loader ignores files for unknown slugs.
RUNTIME_DIRS=(projects.d)
# Optional runtime FILES, uploaded/pulled only when present: mirrors.json is the repo-mirror
# list `orch mirror` reads (docs/runtime-config.md → *Repo mirrors*); hub.peers.json pins the
# public keys of the installations this one messages through the hub (agent messaging,
# src/messaging/peers.ts). The installation's own private key (HUB_KEY_PATH) never travels.
OPTIONAL_RUNTIME_FILES=(mirrors.json hub.peers.json)

usage() { grep -E '^#( |$)' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
# Installations present = infra/*/ directories that carry a deploy.env (an overlay without
# one is half-set-up and not deployable; deploy/ and teams/ are the public tooling).
overlays() { for d in "$REPO_ROOT"/infra/*/; do [[ -f "$d/deploy.env" ]] && basename "$d"; done; }

log()  { printf '\033[1;36m▶ %s\033[0m\n' "$*" >&2; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*" >&2; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }

# The ops checkout must exist and be a git repo; export additionally wants it clean
# and pushed, so the repo — not a laptop — is the record of what the box got.
overlay_check() {
  [[ -d "$RUNTIME_DIR/.git" || -f "$RUNTIME_DIR/.git" ]] \
    || die "$RUNTIME_DIR is not a git checkout — clone your ops repo there:
    git clone <your-ops-repo-url> $RUNTIME_DIR
  (start one from $HERE/ops.example/ — see infra/deploy/README.md)"
}
overlay_push() {
  if [[ -n "$(git -C "$RUNTIME_DIR" status --porcelain)" ]]; then
    git -C "$RUNTIME_DIR" status --short >&2
    die "ops checkout is dirty — commit it first (git -C $RUNTIME_DIR commit -a), then export"
  fi
  git -C "$RUNTIME_DIR" push -q || die "push of the ops checkout failed — set its upstream (git -C $RUNTIME_DIR push -u origin main) and retry"
  ok "ops repo pushed ($(git -C "$RUNTIME_DIR" rev-parse --short HEAD))"
}

load_env() {
  [[ -f "$ENV_FILE" ]] || die "no $ENV_FILE — copy $HERE/ops.example/deploy.env.example there and fill it in"
  set -a; # shellcheck disable=SC1090
  source "$ENV_FILE"; set +a
  : "${DEPLOY_HOST:?}" "${DEPLOY_USER:?}" "${ROOT_USER:?}" "${REMOTE_DIR:?}" "${SERVICE_NAME:?}"
  # The chat driver this installation runs — one of the build's (src/chat/drivers.ts). The
  # unit's ExecStart and the deploy health check follow it; absent = slack, today's shape.
  CHAT_DRIVER="${CHAT_DRIVER:-slack}"
  case "$CHAT_DRIVER" in
    slack) HEALTH_LINE='Slack bot running' ;;
    teams) HEALTH_LINE='Teams bot running' ;;
    web) HEALTH_LINE='Web chat running' ;;
    *) die "CHAT_DRIVER must be one of: slack, teams, web (got '$CHAT_DRIVER')" ;;
  esac
  # One runtime: the published image under docker compose (OpenSpec container-deploy). RUNTIME is retired
  # (retire-systemd-deploy): a leftover `RUNTIME=compose` is accepted; `systemd` names the path that left with
  # v0.44.0 — an installation still on it moves with the checklist in infra/deploy/README.md.
  case "${RUNTIME:-compose}" in
    compose) ;;
    systemd) die "RUNTIME=systemd in $ENV_FILE: the systemd unit and the tar deploy retired after v0.44.0 (OpenSpec retire-systemd-deploy) — move the installation with the checklist in infra/deploy/README.md, then drop the line" ;;
    *) die "RUNTIME must be compose or absent (got '$RUNTIME' in $ENV_FILE)" ;;
  esac
  # CANARY=1 marks the installation that runs main: only it accepts a commit's image (sha-<commit>).
  CANARY="${CANARY:-}"
  # The image repository (compose): the product's package, or a fork's own.
  IMAGE="${IMAGE:-ghcr.io/pedalix/coach-aven}"
  # The sources daemon's listen address (compose): set → a second container runs `sources daemon` there.
  DAEMON_LISTEN="${DAEMON_LISTEN:-}"
  DEPLOYER="${DEPLOY_USER}@${DEPLOY_HOST}"
  ROOT="${ROOT_USER}@${DEPLOY_HOST}"
  # Keepalive: a `docker pull` of a new version can run a minute or more with no output, and an idle SSH
  # session can get dropped by a NAT/firewall in between ("client_loop: send disconnect: Broken pipe" killed
  # the v0.37.0 tar deploy mid-install). A probe every 30s, up to 10 missed, keeps the session alive.
  SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10
            -o ServerAliveInterval=30 -o ServerAliveCountMax=10)
}

dssh() { ssh "${SSH_OPTS[@]}" "$DEPLOYER" "$@"; }
rssh() { ssh "${SSH_OPTS[@]}" "$ROOT" "$@"; }

# Day-2 ops (export/import/deploy) only need the deployer; root is required just for
# install (REMOTE_DIR). Split so a deployer-only caller
# — notably CI, which must NOT hold a root key — can deploy without a root login.
preflight_deployer() {
  dssh "echo ok" </dev/null >/dev/null 2>&1 || die "cannot SSH as $DEPLOYER (need deployer for files + service)"
}
preflight_root() {
  rssh "echo ok" </dev/null >/dev/null 2>&1 || die "cannot SSH as $ROOT (need root to create REMOTE_DIR)"
}

# ---- commands ---------------------------------------------------------------
# export: upload the overlay (the installation's truth) → the box.
cmd_export() {
  preflight_deployer
  overlay_check
  local missing=0
  for f in "${RUNTIME_FILES[@]}"; do
    [[ -f "$RUNTIME_DIR/$f" ]] || { warn "missing $RUNTIME_DIR/$f"; missing=1; }
  done
  [[ "$missing" == 0 ]] || die "fill in the runtime files first (cp from ops.example/, or run: import)"
  overlay_push

  log "Uploading runtime ($RUNTIME_DIR) → $DEPLOYER:$REMOTE_DIR"
  dssh "mkdir -p $REMOTE_DIR"
  for f in "${RUNTIME_FILES[@]}"; do
    scp "${SSH_OPTS[@]}" -q "$RUNTIME_DIR/$f" "$DEPLOYER:$REMOTE_DIR/$f"
  done
  for f in "${OPTIONAL_RUNTIME_FILES[@]}"; do
    if [[ -f "$RUNTIME_DIR/$f" ]]; then scp "${SSH_OPTS[@]}" -q "$RUNTIME_DIR/$f" "$DEPLOYER:$REMOTE_DIR/$f"; fi
  done
  for d in "${RUNTIME_DIRS[@]}"; do
    if [[ -d "$RUNTIME_DIR/$d" ]]; then
      # tar over ssh, not `scp -r dir/.` — modern scp rejects the trailing `/.` form.
      tar -C "$RUNTIME_DIR" -cf - "$d" | dssh "tar -C $REMOTE_DIR -xf -"
    fi
  done
  dssh "chmod 600 $REMOTE_DIR/.env $REMOTE_DIR/github-app-private-key.pem"
  ok "runtime in place (state.json left untouched) — run: restart"
}

# import (pull): download the box's live runtime files → here, so $RUNTIME_DIR mirrors
# the box. The reverse of export. state.json is server-owned and deliberately NOT pulled.
cmd_import() {
  preflight_deployer
  overlay_check
  log "Downloading runtime from $DEPLOYER:$REMOTE_DIR → $RUNTIME_DIR"
  for f in "${RUNTIME_FILES[@]}"; do
    if dssh "test -f $REMOTE_DIR/$f" </dev/null; then
      scp "${SSH_OPTS[@]}" -q "$DEPLOYER:$REMOTE_DIR/$f" "$RUNTIME_DIR/$f"
    else
      warn "no $REMOTE_DIR/$f on the box — skipped"
    fi
  done
  for f in "${OPTIONAL_RUNTIME_FILES[@]}"; do
    if dssh "test -f $REMOTE_DIR/$f" </dev/null; then
      scp "${SSH_OPTS[@]}" -q "$DEPLOYER:$REMOTE_DIR/$f" "$RUNTIME_DIR/$f"
    fi
  done
  for d in "${RUNTIME_DIRS[@]}"; do
    if dssh "test -d $REMOTE_DIR/$d" </dev/null; then
      dssh "tar -C $REMOTE_DIR -cf - $d" </dev/null | tar -C "$RUNTIME_DIR" -xf -
    fi
  done
  chmod 600 "$RUNTIME_DIR/.env" "$RUNTIME_DIR/github-app-private-key.pem" 2>/dev/null || true
  ok "runtime pulled into $RUNTIME_DIR"
  if [[ -n "$(git -C "$RUNTIME_DIR" status --porcelain)" ]]; then
    git -C "$RUNTIME_DIR" status --short >&2
    warn "the box differs from the ops repo — review, then: git -C $RUNTIME_DIR commit -am 'import from box' && git -C $RUNTIME_DIR push"
  else
    ok "ops repo already matches the box"
  fi
}

# ---- the runtime (OpenSpec container-deploy, design D3/D4/D7/D8) --------------
# A version as the operator names it (D7): vX.Y.Z, or sha-<40 hex> on a canary. Prints the release the
# error tracker gets (vX.Y.Z, or main@<7 hex>); dies on anything else — latest above all, because what runs
# must be nameable.
version_release() {
  local v="$1"
  if [[ "$v" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then printf '%s' "$v"; return; fi
  if [[ "$v" =~ ^sha-[0-9a-f]{40}$ ]]; then
    [[ "$CANARY" == 1 ]] || die "refusing $v: a main commit's image deploys only on a canary installation (CANARY=1 in $ENV_FILE); a release installation takes vX.Y.Z"
    printf 'main@%s' "${v:4:7}"; return
  fi
  die "refusing '$v': a version is vX.Y.Z, or sha-<commit> (40 hex) on a canary — never latest or a branch, so that what runs is nameable"
}

# The compose file for this installation (template: compose.yaml). Arguments are what the box says:
# the deployer's uid, gid and home, where the sandboxes run (local = the box's Docker socket and its group;
# anything else = the deployer's .ssh), the socket's gid, and which optional home files exist (netrc).
render_compose() {
  local uid="$1" gid="$2" home="$3" where="$4" sockgid="$5" present="${6:-}"
  local daemon=0 socket=0 sshkeys=0 netrc=0
  [[ -n "$DAEMON_LISTEN" ]] && daemon=1
  if [[ "$where" == local ]]; then socket=1; else sshkeys=1; fi
  [[ ",$present," == *,netrc,* ]] && netrc=1
  sed -e "s#__SERVICE__#${SERVICE_NAME}#g" \
      -e "s#__IMAGE__#${IMAGE}#g" \
      -e "s#__DIR__#${REMOTE_DIR}#g" \
      -e "s#__UID__#${uid}#g" \
      -e "s#__GID__#${gid}#g" \
      -e "s#__HOME__#${home}#g" \
      -e "s#__DRIVER__#${CHAT_DRIVER}#g" \
      -e "s#__DAEMON_LISTEN__#${DAEMON_LISTEN}#g" \
      -e "s#__DOCKER_GID__#${sockgid}#g" \
      "$HERE/compose.yaml" \
  | awk -v daemon="$daemon" -v socket="$socket" -v ssh="$sshkeys" -v netrc="$netrc" '
      BEGIN { keep["daemon"] = daemon; keep["socket"] = socket; keep["ssh"] = ssh; keep["netrc"] = netrc }
      {
        line = $0
        if (sub(/[[:space:]]*# @[a-z]+$/, "", line)) {   # a tagged line: kept without its tag, or dropped
          tag = $0; sub(/.*# @/, "", tag)
          if (keep[tag]) print line
          next
        }
        print
      }'
}

# SSHDOCKER_HOST of the installation, never printed: the box's .env when it is there, else the overlay's
# own copy (a first install, before export). It decides the socket or the keys (D4).
sshdocker_host() {
  local v=""
  v="$(dssh "test -f $REMOTE_DIR/.env && grep -E '^SSHDOCKER_HOST=' $REMOTE_DIR/.env | tail -1 | cut -d= -f2-" </dev/null 2>/dev/null || true)"
  if [[ -z "$v" && -f "$RUNTIME_DIR/.env" ]]; then v="$(grep -E '^SSHDOCKER_HOST=' "$RUNTIME_DIR/.env" | tail -1 | cut -d= -f2- || true)"; fi
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  [[ -n "$v" ]] || die "SSHDOCKER_HOST is not set in the installation's .env ($REMOTE_DIR/.env on the box, or $RUNTIME_DIR/.env): the compose file needs it — local = the box's Docker socket, anything else = the deployer's ssh keys"
  printf '%s' "$v"
}

cmd_install() {
  preflight_root
  preflight_deployer
  [[ -f "$HERE/compose.yaml" ]] || die "missing $HERE/compose.yaml"

  log "Root stage: preparing $REMOTE_DIR (owned by $DEPLOY_USER)"
  rssh "mkdir -p $REMOTE_DIR && chown $DEPLOY_USER:$DEPLOY_USER $REMOTE_DIR"

  log "Checking the box: Docker Engine with the Compose plugin, the deployer in the docker group"
  # One session, one line of facts: what is missing, the uid/gid/home, the socket's group, the optional
  # home files — and the deployer's ~/.config/coach-aven created 0700 when missing (Docker would create a
  # missing mount source as root, and the bot could not write there).
  local facts
  facts="$(dssh bash -s </dev/null <<'REMOTE'
set -u
missing=""
command -v docker >/dev/null 2>&1 || missing="$missing docker-cli"
id -nG | tr ' ' '\n' | grep -qx docker || missing="$missing docker-group"
if [[ -z "$missing" ]]; then
  docker version --format '{{.Server.Version}}' >/dev/null 2>&1 || missing="$missing docker-engine"
  docker compose version >/dev/null 2>&1 || missing="$missing compose-plugin"
fi
present=""
[[ -f "$HOME/.netrc" ]] && present="$present,netrc"
sockgid="$(stat -c %g /var/run/docker.sock 2>/dev/null || echo 0)"
mkdir -p -m 700 "$HOME/.config/coach-aven" && chmod 700 "$HOME/.config/coach-aven"
printf 'missing=%s\nuid=%s\ngid=%s\nhome=%s\nsockgid=%s\npresent=%s\n' "${missing# }" "$(id -u)" "$(id -g)" "$HOME" "$sockgid" "${present#,}"
REMOTE
)"
  local missing uid gid home sockgid present
  missing="$(sed -n 's/^missing=//p' <<<"$facts")"
  uid="$(sed -n 's/^uid=//p' <<<"$facts")"; gid="$(sed -n 's/^gid=//p' <<<"$facts")"
  home="$(sed -n 's/^home=//p' <<<"$facts")"; sockgid="$(sed -n 's/^sockgid=//p' <<<"$facts")"
  present="$(sed -n 's/^present=//p' <<<"$facts")"
  [[ -n "$uid" && -n "$gid" && -n "$home" ]] || die "could not read the deployer's uid/gid/home on the box"
  if [[ -n "$missing" ]]; then
    die "the box is not ready for the compose runtime — missing: $missing
  docker-cli / docker-engine: install Docker Engine (https://docs.docker.com/engine/install/)
  compose-plugin:             the docker-compose-plugin package (docker compose version)
  docker-group:               usermod -aG docker $DEPLOY_USER (the group is root-equivalent on the box: that is the deployer's position on a compose installation)"
  fi
  local where
  where="$(sshdocker_host)"
  local sandboxes="on another host (the deployer's ~/.ssh mounted read-only, no Docker socket)"
  [[ "$where" == local ]] && sandboxes="on the box's own Docker (the socket and its group, no ssh keys)"
  log "Rendering compose.yaml: service=$SERVICE_NAME image=$IMAGE driver=$CHAT_DRIVER user=$uid:$gid home=$home sandboxes $sandboxes${DAEMON_LISTEN:+, daemon on $DAEMON_LISTEN}${present:+, home files: $present}"
  render_compose "$uid" "$gid" "$home" "$where" "$sockgid" "$present" \
    | dssh "mkdir -p $REMOTE_DIR/compose && cat > $REMOTE_DIR/compose/compose.yaml"
  ok "$REMOTE_DIR/compose/compose.yaml rendered, nothing started — run export (first time), then deploy <version>"
}

# The script that runs on the box as the deployer, in REMOTE_DIR/compose. `deploy`: refuse while the unit is
# active, pull (a failed pull changes nothing), write the pin, up -d, wait for the driver's line, one line in
# deploys.log, red when the line does not come. `restart`: up -d --force-recreate and the same wait.
remote_script() {
  local what="$1" version="${2:-}" release="${3:-}"
  cat <<REMOTE
set -euo pipefail
cd "$REMOTE_DIR/compose" 2>/dev/null || { echo "✗ no $REMOTE_DIR/compose on the box — run: deploy.sh $SLUG install" >&2; exit 1; }
REMOTE
  if [[ "$what" == deploy ]]; then
    cat <<REMOTE
if systemctl is-active --quiet "${SERVICE_NAME}.service" 2>/dev/null; then
  echo "✗ the systemd unit ${SERVICE_NAME}.service is active and would share the ports — stop and disable it first, as root: systemctl disable --now ${SERVICE_NAME}.service (and the daemon's unit, if any), then deploy again" >&2
  exit 1
fi
echo "▶ docker pull $IMAGE:$version"
docker pull --quiet "$IMAGE:$version" >/dev/null
printf 'AVEN_VERSION=%s\\nAVEN_RELEASE=%s\\n' "$version" "$release" > .env
start="\$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "▶ docker compose up -d ($version)"
docker compose up -d
REMOTE
  else
    cat <<REMOTE
version="\$(sed -n 's/^AVEN_VERSION=//p' .env)"
start="\$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "▶ docker compose up -d --force-recreate (\$version)"
docker compose up -d --force-recreate
REMOTE
  fi
  cat <<REMOTE
for i in \$(seq 1 45); do
  if docker compose logs --no-log-prefix --since "\$start" bot 2>/dev/null | grep -q '$HEALTH_LINE'; then
REMOTE
  if [[ "$what" == deploy ]]; then
    cat <<REMOTE
    printf '%s %s ok\\n' "\$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$version" >> "$REMOTE_DIR/deploys.log"
REMOTE
  fi
  cat <<REMOTE
    echo "✓ ${version:-the pinned version} is live ($CHAT_DRIVER): '$HEALTH_LINE'"
    exit 0
  fi
  sleep 2
done
REMOTE
  if [[ "$what" == deploy ]]; then
    cat <<REMOTE
printf '%s %s failed\\n' "\$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$version" >> "$REMOTE_DIR/deploys.log"
REMOTE
  fi
  cat <<REMOTE
echo "--- the bot's last lines ---" >&2
docker compose logs --no-log-prefix --tail=30 bot >&2 || true
echo "✗ ${version:-the pinned version} did not report '$HEALTH_LINE' in 90 s${version:+ — recorded as failed in $REMOTE_DIR/deploys.log; deploy the earlier version (deploys.log and docker image ls name the candidates)}" >&2
exit 1
REMOTE
}

cmd_deploy() {
  local version="${1:-}"
  [[ -n "$version" ]] || die "deploy needs a version: vX.Y.Z, or sha-<commit> on a canary (CANARY=1 in deploy.env) — there is no default, the operator names what runs"
  local release
  release="$(version_release "$version")"
  preflight_deployer
  dssh "test -f $REMOTE_DIR/.env" </dev/null || die "no $REMOTE_DIR/.env on the box — run export first"
  dssh "test -f $REMOTE_DIR/compose/compose.yaml" </dev/null || die "no $REMOTE_DIR/compose/compose.yaml on the box — run install first"
  log "Deploying $IMAGE:$version → $DEPLOYER:$REMOTE_DIR (pull → pin → up -d → wait for '$HEALTH_LINE')"
  remote_script deploy "$version" "$release" | dssh bash -s
}

cmd_restart() {
  preflight_deployer
  log "Recreating the containers of $SERVICE_NAME on $DEPLOY_HOST (an edited .env or compose file takes effect)"
  remote_script restart | dssh bash -s
}
cmd_logs()   { local f=""; [[ "${1:-}" == -f ]] && f="-f"; dssh "cd $REMOTE_DIR/compose && docker compose logs --no-log-prefix --tail=100 $f bot"; }
cmd_status() { dssh "cd $REMOTE_DIR/compose && echo '# pinned ($REMOTE_DIR/compose/.env)' && cat .env && echo && docker compose ps && echo && echo '# last deploys ($REMOTE_DIR/deploys.log)' && tail -5 $REMOTE_DIR/deploys.log 2>/dev/null || true"; }
cmd_start()  { preflight_deployer; remote_script restart | dssh bash -s; }
cmd_stop()   { dssh "cd $REMOTE_DIR/compose && docker compose stop" && ok "stopped (docker compose stop; the pin and the images stay)"; }
cmd_down()   { dssh "cd $REMOTE_DIR/compose && docker compose down" && ok "containers removed (docker compose down; the images, the pin and the files stay — deploy <version> brings it back)"; }

# ---- dispatch ---------------------------------------------------------------
need ssh; need scp; need tar
# Slug first: with no overlay named there is nothing to act on — print the help and what exists.
if [[ -z "$SLUG" || ! -f "$ENV_FILE" ]]; then
  usage
  [[ -n "$SLUG" ]] && printf '\n✗ no installation "%s" (infra/%s/deploy.env not found)\n' "$SLUG" "$SLUG" >&2
  printf '\ninstallations under infra/: %s\n' "$(overlays | tr '\n' ' ')" >&2
  exit 1
fi
load_env
case "${2:-}" in
  install)      cmd_install ;;
  export)       cmd_export ;;
  import|pull)  cmd_import ;;
  deploy)       cmd_deploy "${3:-}" ;;
  logs)         cmd_logs "${3:-}" ;;
  status)       cmd_status ;;
  start)        cmd_start ;;
  stop)         cmd_stop ;;
  restart)      cmd_restart ;;
  ssh)          cmd_ssh ;;
  down)         cmd_down ;;
  # no ssh (tests): the compose file as install would render it — uid gid home local|<host> socket-gid [netrc]
  render-compose) render_compose "${3:?uid}" "${4:?gid}" "${5:?home}" "${6:?local or an ssh target}" "${7:-999}" "${8:-}" ;;
  # no ssh (tests): the script `deploy <version>` or `restart` runs on the box; the version check happens here
  remote-script) case "${3:-}" in
                   deploy)  release="$(version_release "${4:?version}")"; remote_script deploy "$4" "$release" ;;
                   restart) remote_script restart ;;
                   *) die "remote-script deploy <version> | restart" ;;
                 esac ;;
  runtime-files) printf 'required %s\noptional %s\ndirs %s\n' "${RUNTIME_FILES[*]}" "${OPTIONAL_RUNTIME_FILES[*]}" "${RUNTIME_DIRS[*]}" ;;   # no ssh: what export/import carry (tests)
  *) usage; exit 1 ;;
esac
