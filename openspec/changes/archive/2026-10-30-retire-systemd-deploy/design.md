# Design

## Context

`deploy.sh` dispatches every command on `RUNTIME` (`is_compose`), with the systemd variants first and the compose variants suffixed `_compose`. The tests pin the unit render byte for byte (`render-unit`) and the compose render and box script through `render-compose` / `remote-script`. `.release` is read by the Sentry release resolver as a fallback and whitelisted by the installation-directory guard test; `scripts/mirror.ts` is a thin caller of `runMirror()` pinned by a test. See proposal.md — Why.

## Goals / Non-Goals

**Goals:** one runtime in the script, the tests and the manual; a leftover `RUNTIME` line cannot mislead; nothing of the code's own location leaks into runtime behaviour.

**Non-Goals:** changing the compose runtime's behaviour (the rendered file, the box script, the version rules stay byte for byte); the home installation's hand-written compose file; hardening.

## Decisions

- **D1. `systemd` is refused, not ignored.** An operator who writes `RUNTIME=systemd` believes the box runs a unit; silently deploying compose over it would start a second bot on the same ports. The refusal names the last release with the path (v0.43.0) and the checklist. `RUNTIME=compose` is accepted so the overlays of the installations that moved need no edit. Alternative — warn and continue — rejected: a deploy must not guess.
- **D2. The unit-active check stays in the box script.** It is one `systemctl is-active` and it is what makes the move from an earlier version safe (the compose deploy refuses while the old unit runs). It is part of the move, not of the systemd path.
- **D3. The suffixed functions take the plain names.** `cmd_deploy_compose` → `cmd_deploy` and so on; the dispatch loses its branches. The three no-ssh subcommands for the tests (`render-compose`, `remote-script`, `runtime-files`) are unchanged.
- **D4. `SENTRY_RELEASE` alone.** The compose file sets it from `AVEN_RELEASE`; a run without it reports no release, as a local run does today. Alternative — keep the file fallback "just in case" — rejected: it is the one place the code located a file beside itself, and the guard test had to carve it out.
- **D5. The checklist survives, the way back does not.** An installation on v0.43.0's systemd deploy stops and disables its units by hand, runs `install`, `deploy <version>`, the crontab line and the cleanup list. The paragraph on going back is replaced by one sentence: v0.43.0 is the last release with the systemd path.

## Risks / Trade-offs

- An operator on a fork still deploying with systemd is cut off at this version → the refusal says what to do, and v0.43.0's tooling remains in the tag.
- A box with a unit still enabled from the old path → unchanged: the compose deploy refuses until it is disabled (D2).
