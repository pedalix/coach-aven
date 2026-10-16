#!/usr/bin/env bash
# Pull one raw envelope per (kind, subtype) from the prod event journal and print them as
# JSONL on stdout — pipe into scripts/scrub-fixtures.ts to get committable twin fixtures:
#
#   scripts/pull-fixtures.sh | npx tsx scripts/scrub-fixtures.ts
#   scripts/pull-fixtures.sh 2026-09-02 | ...     # only that day's file(s)
#
# Needs the prod journal in FULL mode (AVEN_EVENT_LOG=full — metadata-only lines have no
# `raw` and are skipped). The host comes from the installation's deploy.env, same as
# infra/deploy/deploy.sh: name it with OPS=<slug> (the overlay at infra/<slug>/).
# stdout is UNSCRUBBED — message text, ids, tokens. Never redirect it into the repo.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$HERE/../infra/${OPS:?set OPS=<slug> — the installation (infra/<slug>/deploy.env)}/deploy.env"
[[ -f "$ENV_FILE" ]] || { echo "no $ENV_FILE" >&2; exit 1; }
set -a; # shellcheck disable=SC1090
source "$ENV_FILE"; set +a
: "${DEPLOY_HOST:?}" "${DEPLOY_USER:?}" "${REMOTE_DIR:?}"
GLOB="${1:-2026-*}"

ssh -o BatchMode=yes -o ConnectTimeout=10 "${DEPLOY_USER}@${DEPLOY_HOST}" \
  "cd '$REMOTE_DIR/events' && GLOB='$GLOB' python3 -" <<'PY'
import json, glob, os
seen = set()
# Newest files first, so a fixture reflects the current envelope shape, not last month's.
for f in sorted(glob.glob(os.environ['GLOB'] + '.jsonl'), reverse=True):
    for line in open(f):
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except ValueError:
            continue
        raw = r.get('raw')
        if not raw:
            continue
        sub = r.get('subtype') or (raw.get('view') or {}).get('callback_id') or raw.get('command')
        key = (r.get('kind'), sub)
        if key in seen:
            continue
        seen.add(key)
        print(json.dumps(r))
PY
