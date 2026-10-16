#!/usr/bin/env bash
# public-guard: fail when a tracked file (or, with --history, any blob in the whole history)
# matches a pattern — the public ones in scripts/public-guard.txt plus the operator's PRIVATE
# deny-list (names of installations, customers and people, their ids and hosts), which never
# lives in this repo: pass it as PUBLIC_GUARD_PATTERNS (newline-separated patterns, CI's secret)
# or PUBLIC_GUARD_LIST (a file). LICENSE and NOTICE name the copyright holder and are not scanned.
#
# Gzipped files are read decompressed (`gzip -dc`): grep sees only compressed bytes and
# `git log -p` only "Binary files … differ", and a committed fixture such as
# src/lab/fixtures/bench-agency/plan.rendered.jsonl.gz is megabytes of model-written text.
#
#   scripts/public-guard.sh            # tracked files of the current tree (CI runs this)
#   scripts/public-guard.sh --history  # every blob reachable from any ref (before a visibility flip)
#
# PUBLIC_GUARD_REQUIRE_PRIVATE=1 fails when no private list is given (CI on main and tags), so a
# missing secret can never pass as "clean".
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
strip() { grep -vE '^\s*(#|$)' || true; }
PATTERNS="$(strip < "$HERE/public-guard.txt")"
PRIVATE=""
if [[ -n "${PUBLIC_GUARD_PATTERNS:-}" ]]; then PRIVATE="$(printf '%s\n' "$PUBLIC_GUARD_PATTERNS" | strip)"
elif [[ -n "${PUBLIC_GUARD_LIST:-}" ]]; then PRIVATE="$(strip < "$PUBLIC_GUARD_LIST")"; fi
if [[ -z "$PRIVATE" ]]; then
  if [[ "${PUBLIC_GUARD_REQUIRE_PRIVATE:-}" == "1" ]]; then
    echo "public-guard: no private deny-list (PUBLIC_GUARD_PATTERNS / PUBLIC_GUARD_LIST) — refusing to call this clean" >&2
    exit 2
  fi
  echo "public-guard: public patterns only (no private deny-list given)" >&2
else
  PATTERNS="$(printf '%s\n%s\n' "$PATTERNS" "$PRIVATE" | sed '/^$/d')"
fi
if [[ -z "$PATTERNS" ]]; then echo "public-guard: no patterns to check"; exit 0; fi
SKIP='^(LICENSE|NOTICE|scripts/public-guard\.(txt|sh))$'
# Hits inside one gzip stream on stdin, as `<label>:<line>:<text>` (grep -nH's shape for a plain file).
gz_hits() { gzip -dc 2>/dev/null | grep -nEi -e "$PATTERNS" | sed "s|^|$1:|" || true; }
if [[ "${1:-}" == "--history" ]]; then
  # One pass over every added line of every commit on every ref, and every commit/tag message.
  hits="$(git log --all -p --format='commit %h%n%B' -- . ':!LICENSE' ':!NOTICE' ':!scripts/public-guard.txt' ':!scripts/public-guard.sh' \
    | grep -nEi -e "$PATTERNS" | grep -vE '^[0-9]+:-' || true)"
  # Every gzipped blob of every ref, once per blob (labelled <path>@<blob>).
  gz="$(git rev-list --all --objects | awk '{ sha = $1; sub(/^[^ ]+ ?/, "") } /\.gz$/ { print sha, $0 }' | sort -u -k1,1 \
    | while read -r blob path; do git cat-file blob "$blob" | gz_hits "$path@${blob:0:12}"; done)"
else
  hits="$(git ls-files -z \
    | grep -zvE "$SKIP" \
    | xargs -0 grep -nEiH -e "$PATTERNS" -- 2>/dev/null || true)"
  gz="$(git ls-files -z -- '*.gz' | while IFS= read -r -d '' f; do gz_hits "$f" < "$f"; done)"
fi
hits="$(printf '%s\n%s\n' "$hits" "$gz" | sed '/^$/d')"
if [[ -n "$hits" ]]; then
  # The private list must not leak through the log either: name file and line, never the text.
  printf '%s\n' "$hits" | cut -d: -f1,2
  printf '\npublic-guard: %s hit(s)\n' "$(printf '%s\n' "$hits" | wc -l)" >&2
  exit 1
fi
echo "public-guard: clean"
