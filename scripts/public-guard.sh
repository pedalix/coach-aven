#!/usr/bin/env bash
# public-guard: fail when a tracked file (or, with --history, any blob in the whole history)
# matches a pattern from scripts/public-guard.txt — the identifiers of our installation,
# customers and people that must not live in this public repo. Product defaults are not
# listed there; keep the list to e-mail domains, ids, IPs and hostnames.
#
#   scripts/public-guard.sh            # tracked files of the current tree (CI runs this)
#   scripts/public-guard.sh --history  # every blob reachable from any ref (before the flip)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIST="$HERE/public-guard.txt"
PATTERNS="$(grep -vE '^\s*(#|$)' "$LIST")"
if [[ "${1:-}" == "--history" ]]; then
  # One pass over every added line of every commit on every ref; the list file itself and
  # this script are the only files allowed to contain the patterns.
  hits="$(git log --all -p --format='commit %h' -- . ':!scripts/public-guard.txt' ':!scripts/public-guard.sh' \
    | grep -nEi -e "$PATTERNS" | grep -E '^[0-9]+:\+' || true)"
else
  hits="$(git ls-files -z \
    | grep -zvE '^scripts/public-guard\.(txt|sh)$' \
    | xargs -0 grep -nEiH -e "$PATTERNS" -- 2>/dev/null || true)"
fi
if [[ -n "$hits" ]]; then
  printf '%s\n' "$hits" | cut -c1-200
  printf '\npublic-guard: %s hit(s) — see scripts/public-guard.txt\n' "$(printf '%s\n' "$hits" | wc -l)" >&2
  exit 1
fi
echo "public-guard: clean"
