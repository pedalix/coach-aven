#!/usr/bin/env bash
# Mine a project's REAL observability labels from the shared Grafana stack, so an
# accurate scoping systemPrompt can be written WITHOUT guessing. Read-only.
#
# Usage:  scripts/grafana-probe.sh '<loki-selector>' '<prom-metric-prefix>'
#   e.g.  scripts/grafana-probe.sh 'app="holidayshop-dorfberg"' 'holidayshop_'
#
# Token + URL come from infra/prod/runtime/.env (GRAFANA_SERVICE_ACCOUNT_TOKEN);
# base URL defaults to <grafana-host> (override with GRAFANA_URL).
set -uo pipefail

SEL="${1:?usage: grafana-probe.sh '<loki-selector e.g. app=\"slug\">' '<prom-prefix e.g. slug_>'}"
PREFIX="${2:-}"
ENV_FILE="${ENV_FILE:-infra/prod/runtime/.env}"
[[ -f "$ENV_FILE" ]] || { echo "no $ENV_FILE (run: npm run prod:import)" >&2; exit 1; }
set -a; source "$ENV_FILE"; set +a
G="${GRAFANA_URL:-https://<grafana-host>}"
H="Authorization: Bearer ${GRAFANA_SERVICE_ACCOUNT_TOKEN:?missing in $ENV_FILE}"
S=$(( ($(date +%s) - 7*86400) * 1000000000 )); E=$(( $(date +%s) * 1000000000 ))

py(){ python3 -c "$1" 2>/dev/null || true; }
api(){ curl -s -H "$H" "$@"; }
DS="$(api "$G/api/datasources")"

echo "### Selector: {$SEL}   Prefix: ${PREFIX:-—}   (7d window)"
echo "## Datasources"
echo "$DS" | py 'import sys,json
for d in json.load(sys.stdin): print("  %-12s %s" % (d["uid"], d["type"]))'

LUID="$(echo "$DS" | py 'import sys,json
print(next((d["uid"] for d in json.load(sys.stdin) if d["type"]=="loki"), ""))')"
PUID="$(echo "$DS" | py 'import sys,json
print(next((d["uid"] for d in json.load(sys.stdin) if d["type"]=="prometheus"), ""))')"

lval(){ # $1=label  $2=optional selector
  api --get --data-urlencode "start=$S" --data-urlencode "end=$E" \
    ${2:+--data-urlencode "query={$2}"} \
    "$G/api/datasources/proxy/uid/$LUID/loki/api/v1/label/$1/values" \
  | py 'import sys,json; print("  '"$1"':", json.load(sys.stdin).get("data"))'; }

if [[ -n "$LUID" ]]; then
  echo "## Loki (datasource $LUID)"
  echo "  -- discriminator labels (pick the one identifying this project) --"
  for l in app project service_name; do lval "$l"; done
  echo "  -- scoped to {$SEL} --"
  for l in host environment channel level domain tenant_id; do lval "$l" "$SEL"; done
fi

if [[ -n "$PUID" && -n "$PREFIX" ]]; then
  echo "## Prometheus (datasource $PUID)"
  NAMES="$(api "$G/api/datasources/proxy/uid/$PUID/api/v1/label/__name__/values")"
  echo "$NAMES" | py 'import sys,json
ms=[m for m in json.load(sys.stdin)["data"] if m.startswith("'"$PREFIX"'")]
print("  metrics (%d):" % len(ms), ms[:60])'
  M="$(echo "$NAMES" | py 'import sys,json
ms=[m for m in json.load(sys.stdin)["data"] if m.startswith("'"$PREFIX"'") and m.endswith("_total")]
print(ms[0] if ms else "")')"
  if [[ -n "$M" ]]; then
    echo "  -- labels on $M (find the one separating siblings: job/app/instance) --"
    api --get --data-urlencode "match[]=$M" "$G/api/datasources/proxy/uid/$PUID/api/v1/labels" \
      | py 'import sys,json; print("  label names:", json.load(sys.stdin).get("data"))'
    for l in app job instance environment tenant site_id; do
      api --get --data-urlencode "match[]=$M" "$G/api/datasources/proxy/uid/$PUID/api/v1/label/$l/values" \
        | py 'import sys,json
v=json.load(sys.stdin).get("data")
if v: print("  '"$l"':", v)'
    done
    echo "  -- who emits $M (siblings sharing the prefix) --"
    api --get --data-urlencode "query=$M" "$G/api/datasources/proxy/uid/$PUID/api/v1/query" \
      | py 'import sys,json
for d in json.load(sys.stdin)["data"]["result"][:10]: print("   ", d["metric"])'
  fi
elif [[ -n "$PUID" ]]; then
  echo "## Prometheus (datasource $PUID) — pass a metric prefix as arg 2 to inventory metrics"
fi
