#!/usr/bin/env bash
# CoachAven — scripted deploy onto the shared Hetzner VM `aven-prod`.
# Runs as a systemd service (NOT Docker): a single long-lived Node process holding
# a Slack Socket-Mode connection and driving Daytona sandboxes. No nginx, no ports,
# no TLS — Socket Mode dials OUT, so it never touches the shared 80/443.
#
# Usage:  infra/prod/deploy.sh <command>
#
#   install        Root stage: create REMOTE_DIR (deployer-owned), render + install
#                  the systemd unit, daemon-reload, enable (NOT start). Idempotent.
#   export         Upload the gitignored prod-runtime files the app needs at REMOTE_DIR:
#                  .env, github-app-private-key.pem, projects.config.json — read from
#                  infra/prod/runtime/ (SEPARATE from the repo-root local-dev files).
#                  Run once, and again whenever any change. NEVER touches state.json.
#   import         The reverse: download the box's live runtime files into
#                  infra/prod/runtime/ so it mirrors prod. (alias: pull)
#   deploy         Upload the repo (code only), `npm ci` on the server, restart the
#                  service, health-check for the "Slack bot running" log line. The release.
#   logs           Tail the service logs (journalctl -f).
#   status         systemctl status + is-active.
#   start|stop|restart  Service lifecycle.
#   ssh            Interactive SSH session (deployer).
#   down           Stop AND disable the service (leaves files + unit in place).
#
# First run order:  install → export → deploy
# Update code:      deploy
# Rotate secrets:   export → restart
# Sync from box:    import   (pull prod runtime back into infra/prod/runtime/)
#
# Config: infra/prod/.env (copy from .env.example). SSH uses your default keys/
# agent (deployer@HOST and root@HOST must both work). Needs: ssh, scp, tar.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
ENV_FILE="$HERE/.env"
# Prod runtime truth (gitignored). SEPARATE from the repo-root files, which are your
# LOCAL DEV runtime. `export` uploads these to the box; `import` pulls the box's copies
# back down here so this dir always mirrors prod.
RUNTIME_DIR="$HERE/runtime"
# The runtime files the app needs at REMOTE_DIR (uploaded by export, pulled by import).
RUNTIME_FILES=(.env github-app-private-key.pem projects.config.json)
# Optional runtime SUBDIRS, synced recursively when present: projects.d/ holds the
# per-project system prompts (projects.d/<slug>.md — see docs/runtime-config.md).
# Note export copies over (scp, not rsync --delete): a file deleted locally lingers on
# the box, which is harmless — the loader ignores files for unknown slugs.
RUNTIME_DIRS=(projects.d)

log()  { printf '\033[1;36m▶ %s\033[0m\n' "$*" >&2; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*" >&2; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }

load_env() {
  [[ -f "$ENV_FILE" ]] || die "no $ENV_FILE — copy infra/prod/.env.example and fill it in"
  set -a; # shellcheck disable=SC1090
  source "$ENV_FILE"; set +a
  : "${DEPLOY_HOST:?}" "${DEPLOY_USER:?}" "${ROOT_USER:?}" "${REMOTE_DIR:?}" "${SERVICE_NAME:?}"
  DEPLOYER="${DEPLOY_USER}@${DEPLOY_HOST}"
  ROOT="${ROOT_USER}@${DEPLOY_HOST}"
  # Keepalive: `npm ci` on the box runs ~5 min with no output, and an idle SSH session can
  # get dropped by a NAT/firewall in between ("client_loop: send disconnect: Broken pipe"
  # killed the v0.37.0 deploy mid-install, leaving the old process running on new code).
  # A probe every 30s, up to 10 missed, keeps the session alive through the whole install.
  SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10
            -o ServerAliveInterval=30 -o ServerAliveCountMax=10)
}

dssh() { ssh "${SSH_OPTS[@]}" "$DEPLOYER" "$@"; }
rssh() { ssh "${SSH_OPTS[@]}" "$ROOT" "$@"; }

# Day-2 ops (export/import/deploy) only need the deployer; root is required just for
# install (systemd unit + sudoers) and down (disable). Split so a deployer-only caller
# — notably CI, which must NOT hold a root key — can deploy without a root login.
preflight_deployer() {
  dssh "echo ok" </dev/null >/dev/null 2>&1 || die "cannot SSH as $DEPLOYER (need deployer for files + service)"
}
preflight_root() {
  rssh "echo ok" </dev/null >/dev/null 2>&1 || die "cannot SSH as $ROOT (need root for the systemd unit)"
}

# ---- commands ---------------------------------------------------------------
cmd_install() {
  preflight_root
  preflight_deployer
  [[ -f "$HERE/coach-aven.service.tmpl" ]] || die "missing $HERE/coach-aven.service.tmpl"

  log "Root stage: preparing $REMOTE_DIR (owned by $DEPLOY_USER)"
  rssh "mkdir -p $REMOTE_DIR && chown $DEPLOY_USER:$DEPLOY_USER $REMOTE_DIR"

  # Node + systemctl must be stable absolute paths (for the unit + sudoers).
  local node_path systemctl_path
  node_path="$(dssh 'command -v node' </dev/null)" || die "node not found on the box"
  systemctl_path="$(dssh 'command -v systemctl' </dev/null)" || die "systemctl not found on the box"
  [[ -n "$node_path" && -n "$systemctl_path" ]] || die "node/systemctl not found on the box"
  log "Rendering systemd unit (User=$DEPLOY_USER, node=$node_path)"
  local unit
  unit="$(sed -e "s#__USER__#${DEPLOY_USER}#g" \
              -e "s#__REMOTE_DIR__#${REMOTE_DIR}#g" \
              -e "s#__NODE__#${node_path}#g" \
              -e "s#__SERVICE__#${SERVICE_NAME}#g" \
              "$HERE/coach-aven.service.tmpl")"

  log "Root stage: installing /etc/systemd/system/${SERVICE_NAME}.service"
  printf '%s\n' "$unit" | rssh "cat > /etc/systemd/system/${SERVICE_NAME}.service && systemctl daemon-reload && systemctl enable ${SERVICE_NAME}.service"

  # Let the deployer control THIS unit without a password (day-2 start/stop/restart),
  # and read the journal (so `logs` + the deploy health-check work). Both are minimal:
  # the sudoers rule is scoped to the three verbs on this one unit, validated before install.
  log "Root stage: granting deployer service-control (sudoers) + journal read"
  local sudoers
  sudoers="${DEPLOY_USER} ALL=(root) NOPASSWD: ${systemctl_path} start ${SERVICE_NAME}.service, ${systemctl_path} stop ${SERVICE_NAME}.service, ${systemctl_path} restart ${SERVICE_NAME}.service"
  printf '# Managed by coach-aven infra/prod/deploy.sh\n%s\n' "$sudoers" \
    | rssh "cat > /etc/sudoers.d/${SERVICE_NAME}.tmp \
            && visudo -cf /etc/sudoers.d/${SERVICE_NAME}.tmp \
            && install -m 440 -o root -g root /etc/sudoers.d/${SERVICE_NAME}.tmp /etc/sudoers.d/${SERVICE_NAME} \
            && rm -f /etc/sudoers.d/${SERVICE_NAME}.tmp \
            && usermod -aG systemd-journal ${DEPLOY_USER}"
  ok "unit installed + enabled (not started yet — run export, then deploy)"
}

# export: upload the local prod-runtime truth → the box.
cmd_export() {
  preflight_deployer
  local missing=0
  for f in "${RUNTIME_FILES[@]}"; do
    [[ -f "$RUNTIME_DIR/$f" ]] || { warn "missing $RUNTIME_DIR/$f"; missing=1; }
  done
  [[ "$missing" == 0 ]] || die "fill in the prod-runtime files first (cp from .env.example, or run: import)"

  log "Uploading prod runtime ($RUNTIME_DIR) → $DEPLOYER:$REMOTE_DIR"
  dssh "mkdir -p $REMOTE_DIR"
  for f in "${RUNTIME_FILES[@]}"; do
    scp "${SSH_OPTS[@]}" -q "$RUNTIME_DIR/$f" "$DEPLOYER:$REMOTE_DIR/$f"
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
# prod. The reverse of export. state.json is server-owned and deliberately NOT pulled.
cmd_import() {
  preflight_deployer
  mkdir -p "$RUNTIME_DIR"
  log "Downloading prod runtime from $DEPLOYER:$REMOTE_DIR → $RUNTIME_DIR"
  for f in "${RUNTIME_FILES[@]}"; do
    if dssh "test -f $REMOTE_DIR/$f" </dev/null; then
      scp "${SSH_OPTS[@]}" -q "$DEPLOYER:$REMOTE_DIR/$f" "$RUNTIME_DIR/$f"
    else
      warn "no $REMOTE_DIR/$f on the box — skipped"
    fi
  done
  for d in "${RUNTIME_DIRS[@]}"; do
    if dssh "test -d $REMOTE_DIR/$d" </dev/null; then
      dssh "tar -C $REMOTE_DIR -cf - $d" </dev/null | tar -C "$RUNTIME_DIR" -xf -
    fi
  done
  chmod 600 "$RUNTIME_DIR/.env" "$RUNTIME_DIR/github-app-private-key.pem" 2>/dev/null || true
  ok "prod runtime pulled into $RUNTIME_DIR"
}

cmd_deploy() {
  preflight_deployer
  dssh "test -f $REMOTE_DIR/.env" </dev/null \
    || die "no $REMOTE_DIR/.env on the box — run export first"

  log "Uploading repo (code only) to $DEPLOYER:$REMOTE_DIR"
  dssh "mkdir -p $REMOTE_DIR"
  # Ship code + lockfile; NEVER ship runtime secrets, server-owned state, or junk.
  tar czf - -C "$REPO_ROOT" \
    --exclude='./.git' --exclude='./node_modules' --exclude='./.idea' \
    --exclude='./.env' --exclude='./.env.*' \
    --exclude='./github-app-private-key.pem' \
    --exclude='./projects.config.json' \
    --exclude='./state.json' \
    --exclude='./mirrors' \
    --exclude='./memory' \
    --exclude='./feedback' \
    --exclude='./.release' \
    --exclude='./infra/prod/.env' \
    --exclude='./infra/prod/runtime' \
    . \
  | dssh "tar xzf - -C $REMOTE_DIR"

  # Stamp the release (e.g. the git tag from CI) so Sentry can tag issues with the version.
  # Read by config.ts's resolveRelease(); only written when RELEASE is provided.
  if [[ -n "${RELEASE:-}" ]]; then
    log "Stamping release: $RELEASE"
    dssh "printf '%s' '$RELEASE' > $REMOTE_DIR/.release"
  fi

  log "Installing dependencies (npm ci) on the server"
  dssh bash -s <<REMOTE
set -euo pipefail
cd "$REMOTE_DIR"
# dev deps included on purpose — tsx (the TS runtime) is a devDependency.
npm ci
REMOTE

  log "Restarting ${SERVICE_NAME}"
  dssh "sudo systemctl restart ${SERVICE_NAME}.service"

  log "Health check: waiting for the Socket-Mode connection"
  if dssh "for i in \$(seq 1 20); do
             systemctl is-active --quiet ${SERVICE_NAME}.service || exit 2
             journalctl -u ${SERVICE_NAME}.service --since '-60s' --no-pager 2>/dev/null | grep -q 'Slack bot running' && exit 0
             sleep 2
           done; exit 1" </dev/null; then
    ok "CoachAven is live and connected to Slack."
  else
    warn "Service did not report 'Slack bot running' in ~40s — check: infra/prod/deploy.sh logs"
  fi
  dssh "journalctl -u ${SERVICE_NAME}.service --since '-60s' --no-pager 2>/dev/null | tail -12" </dev/null || true
}

cmd_logs()    { dssh "journalctl -u ${SERVICE_NAME}.service -f --no-pager"; }
cmd_status()  { dssh "systemctl status ${SERVICE_NAME}.service --no-pager --lines=10 || true; echo; systemctl is-active ${SERVICE_NAME}.service"; }
cmd_start()   { dssh "sudo systemctl start  ${SERVICE_NAME}.service" && ok "started"; }
cmd_stop()    { dssh "sudo systemctl stop   ${SERVICE_NAME}.service" && ok "stopped"; }
cmd_restart() { dssh "sudo systemctl restart ${SERVICE_NAME}.service" && ok "restarted"; }
cmd_ssh()     { exec ssh "${SSH_OPTS[@]}" "$DEPLOYER"; }
cmd_down() {
  preflight_root
  warn "Stopping and DISABLING ${SERVICE_NAME} (files + unit stay; re-run 'install' to re-enable, then 'start')."
  # disable flips the enablement symlink → needs root (deployer's sudoers covers
  # only start/stop/restart, not disable).
  rssh "systemctl disable --now ${SERVICE_NAME}.service" && ok "service stopped + disabled"
}

# ---- dispatch ---------------------------------------------------------------
need ssh; need scp; need tar
load_env
case "${1:-}" in
  install)      cmd_install ;;
  export)       cmd_export ;;
  import|pull)  cmd_import ;;
  deploy)       cmd_deploy ;;
  logs)         cmd_logs ;;
  status)       cmd_status ;;
  start)        cmd_start ;;
  stop)         cmd_stop ;;
  restart)      cmd_restart ;;
  ssh)          cmd_ssh ;;
  down)         cmd_down ;;
  *) grep -E '^#( |$)' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
