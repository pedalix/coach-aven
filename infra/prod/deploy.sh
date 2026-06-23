#!/usr/bin/env bash
# CoachAven — scripted deploy onto the shared Hetzner VM `lumora-one`.
# Runs as a systemd service (NOT Docker): a single long-lived Node process holding
# a Slack Socket-Mode connection and driving Daytona sandboxes. No nginx, no ports,
# no TLS — Socket Mode dials OUT, so it never touches the shared 80/443.
#
# Usage:  infra/prod/deploy.sh <command>
#
#   install        Root stage: create REMOTE_DIR (deployer-owned), render + install
#                  the systemd unit, daemon-reload, enable (NOT start). Idempotent.
#   push-secrets   Upload the gitignored runtime files the app needs at REMOTE_DIR:
#                  .env, github-app-private-key.pem, projects.config.json. Run once,
#                  and again whenever any of them change. NEVER touches state.json.
#   deploy         Upload the repo (code only), `npm ci` on the server, restart the
#                  service, health-check for the "Slack bot running" log line. The release.
#   logs           Tail the service logs (journalctl -f).
#   status         systemctl status + is-active.
#   start|stop|restart  Service lifecycle.
#   ssh            Interactive SSH session (deployer).
#   down           Stop AND disable the service (leaves files + unit in place).
#
# First run order:  install → push-secrets → deploy
# Update code:      deploy
# Rotate secrets:   push-secrets → restart
#
# Config: infra/prod/.env (copy from .env.example). SSH uses your default keys/
# agent (deployer@HOST and root@HOST must both work). Needs: ssh, scp, tar.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
ENV_FILE="$HERE/.env"

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
  SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)
}

dssh() { ssh "${SSH_OPTS[@]}" "$DEPLOYER" "$@"; }
rssh() { ssh "${SSH_OPTS[@]}" "$ROOT" "$@"; }

preflight_ssh() {
  rssh "echo ok" </dev/null >/dev/null 2>&1 || die "cannot SSH as $ROOT (need root for the systemd unit)"
  dssh "echo ok" </dev/null >/dev/null 2>&1 || die "cannot SSH as $DEPLOYER (need deployer for files + service)"
}

# ---- commands ---------------------------------------------------------------
cmd_install() {
  preflight_ssh
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
  ok "unit installed + enabled (not started yet — run push-secrets, then deploy)"
}

cmd_push_secrets() {
  preflight_ssh
  local missing=0
  for f in .env github-app-private-key.pem projects.config.json; do
    [[ -f "$REPO_ROOT/$f" ]] || { warn "missing $REPO_ROOT/$f"; missing=1; }
  done
  [[ "$missing" == 0 ]] || die "fill in the runtime files at the repo root first"

  log "Uploading runtime secrets/config to $DEPLOYER:$REMOTE_DIR"
  dssh "mkdir -p $REMOTE_DIR"
  scp "${SSH_OPTS[@]}" -q "$REPO_ROOT/.env"                       "$DEPLOYER:$REMOTE_DIR/.env"
  scp "${SSH_OPTS[@]}" -q "$REPO_ROOT/github-app-private-key.pem" "$DEPLOYER:$REMOTE_DIR/github-app-private-key.pem"
  scp "${SSH_OPTS[@]}" -q "$REPO_ROOT/projects.config.json"       "$DEPLOYER:$REMOTE_DIR/projects.config.json"
  dssh "chmod 600 $REMOTE_DIR/.env $REMOTE_DIR/github-app-private-key.pem"
  ok "secrets in place (state.json left untouched)"
}

cmd_deploy() {
  preflight_ssh
  dssh "test -f $REMOTE_DIR/.env" </dev/null \
    || die "no $REMOTE_DIR/.env on the box — run push-secrets first"

  log "Uploading repo (code only) to $DEPLOYER:$REMOTE_DIR"
  dssh "mkdir -p $REMOTE_DIR"
  # Ship code + lockfile; NEVER ship runtime secrets, server-owned state, or junk.
  tar czf - -C "$REPO_ROOT" \
    --exclude='./.git' --exclude='./node_modules' --exclude='./.idea' \
    --exclude='./.env' --exclude='./.env.*' \
    --exclude='./github-app-private-key.pem' \
    --exclude='./projects.config.json' \
    --exclude='./state.json' \
    --exclude='./infra/prod/.env' \
    . \
  | dssh "tar xzf - -C $REMOTE_DIR"

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
  preflight_ssh
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
  push-secrets) cmd_push_secrets ;;
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
