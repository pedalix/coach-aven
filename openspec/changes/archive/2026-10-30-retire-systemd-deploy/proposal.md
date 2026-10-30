# Proposal

## Why

Every installation we operate runs the published image under Docker Compose since 2026-10-30 (OpenSpec `container-deploy`, archived), and the old code is gone from the boxes. The systemd path — the unit templates, the tar deploy with `npm ci` on the box, the `.release` marker and the `scripts/mirror.ts` crontab caller — is still the tooling's **default** when an overlay names no runtime, renders a unit nobody installs, and doubles the commands, the tests and the manual. `container-deploy` promised to retire it in a later change once the last installation moved; that is now.

## What Changes

- **BREAKING for operators still on systemd:** `deploy.sh` has one runtime. `RUNTIME` is retired: an overlay without the key is a compose installation; a leftover `RUNTIME=compose` is accepted; `RUNTIME=systemd` is refused with a sentence naming the last release that carried the path (v0.43.0) and the move checklist. The tar deploy, the unit render, the systemd `install`/`deploy`/`logs`/`status`/`start`/`stop`/`restart`/`down` variants and the `render-unit` subcommand go.
- The unit templates leave the repository: the bot's, the sources daemon's and the per-slug `sources serve` unit. The nginx snippet for `serve` stays — it is about TLS, not systemd.
- `.release` goes: the Sentry release comes from `SENTRY_RELEASE` alone (the compose file sets it from the pinned version). The code anchors no file beside itself any more; the guard test loses its one exception.
- `scripts/mirror.ts` goes: `orch mirror` from the image is the one mirror job (the crontab line of `container-deploy`).
- Docs: `infra/deploy/README.md` describes one runtime; the move checklist stays, shortened, for an installation on the systemd deploy of v0.43.0 or earlier; the ops template, the deploy workflow's header, `docs/runtime-config.md`, `docs/sources.md`, `docs/local-dev.md` follow. The compose ledger row's default date is set and `RUNTIME` joins *Retired*.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `ops-overlay`: the overlay names no runtime (the key is retired, a leftover is checked), and the chat driver is rendered into the compose file, not a unit.
- `container-deploy`: the move checklist is for an installation of an earlier version; there is no way back to systemd within this version.
- `installation-directory`: nothing is located through the code — the `.release` exception goes.
- `release-deploy-split`: the ops deploy workflow runs the one deploy command; no systemd sequence.

## Impact

- **Rollout bucket: 1** (tooling and docs; the one runtime change — the Sentry release without the file fallback — is inert on compose installations, which set `SENTRY_RELEASE`, and no systemd installation exists). No flag: a removal. Ledger: the compose row's *Default since* and a *Retired* row for `RUNTIME`.
- Operators of a fork still on the systemd deploy: move with the checklist using v0.43.0's tooling, then upgrade.
- Out of scope: hardening the deployer's Docker access, `orch sources serve` as a compose service, registry retention, the home installation's hand-written compose file.
